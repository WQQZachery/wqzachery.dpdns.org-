// Local, disposable test environment for destructive tests: the real Worker (dist/) in workerd via Miniflare,
// a real SQLite Durable Object (fresh temp dir every start), local rate limits, a fake Workers AI binding and a fake
// Hugging Face / S3 / CDN (all outbound fetches are rerouted to an in-process fake). Nothing reaches production.
//
//   bash tools/build_worker.sh && node tools/local_env.mjs            # worker on :8787, fake HF on :8790
//   env: PORT, FAKE_PORT, UP_DAY_FILES, UP_DAY_BYTES, UP_MAX_FILE, AI_DAILY_CAP, MULTIPART_MIN (bytes, default 8 MiB)
// Admin key for the run is written to work/.local_admin_key (gitignored). Fake HF control: GET :8790/__state, POST :8790/__reset,
// GET :8790/__violations (HF token seen on a non-HF host, or HF API called without the token → listed here).
// S3/CDN hosts for test clients: http://127.0.0.1:8790/s3/<path>, /cdn/<path> (tools rewrite the https URLs to these).
import http from 'http'; import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto';
import { fileURLToPath } from 'url';
// Miniflare 4 API (the miniflare bundled with this wrangler is a 5.x beta with a different config format):
//   npm i --prefix /tmp/mf4 miniflare@4   (with a package.json there), then MINIFLARE=/tmp/mf4/node_modules/miniflare/dist/src/index.js
const { Miniflare } = await import(process.env.MINIFLARE || 'miniflare');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.env.PORT || 8787), FAKE = +(process.env.FAKE_PORT || 8790);
const HF_TOKEN = 'hf_local_fake_' + crypto.randomBytes(6).toString('hex');
const ADMIN_KEY = 'local-admin-' + crypto.randomBytes(12).toString('hex');
const REPO = 'wqzachery/drive', CHUNK = +(process.env.MULTIPART_MIN || 8 * 1048576);
const S3H = 'hf-hub-lfs-us-east-1.s3-accelerate.amazonaws.com';   // the host real HF hands out (seen 2026-10-18)
fs.mkdirSync(path.join(ROOT, 'work'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'work', '.local_admin_key'), ADMIN_KEY + '\n', { mode: 0o600 });

/* ---------------- fake Hugging Face (git-LFS batch, multipart, verify, commit, tree, resolve) + S3 + CDN ---------------- */
let ST;
const reset = () => { ST = { objects: new Map(), parts: new Map(), uploads: new Map(), files: new Map(), commits: 0, violations: [], log: [] }; };
reset();
const readBody = req => new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
const send = (res, code, obj, headers = {}) => { const b = Buffer.isBuffer(obj) ? obj : Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)); res.writeHead(code, { 'content-type': 'application/json', 'content-length': b.length, ...headers }); res.end(b); };
const now = () => new Date().toISOString();

