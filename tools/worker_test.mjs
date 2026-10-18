// Request-level tests for worker/worker.js with stubbed fetch / Durable Object / bindings (no network, no secrets, no production).
// Usage: node tools/worker_test.mjs
// Covers: upload trust boundary (/api/up/init, /api/up/finish, /api/up/part), bounded JSON bodies (/api/chat + others),
// assistant identity copy (F). Each test prints PASS/FAIL; exit code 1 on any failure.
import fs from 'fs'; import vm from 'vm'; import path from 'path'; import { fileURLToPath } from 'url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let src = fs.readFileSync(path.join(root, 'worker/worker.js'), 'utf8')
  .replace(/^import (\w+) from .*$/gm, (_, n) => `const ${n} = '';`)
  .replace(/^import \{ DurableObject \} from .*$/m, 'class DurableObject { constructor(){} }')
  .replace('export default {', 'const __default = {').replace('export class Store', 'class Store');
src += '\n;globalThis.W = { worker: __default, SYS, LLMS };';

let ok = 0, bad = 0; const t = (n, c, i = '') => { if (c) { ok++; console.log('PASS', n) } else { bad++; console.log('FAIL', n, i) } };

/* ---------- fakes ---------- */
const CALLS = [];                       // every outbound fetch the worker makes: { url, method, headers, redirect }
let ROUTES = [];                        // [predicate(url, init) → Response | Promise<Response>]
const fakeFetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const h = new Headers(init.headers || {});
  CALLS.push({ url, method: init.method || 'GET', auth: h.get('authorization'), redirect: init.redirect, body: init.body });
  for (const r of ROUTES) { const v = await r(url, init); if (v) return v; }
  return new Response('{"error":"unrouted"}', { status: 599 });
};
const DB = new Map();   // upq rows by path
const store = {
  authLocked: async () => false, authFail: async () => true, logUp: async () => true, hit: async () => true,
  aiBegin: async () => 'cap', aiEnd: async () => true, report: async () => ({ ok: true }),
  upReserve: async (p, ip, day, oid, size) => { DB.set(p, { path: p, ip, oid, size, done: 0, ts: Date.now(), plan: null }); return { ok: true, n: 0, bytes: 0 }; },
  upPending: async p => DB.has(p) ? { ...DB.get(p) } : null,
  upSetPlan: async (p, plan) => { const r = DB.get(p); if (r && r.done === 0) r.plan = JSON.stringify(plan); return true; },
  upClaim: async p => { const r = DB.get(p); if (r && r.done === 0) { r.done = 2; return true; } return false; },
  upRelease: async p => { const r = DB.get(p); if (r && r.done === 2) r.done = 0; return true; },
  upDone: async p => { const r = DB.get(p); if (r) { r.done = 1; r.plan = null; } return true; },
  upDrop: async p => { DB.delete(p); return true; },
};
const env = {
  HF_TOKEN: 'hf_SECRET_TEST', HF_REPO: 'wqzachery/drive', AI_DAILY_CAP: '200',
  STORE: { idFromName: () => 'id', get: () => store },
  UP_RL: { limit: async () => ({ success: true }) }, CHAT_RL: { limit: async () => ({ success: true }) },
  AI: { run: async () => { throw new Error('no AI in tests'); } },
};
const ctx = { waitUntil: p => { p && p.catch && p.catch(() => {}); } };
const sandbox = vm.createContext({ TextEncoder, TextDecoder, crypto: globalThis.crypto, URL, URLSearchParams, Response, Request, Headers, ReadableStream, TransformStream, AbortSignal, atob, btoa, console, setTimeout, clearTimeout, fetch: fakeFetch, WebSocketRequestResponsePair: class {} });
vm.runInContext(src, sandbox);
const { worker, SYS, LLMS } = sandbox.W;
const call = (p, init = {}) => worker.fetch(new Request('https://wqzachery.dpdns.org' + p, { duplex: 'half', ...init, headers: { 'cf-connecting-ip': '203.0.113.7', ...(init.headers || {}) } }), env, ctx);
const post = (p, body, headers = {}) => call(p, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });

/* ---------- HF fakes for the upload flow ---------- */
const OID = 'a'.repeat(64), OID2 = 'b'.repeat(64), SIZE = 10;
const S3 = n => `https://hf-hub-lfs-us-1.s3.us-east-1.amazonaws.com/repos/x/${OID}?partNumber=${n}&X-Amz-Signature=sig${n}`;
const COMPLETE = `https://huggingface.co/api/complete_multipart?uploadId=U1&bucket=b&prefix=p&expiration=e&signature=s`;
const VERIFY = 'https://huggingface.co/datasets/wqzachery/drive.git/info/lfs/objects/verify';
let hfUpload = () => ({ href: COMPLETE, header: { chunk_size: '5', 1: S3(1), 2: S3(2) } });
let commitStatus = 200, completeDelay = 0;
const J = (o, s = 200, h = {}) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', ...h } });
ROUTES = [
  (u, i) => u.endsWith('/info/lfs/objects/batch') && JSON.parse(i.body).operation === 'upload' && J({ objects: [{ oid: OID, size: SIZE, actions: { upload: hfUpload(), verify: { href: VERIFY, header: { 'X-Verify': 'v' } } } }] }),
  (u, i) => u.endsWith('/info/lfs/objects/batch') && JSON.parse(i.body).operation === 'download' && J({ objects: [{ actions: { download: { href: 'https://cdn-lfs.hf.co/obj', header: {} } } }] }),
  u => u === 'https://cdn-lfs.hf.co/obj' && new Response('hello text', { status: 206, headers: { 'content-range': `bytes 0-9/${SIZE}` } }),
  async u => { if (u.startsWith('https://huggingface.co/api/complete_multipart')) { if (completeDelay) await new Promise(r => setTimeout(r, completeDelay)); return J({}); } },
  u => u === VERIFY && J({}),
  u => u.endsWith('/commit/main') && J({ ok: commitStatus === 200 }, commitStatus),
  u => u.startsWith('https://hf-hub-lfs-') && new Response('', { status: 200, headers: { etag: '"e1"' } }),
];
const init = async (oid = OID) => { const r = await post('/api/up/init', { name: 'note.txt', size: SIZE, oid }); return { r, j: await r.json() }; };
const parts = [{ partNumber: 1, etag: '"e1"' }, { partNumber: 2, etag: '"e2"' }];