const fake = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname, body = await readBody(req);
  const auth = req.headers['authorization'] || '', orig = req.headers['x-orig-host'] || '';
  ST.log.push(`${req.method} ${orig || '-'} ${p}`); if (ST.log.length > 500) ST.log.shift();
  if (p === '/__reset') { reset(); return send(res, 200, { ok: true }); }
  if (p === '/__state') return send(res, 200, { files: [...ST.files.entries()].map(([k, v]) => ({ path: k, ...v, content: undefined })), objects: ST.objects.size, commits: ST.commits, uploads: ST.uploads.size });
  if (p === '/__violations') return send(res, 200, ST.violations);
  if (p === '/__log') return send(res, 200, ST.log);
  if (p.startsWith('/s3/') || p.startsWith('/cdn/')) {
    if (auth.includes(HF_TOKEN)) ST.violations.push(`HF token sent to ${p.split('/')[1]}: ${req.method} ${p}`);
  } else if (p.startsWith('/hf/')) {
    if (!auth.includes(HF_TOKEN) && !p.includes('/info/lfs/objects/verify')) ST.violations.push(`HF API without token: ${req.method} ${p}`);
  }
  // --- S3: basic upload (PUT whole object) or one multipart part
  if (p.startsWith('/s3/')) {
    if (req.method !== 'PUT') return send(res, 405, '');
    const oid = p.split('/').pop(), pn = u.searchParams.get('partNumber'), up = u.searchParams.get('uploadId');
    const etag = '"' + crypto.createHash('md5').update(body).digest('hex') + '"';
    if (pn) { ST.parts.set(`${up}:${pn}`, { data: body, etag }); }
    else {
      if (crypto.createHash('sha256').update(body).digest('hex') !== oid) return send(res, 400, '<Error>sha mismatch</Error>');
      ST.objects.set(oid, body);
    }
    return send(res, 200, '', { etag });
  }
  // --- CDN download (Range supported)
  if (p.startsWith('/cdn/')) {
    const oid = p.split('/').pop(), obj = ST.objects.get(oid);
    if (!obj) return send(res, 404, '');
    const rg = (req.headers['range'] || '').match(/bytes=(\d+)-(\d*)/);
    if (rg) { const a = +rg[1], b = rg[2] ? Math.min(+rg[2], obj.length - 1) : obj.length - 1; return send(res, 206, obj.subarray(a, b + 1), { 'content-type': 'application/octet-stream', 'content-range': `bytes ${a}-${b}/${obj.length}`, 'accept-ranges': 'bytes' }); }
    return send(res, 200, obj, { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes' });
  }
  if (!p.startsWith('/hf/')) return send(res, 404, { error: 'not reachable in local env' });
  const hp = p.slice(3);
  // --- git-LFS batch
  if (hp === `/datasets/${REPO}.git/info/lfs/objects/batch`) {
    const b = JSON.parse(body.toString()), o = b.objects[0];
    if (b.operation === 'download') {
      if (!ST.objects.has(o.oid)) return send(res, 200, { objects: [{ ...o, error: { code: 404, message: 'not found' } }] });
      return send(res, 200, { objects: [{ ...o, actions: { download: { href: `https://cdn-lfs.hf.co/repos/x/${o.oid}`, header: {} } } }] });
    }
    const verify = { href: `https://huggingface.co/datasets/${REPO}.git/info/lfs/objects/verify`, header: { Authorization: 'Basic ' + Buffer.from('lfs:verify-' + o.oid.slice(0, 8)).toString('base64') } };
    if (ST.objects.has(o.oid)) return send(res, 200, { objects: [{ ...o }] });   // already stored → no actions
    if (o.size > CHUNK) {
      const up = crypto.randomBytes(8).toString('hex'), n = Math.ceil(o.size / CHUNK), header = { chunk_size: String(CHUNK) };
      for (let i = 1; i <= n; i++) header[String(i)] = `https://${S3H}/repos/x/${o.oid}?partNumber=${i}&uploadId=${up}&X-Amz-Signature=s${i}`;
      ST.uploads.set(up, { oid: o.oid, size: o.size, n });
      return send(res, 200, { objects: [{ ...o, actions: { upload: { href: `https://huggingface.co/api/complete_multipart?uploadId=${up}&oid=${o.oid}`, header }, verify } }] });
    }
    return send(res, 200, { objects: [{ ...o, actions: { upload: { href: `https://${S3H}/repos/x/${o.oid}?X-Amz-Signature=basic`, header: { 'Content-Type': 'application/octet-stream' } }, verify } }] });
  }
  if (hp === '/api/complete_multipart') {
    const up = u.searchParams.get('uploadId'), U = ST.uploads.get(up); if (!U) return send(res, 404, { error: 'no upload' });
    const b = JSON.parse(body.toString()); if (!Array.isArray(b.parts) || b.parts.length !== U.n) return send(res, 400, { error: 'parts' });
    const bufs = [];
    for (const x of b.parts) { const pt = ST.parts.get(`${up}:${x.partNumber}`); if (!pt || pt.etag !== x.etag) return send(res, 400, { error: 'etag mismatch part ' + x.partNumber }); bufs.push(pt.data); }
    const all = Buffer.concat(bufs);
    if (all.length !== U.size || crypto.createHash('sha256').update(all).digest('hex') !== U.oid) return send(res, 400, { error: 'sha/size mismatch' });
    ST.objects.set(U.oid, all); ST.uploads.delete(up); return send(res, 200, {});
  }
  if (hp === `/datasets/${REPO}.git/info/lfs/objects/verify`) {
    const b = JSON.parse(body.toString()), obj = ST.objects.get(b.oid);
    if (!/^Basic /.test(auth) && !auth.includes(HF_TOKEN)) return send(res, 401, { message: 'auth' });
    return obj && obj.length === b.size ? send(res, 200, {}) : send(res, 404, { message: 'object missing' });
  }
  if (hp === `/api/datasets/${REPO}/commit/main`) {
    const lines = body.toString().trim().split('\n').map(l => JSON.parse(l)), next = new Map(ST.files);
    for (const { key, value: v } of lines) {
      if (key === 'header') continue;
      if (key === 'lfsFile') { if (!ST.objects.has(v.oid)) return send(res, 400, { error: 'lfs object missing ' + v.oid }); next.set(v.path, { oid: v.oid, size: v.size, lfs: true, date: now() }); }
      else if (key === 'file') { const c = Buffer.from(v.content, 'base64'); next.set(v.path, { size: c.length, lfs: false, date: now() }); }
      else if (key === 'deletedFile') { if (!next.has(v.path)) return send(res, 404, { error: 'no such file ' + v.path }); next.delete(v.path); }
      else if (key === 'deletedFolder') { for (const k of [...next.keys()]) if (k.startsWith(v.path + '/')) next.delete(k); }
      else return send(res, 400, { error: 'bad op ' + key });
    }
    ST.files = next; ST.commits++; return send(res, 200, { commitOid: crypto.randomBytes(20).toString('hex') });
  }
  const tm = hp.match(new RegExp(`^/api/datasets/${REPO}/tree/main/(files(?:/.*)?)$`));
  if (tm) {
    const pre = decodeURIComponent(tm[1]), out = [], dirs = new Set();
    for (const [k, v] of ST.files) if (k.startsWith(pre + '/')) {
      out.push({ type: 'file', path: k, size: v.size, ...(v.lfs ? { lfs: { oid: v.oid, size: v.size } } : {}), lastCommit: { date: v.date } });
      const parts = k.split('/'); for (let i = 2; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }
    if (!out.length) return send(res, 404, { error: 'Entry not found' });
    for (const d of dirs) if (d.startsWith(pre + '/')) out.push({ type: 'directory', path: d });
    return send(res, 200, out);
  }
  const rm = hp.match(new RegExp(`^/datasets/${REPO}/resolve/main/(.+)$`));
  if (rm) {
    const f = ST.files.get(decodeURIComponent(rm[1]).split('/').map(decodeURIComponent).join('/')) || ST.files.get(decodeURIComponent(rm[1]));
    if (!f || !f.lfs) return send(res, 404, { error: 'Entry not found' });
    return send(res, 302, '', { location: `https://cdn-lfs.hf.co/repos/x/${f.oid}?sig=local` });
  }
  return send(res, 404, { error: 'fake hf: unknown ' + hp });
});
await new Promise(r => fake.listen(FAKE, '127.0.0.1', r));

/* ---------------- Worker in workerd ---------------- */
const route = url => {
  const x = new URL(url);
  if (x.hostname === 'huggingface.co') return `http://127.0.0.1:${FAKE}/hf${x.pathname}${x.search}`;
  if (/^hf-hub-lfs-[a-z0-9-]+\.s3[a-z0-9.-]*\.amazonaws\.com$/.test(x.hostname)) return `http://127.0.0.1:${FAKE}/s3${x.pathname}${x.search}`;
  if (x.hostname === 'cdn-lfs.hf.co') return `http://127.0.0.1:${FAKE}/cdn${x.pathname}${x.search}`;
  return `http://127.0.0.1:${FAKE}/other/${x.hostname}${x.pathname}`;
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wqz-local-'));
const DIST = path.join(ROOT, 'dist');
const FAKE_AI = `export default function () { return { async run(model, opts) {
  const last = (opts.messages || []).filter(m => m.role === 'user').pop()?.content || '';
  if (/__AI_FAIL__/.test(last)) throw new Error('fake AI failure');
  const slow = /\\u957f\\u57ce/.test(last), words = slow ? Array.from({ length: 40 }, (_, i) => '\\u957f\\u57ce' + i + '\\u3002') : ['\\u597d'];   // escapes: inline script source must stay ASCII
  const enc = new TextEncoder();
  return new ReadableStream({ async start(c) {
    if (/gpt-oss/.test(model)) c.enqueue(enc.encode('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: '想一想' } }] }) + '\\n\\n'));
    for (const w of words) { c.enqueue(enc.encode('data: ' + JSON.stringify({ response: w }) + '\\n\\n')); if (slow) await new Promise(r => setTimeout(r, 100)); }
    c.enqueue(enc.encode('data: [DONE]\\n\\n')); c.close(); } });
} }; }`;
const main = {
  name: 'wqzachery',
  modules: true, scriptPath: path.join(DIST, 'worker.js'), modulesRoot: DIST,
  modulesRules: [{ type: 'Text', include: ['**/*.html', '**/*.css', 'shared.js', 'announcements.json'], fallthrough: false }, { type: 'Data', include: ['**/*.png'], fallthrough: false }],
  compatibilityDate: '2026-10-01',
  durableObjects: { STORE: { className: 'Store', useSQLite: true } },
  ratelimits: { CHAT_RL: { namespace_id: '7101', simple: { limit: 15, period: 60 } }, UP_RL: { namespace_id: '7102', simple: { limit: 30, period: 60 } } },
  bindings: {
    HF_TOKEN, ADMIN_KEY, HF_REPO: REPO, CAP_LABEL: '100 GB', GEMINI_MODELS: '',
    AI_MODELS: '@cf/openai/gpt-oss-120b,@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    AI_DAILY_CAP: process.env.AI_DAILY_CAP || '200', UP_MAX_FILE: process.env.UP_MAX_FILE || '2147483648',
    UP_DAY_BYTES: process.env.UP_DAY_BYTES || '5368709120', UP_DAY_FILES: process.env.UP_DAY_FILES || '50',
  },
  wrappedBindings: { AI: { scriptName: 'fake-ai' } },
  outboundService: async req => {
    const to = route(req.url), h = new Headers(req.headers); h.set('x-orig-host', new URL(req.url).hostname);
    const init = { method: req.method, headers: h, redirect: 'manual' };
    if (!['GET', 'HEAD'].includes(req.method)) init.body = Buffer.from(await req.arrayBuffer());
    return fetch(to, init);
  },
};
const mf2 = new Miniflare({ log: undefined,
  port: PORT, host: '127.0.0.1', durableObjectsPersist: path.join(tmp, 'do'),
  workers: [main, { name: 'fake-ai', modules: true, script: FAKE_AI }],
});
await mf2.ready;
console.log(`local env ready: worker http://127.0.0.1:${PORT}  fake HF http://127.0.0.1:${FAKE}  (DO data in ${tmp}, admin key in work/.local_admin_key)`);
const stop = async () => { await mf2.dispose().catch(() => {}); fake.close(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