/* ===== A. upload trust boundary ===== */
{
  const { r, j } = await init();
  t('init ok, multipart plan', r.status === 200 && j.mode === 'multipart' && j.parts.length === 2, JSON.stringify(j));
  t('init does not hand HF complete/verify URLs (or their headers) to the browser', !('complete' in j) && !('verify' in j) && !JSON.stringify(j).includes('huggingface.co/api'), JSON.stringify(j));
  t('init never returns the HF token', !JSON.stringify(j).includes('hf_SECRET_TEST'));

  // attacker-controlled URLs in finish are ignored; only the init-saved ones are called, without following redirects
  CALLS.length = 0;
  const f = await post('/api/up/finish', { path: j.path, oid: OID, size: SIZE, parts, complete: 'https://evil.example/steal', verify: { href: 'https://huggingface.co/api/whoami-v2', header: { Authorization: 'x' } } });
  const fj = await f.json();
  t('finish succeeds using the saved plan', f.status === 200 && fj.ok, f.status + ' ' + JSON.stringify(fj));
  t('client complete URL never fetched', !CALLS.some(c => c.url.includes('evil.example')));
  t('client verify URL never fetched', !CALLS.some(c => c.url.includes('whoami')));
  t('saved complete + verify URLs used', CALLS.some(c => c.url === COMPLETE) && CALLS.some(c => c.url === VERIFY));
  t('HF token only ever sent to huggingface.co', CALLS.filter(c => c.auth && c.auth.includes('hf_SECRET_TEST')).every(c => new URL(c.url).hostname === 'huggingface.co'), JSON.stringify(CALLS.map(c => [c.url, !!c.auth])));
  t('token-bearing calls do not follow redirects', CALLS.filter(c => c.url === COMPLETE || c.url === VERIFY).every(c => c.redirect === 'manual'));
  t('client verify header cannot override our Authorization', CALLS.filter(c => c.url === VERIFY).every(c => c.auth === 'Bearer hf_SECRET_TEST'));

  const again = await post('/api/up/finish', { path: j.path, oid: OID, size: SIZE, parts });
  t('repeated finish after commit → 409, nothing re-committed', again.status === 409);
}
{
  hfUpload = () => ({ href: 'https://evil.example/api/complete_multipart', header: { chunk_size: '5', 1: S3(1) } });
  const { r } = await init();
  t('init rejects a non-HF complete URL from upstream (502), session dropped', r.status === 502 && ![...DB.values()].some(x => x.done === 0 && !x.plan));
  hfUpload = () => ({ href: COMPLETE, header: { chunk_size: '5', 1: 'http://hf-hub-lfs-us-1.s3.amazonaws.com/x' } });
  t('init rejects non-https / off-list part URLs', (await init()).r.status === 502);
  hfUpload = () => ({ href: 'https://huggingface.co:8443/api/complete_multipart', header: { chunk_size: '5', 1: S3(1) } });
  t('init rejects HF URL with explicit port', (await init()).r.status === 502);
  hfUpload = () => ({ href: COMPLETE, header: { chunk_size: '5', 1: S3(1), 2: S3(2) } });
}
{
  const { j } = await init();
  t('finish with wrong part count → 400', (await post('/api/up/finish', { path: j.path, oid: OID, size: SIZE, parts: parts.slice(0, 1) })).status === 400);
  t('finish with bad etag → 400', (await post('/api/up/finish', { path: j.path, oid: OID, size: SIZE, parts: [{ partNumber: 1, etag: '"a"' }, { partNumber: 2, etag: '<x>' }] })).status === 400);
  t('cross-session: other oid on this path → 400', (await post('/api/up/finish', { path: j.path, oid: OID2, size: SIZE, parts })).status === 400);
  t('unknown path → 400', (await post('/api/up/finish', { path: 'files/20261018-zzzzzz-x.txt', oid: OID, size: SIZE, parts })).status === 400);
  // a failed commit releases the claim so the visitor can retry
  commitStatus = 500;
  const f1 = await post('/api/up/finish', { path: j.path, oid: OID, size: SIZE, parts });
  commitStatus = 200;
  const f2 = await post('/api/up/finish', { path: j.path, oid: OID, size: SIZE, parts });
  t('failed commit → 502, then retry succeeds (claim released)', f1.status === 502 && f2.status === 200, f1.status + ' ' + f2.status);
}
{
  const { j } = await init();
  DB.get(j.path).ts = Date.now() - 7 * 3600e3;
  t('expired session (>6 h) → 400', (await post('/api/up/finish', { path: j.path, oid: OID, size: SIZE, parts })).status === 400);
}
{
  const { j } = await init();
  completeDelay = 50;
  const [a, b] = await Promise.all([post('/api/up/finish', { path: j.path, oid: OID, size: SIZE, parts }), post('/api/up/finish', { path: j.path, oid: OID, size: SIZE, parts })]);
  completeDelay = 0;
  const st = [a.status, b.status].sort();
  t('concurrent finishes: exactly one commits, the other gets 409', st[0] === 200 && st[1] === 409, st.join(','));
}
{
  const { j } = await init();
  const put = (target, up = j.path) => call('/api/up/part', { method: 'PUT', body: 'hello', headers: { 'x-target': target, 'x-up': up, 'content-length': '5' } });
  CALLS.length = 0;
  t('relay: presigned URL of this session forwarded', (await put(S3(1))).status === 200 && CALLS.some(c => c.url === S3(1) && c.redirect === 'manual'));
  t('relay: S3-looking URL not from this session → 400', (await put('https://hf-hub-lfs-us-1.s3.us-east-1.amazonaws.com/other?partNumber=1')).status === 400);
  t('relay: non-S3 host → 400', (await put('https://evil.example/x')).status === 400);
  t('relay: unknown session → 400', (await put(S3(1), 'files/20261018-qqqqqq-n.txt')).status === 400);
  // the page URI-encodes x-up (header values must be ASCII); a Chinese file name must still find its session
  const { j: jz } = await (async () => { const r = await post('/api/up/init', { name: '中文 名字.txt', size: SIZE, oid: OID }); return { j: await r.json() }; })();
  t('relay: URI-encoded non-ASCII x-up accepted', (await put(S3(1), encodeURIComponent(jz.path))).status === 200, jz.path);
  t('relay: malformed x-up encoding → 400', (await put(S3(1), '%E4%B8')).status === 400);
}

/* ===== D. bounded JSON bodies ===== */
const goodChat = { sid: 's1', messages: [{ role: 'user', content: '你好' }] };
{
  const r = await post('/api/chat', goodChat); const j = await r.json();
  t('normal chat request passes validation (reaches the daily-cap gate)', r.status === 429 && j.code === 'cap', r.status + JSON.stringify(j));
  t('declared huge Content-Length → 413 before reading', (await post('/api/chat', goodChat, { 'content-length': String(50 * 1048576) })).status === 413);
  const big = JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(600 * 1024) }] });
  const stream = () => new ReadableStream({ start(c) { const e = new TextEncoder().encode(big); for (let i = 0; i < e.length; i += 65536) c.enqueue(e.slice(i, i + 65536)); c.close(); } });
  t('no Content-Length, streamed 600 KB → 413', (await call('/api/chat', { method: 'POST', body: stream(), headers: { 'content-type': 'application/json' } })).status === 413);
  let forged; try { forged = await call('/api/chat', { method: 'POST', body: stream(), headers: { 'content-type': 'application/json', 'content-length': '20' } }); } catch { forged = null; }
  t('forged small Content-Length with 600 KB body → 413 (or rejected by runtime)', !forged || forged.status === 413, forged && forged.status);
  t('invalid JSON → 400', (await post('/api/chat', '{"messages": [')).status === 400);
  t('JSON array body → 400', (await post('/api/chat', '[1,2]')).status === 400);
  t('messages not an array → 400', (await post('/api/chat', { messages: 'hi' })).status === 400);
  t('content not a string → 400', (await post('/api/chat', { messages: [{ role: 'user', content: 123 }] })).status === 400);
  t('bad role → 400', (await post('/api/chat', { messages: [{ role: 'system', content: 'x' }] })).status === 400);
  t('65 messages → 400', (await post('/api/chat', { messages: Array.from({ length: 65 }, () => ({ role: 'user', content: 'x' })) })).status === 400);
  t('content > 100k chars → 400', (await post('/api/chat', { messages: [{ role: 'user', content: 'x'.repeat(100001) }] })).status === 400);
  t('web not boolean → 400', (await post('/api/chat', { ...goodChat, web: 'yes' })).status === 400);
  const hist = { messages: Array.from({ length: 16 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: '长'.repeat(4000) })).concat([{ role: 'user', content: '问' }]) };
  t('16 × 4000-char Chinese history (what the page sends) still accepted', (await post('/api/chat', hist)).status === 429);
  t('other JSON endpoints capped too (/api/report 100 KB → 413)', (await post('/api/report', { path: 'files/a.txt', reason: '其他', note: 'x'.repeat(100 * 1024) })).status === 413);
  t('other JSON endpoints: invalid JSON → 400', (await post('/api/report', 'nope')).status === 400);
}

/* ===== security headers ===== */
{
  const pg = await call('/p/home'), api = await call('/api/nope'), nf = await call('/no-such-page');
  const has = (r, k, v) => (r.headers.get(k) || '').includes(v);
  for (const [n, r] of [['page', pg], ['api', api], ['404', nf]]) t(`${n}: nosniff + Referrer-Policy + Permissions-Policy`, has(r, 'x-content-type-options', 'nosniff') && has(r, 'referrer-policy', 'strict-origin') && has(r, 'permissions-policy', 'camera=()'));
  t('pages: frame-ancestors self + X-Frame-Options', has(pg, 'content-security-policy', "frame-ancestors 'self'") && has(pg, 'x-frame-options', 'SAMEORIGIN') && has(nf, 'content-security-policy', "frame-ancestors 'self'"));
  t('pages: CSP does not restrict inline scripts (not yet tested for that)', !has(pg, 'content-security-policy', 'script-src'));
}

/* ===== G. locked owner folder files/wq + owner IPs shown as 我 ===== */
{
  env.ADMIN_KEY = 'adm_TEST_KEY';
  const OWN = new Set(); let fails = 0;
  Object.assign(store, {
    ups: async () => [{ path: 'files/wq/20261017-aaaaaa-me.jpg', ip: '198.51.100.9' }, { path: 'files/20261017-bbbbbb-pub.jpg', ip: '203.0.113.50' }],
    owners: async () => ['198.51.100.9', ...OWN], ownerAdd: async a => { OWN.add(a); return true; },
    authFail: async () => { fails++; return true; },
    stats: async () => ({ recent: [{ ip: '198.51.100.9', path: '/' }, { ip: '203.0.113.50', path: '/' }], uploads: [{ ip: '198.51.100.9', name: 'me.jpg' }] }),
  });
  const TREE = [{ type: 'directory', path: 'files/wq' }, { type: 'file', path: 'files/wq/20261017-aaaaaa-me.jpg', size: 5 }, { type: 'directory', path: 'files/wq/sub' }, { type: 'file', path: 'files/wq/sub/20261017-cccccc-deep.txt', size: 3 },
    { type: 'file', path: 'files/20261017-bbbbbb-pub.jpg', size: 7 }];
  ROUTES.unshift(u => u.includes('/tree/main/files?recursive') && J(TREE), u => u.includes('/resolve/main/files/') && new Response('IMG', { status: 200, headers: { 'content-type': 'image/jpeg' } }));
  const list = async (h = {}) => (await call('/api/files', { headers: h })).json();
  let L = await list();
  t('locked: visitor list hides files inside wq (incl. subfolders)', L.files.length === 1 && L.files[0].path === 'files/20261017-bbbbbb-pub.jpg', JSON.stringify(L.files.map(f => f.path)));
  t('locked: visitor still sees the wq folder itself, not its subfolders', L.folders.includes('wq') && !L.folders.includes('wq/sub') && L.unlocked === false && L.locked.includes('wq'));
  const enc = encodeURIComponent;
  for (const op of ['raw', 'url', 'dl', 'view']) t(`locked: visitor GET /api/files/${op} in wq → 403`, (await call(`/api/files/${op}/` + enc('files/wq/20261017-aaaaaa-me.jpg'))).status === 403);
  t('locked: deep path also 403', (await call('/api/files/raw/' + enc('files/wq/sub/20261017-cccccc-deep.txt'))).status === 403);
  t('locked: public file still readable', (await call('/api/files/raw/' + enc('files/20261017-bbbbbb-pub.jpg'))).status === 200);
  t('locked: visitor upload into wq → 403', (await post('/api/up/init', { name: 'x.txt', size: 3, oid: 'c'.repeat(64), dir: 'wq' })).status === 403);
  t('locked: visitor upload into wq/sub → 403', (await post('/api/up/init', { name: 'x.txt', size: 3, oid: 'c'.repeat(64), dir: 'wq/sub' })).status === 403);
  t('locked: visitor mkdir inside wq → 403', (await post('/api/folders', { path: 'wq/new' })).status === 403);
  t('locked: report on a wq file → 400', (await post('/api/report', { path: 'files/wq/20261017-aaaaaa-me.jpg', reason: '其他' })).status === 400);
  t('locked: folder named wqx is not locked', (await call('/api/files/raw/' + enc('files/wqx/20261017-dddddd-a.jpg'))).status === 200);
  // wrong password
  const bad = await post('/api/lock/open', { key: 'nope' });
  t('unlock: wrong password → 403, counted as a failed attempt, no cookie', bad.status === 403 && fails === 1 && !bad.headers.get('set-cookie'));
  // right password
  const good = await post('/api/lock/open', { key: 'adm_TEST_KEY' }, { 'cf-connecting-ip': '2001:db8::77' });
  const sc = good.headers.get('set-cookie') || '';
  t('unlock: right password → cookie HttpOnly Secure SameSite=Strict', good.status === 200 && /HttpOnly/.test(sc) && /Secure/.test(sc) && /SameSite=Strict/.test(sc) && /^wqu=\d+\.[A-Za-z0-9_-]{43};/.test(sc), sc);
  t('unlock: cookie never contains the key', !sc.includes('adm_TEST_KEY'));
  t('unlock: unlocking IP is remembered as the owner', OWN.has('2001:db8::77'));
  const ck = { cookie: sc.split(';')[0] };
  L = await list(ck);
  t('unlocked: list shows wq files + subfolder', L.unlocked === true && L.files.length === 3 && L.folders.includes('wq/sub'));
  t('unlocked: owner files are tagged 我 (mine) even from a new IP', L.files.filter(f => f.path.startsWith('files/wq/20261017-aaaaaa')).every(f => f.mine && f.owner));
  t('unlocked: raw readable', (await call('/api/files/raw/' + enc('files/wq/20261017-aaaaaa-me.jpg'), { headers: ck })).status === 200);
  const [v, sg] = ck.cookie.slice(4).split('.');
  t('forged cookie (bad signature) → still locked', (await call('/api/files/raw/' + enc('files/wq/20261017-aaaaaa-me.jpg'), { headers: { cookie: `wqu=${v}.${'A'.repeat(43)}` } })).status === 403);
  t('forged cookie (extended expiry, old signature) → still locked', (await call('/api/files/raw/' + enc('files/wq/20261017-aaaaaa-me.jpg'), { headers: { cookie: `wqu=${+v + 1000}.${sg}` } })).status === 403);
  const cl = await post('/api/lock/close', {});
  t('relock: clears the cookie', /Max-Age=0/.test(cl.headers.get('set-cookie') || ''));
  // admin
  const A = { 'x-admin-key': 'adm_TEST_KEY', 'cf-connecting-ip': '192.0.2.200' };
  L = await list(A);
  t('admin: sees wq, owner IP shown as 我, others keep their IP', L.files.length === 3 && L.files.find(f => f.path.includes('me.jpg')).ip === '我' && L.files.find(f => f.path.includes('pub.jpg')).ip === '203.0.113.50');
  const st = await (await call('/api/admin/stats', { headers: A })).json();
  t('admin stats: owner visits/uploads shown as 我', st.recent[0].ip === '我' && st.recent[0].me === true && st.uploads[0].ip === '我' && st.recent[1].ip === '203.0.113.50');
  t('admin key use via scripts does not register an owner IP', !OWN.has('192.0.2.200'));
}

/* ===== F. assistant identity copy ===== */
{
  const ai = fs.readFileSync(path.join(root, 'site/ai.html'), 'utf8');
  t('system prompt no longer orders the model to deny what it is', !/一律回答你是/.test(SYS) && !/不要提及 Llama/.test(SYS));
  t('system prompt says Astra is a site name, not an OpenAI model, and may switch models', /不是 OpenAI/.test(SYS) && /自动换用/.test(SYS));
  t('system prompt names no backend model', !/Llama|GPT-OSS|Qwen|DeepSeek|Gemini|Nemotron/i.test(SYS));
  t('AI page states Astra is the site\'s name, not an OpenAI product', ai.includes('非 OpenAI 产品') && ai.includes('可能自动切换'));
  t('llms.txt clarifies the name', LLMS.includes('不是 OpenAI 的产品'));
}

console.log(`${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
