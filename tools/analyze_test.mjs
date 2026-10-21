// Request-level tests for the chat-room 「聊天分析」 endpoint (POST /api/chat/analyze) in worker/worker.js.
// The real Store class runs on an in-memory SQLite (node:sqlite) so the DO queries (message lookup, DM access, daily caps) are exercised for real;
// Workers AI (Clef-flash + the chat models) is a scripted fake. No network, no secrets, no production.
// Usage: node tools/analyze_test.mjs   (also run at the end of tools/worker_test.mjs)
import fs from 'fs'; import vm from 'vm'; import path from 'path'; import { fileURLToPath } from 'url';
process.removeAllListeners('warning');   // node:sqlite prints an ExperimentalWarning
const { DatabaseSync } = await import('node:sqlite');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let src = fs.readFileSync(path.join(root, 'worker/worker.js'), 'utf8')
  .replace(/^import (\w+) from .*$/gm, (_, n) => `const ${n} = '';`)
  .replace(/^import \{ DurableObject \} from .*$/m, 'class DurableObject { constructor(){} }')
  .replace('export default {', 'const __default = {').replace('export class Store', 'class Store');
src += '\n;globalThis.W = { worker: __default, Store, ANA, ANA_Q, scrubPII, cnDay, chatUid };';

let ok = 0, bad = 0; const t = (n, c, i = '') => { if (c) { ok++; console.log('PASS', n) } else { bad++; console.log('FAIL', n, i) } };

/* ---------- SQLite shim with the Durable Object sql.exec() surface ---------- */
const db = new DatabaseSync(':memory:');
const cursor = (rows, w) => ({ toArray: () => rows, one: () => { if (rows.length !== 1) throw new Error('one(): ' + rows.length + ' rows'); return rows[0]; }, rowsWritten: w });
const sql = { exec(q, ...args) {
  if (!args.length && q.split(';').filter(x => x.trim()).length > 1) { db.exec(q); return cursor([], 0); }
  const st = db.prepare(q);
  if (/^\s*(SELECT|WITH)\b/i.test(q) || /\bRETURNING\b/i.test(q)) return cursor(st.all(...args), 0);
  return cursor([], st.run(...args).changes);
} };

/* ---------- fake Workers AI ---------- */
const AI_CALLS = [];
const okClef = () => ({ model: 'clef-flash', usage: { input_tokens: 300, output_tokens: 5 }, answers: {
  intent: { type: 'choice', choice: 'question', confidence: 0.8, probabilities: { question: 0.72, joke: 0.05, complaint: 0.03, help: 0.15, thanks: 0.02, unsure: 0.03 } },
  friendly: { type: 'score', score: 3.1, confidence: 0.7, legend: { 0: 'a', 1: 'b', 2: 'c', 3: 'd', 4: 'e' }, probabilities: { 0: 0.02, 1: 0.03, 2: 0.15, 3: 0.6, 4: 0.2 } },
  sentiment: { type: 'choice', choice: 'neutral', confidence: 0.6, probabilities: { positive: 0.3, neutral: 0.6, negative: 0.1 } },
  style: { type: 'choice', choice: 'direct', confidence: 0.3, probabilities: { direct: 0.35, indirect: 0.25, teasing: 0.2, formal: 0.2 } },
  ambiguous: { type: 'noul', noul: 0.2 } } });
let clefImpl = async () => okClef();
const GEN_OK = '{"reason":"以问号结尾，看起来像在提问；但只有一句话，也可能只是随口一问。","replies":[{"tone":"友好","text":"我知道一点，可以跟你说说～"},{"tone":"简洁","text":"可以。"},{"tone":"礼貌澄清","text":"你是想问哪一部分呢？"}]}';
let genImpl = async () => GEN_OK;
const sseOf = text => { const e = new TextEncoder(); return new ReadableStream({ start(c) { for (let i = 0; i < text.length; i += 9) c.enqueue(e.encode('data: ' + JSON.stringify({ response: text.slice(i, i + 9) }) + '\n\n')); c.enqueue(e.encode('data: [DONE]\n\n')); c.close(); } }); };
const AI = { run: async (model, opts) => {
  AI_CALLS.push({ model, opts });
  if (model === '@cf/cloudflare/clef-flash') return clefImpl(opts);
  const out = await genImpl(model, opts);
  return out instanceof ReadableStream ? out : sseOf(out);
} };

/* ---------- worker in a vm, console captured (logs must never carry content / IPs / keys) ---------- */
const LOGS = [];
const cap = (...a) => LOGS.push(a.map(x => { try { return typeof x === 'string' ? x : JSON.stringify(x) ?? String(x); } catch { return String(x); } }).join(' '));
const fakeConsole = { log: cap, error: cap, warn: cap, info: cap, debug: cap };
const env = { AI_MODELS: '@cf/openai/gpt-oss-120b,@cf/meta/llama-3.3-70b-instruct-fp8-fast', AI_DAILY_CAP: '200', ADMIN_KEY: 'adm_TEST_KEY', AI,
  UP_RL: { limit: async () => ({ success: true }) }, CHAT_RL: { limit: async () => ({ success: !rlBlocked }) } };
let rlBlocked = false;
const sandbox = vm.createContext({ TextEncoder, TextDecoder, crypto: globalThis.crypto, URL, URLSearchParams, Response, Request, Headers, ReadableStream, TransformStream, AbortSignal, atob, btoa, console: fakeConsole, setTimeout, clearTimeout,
  fetch: async () => new Response('', { status: 599 }), WebSocketRequestResponsePair: class {} });
vm.runInContext(src, sandbox);
const { worker, Store, ANA, ANA_Q, scrubPII, cnDay, chatUid } = sandbox.W;
const store = new Store({ storage: { sql }, setWebSocketAutoResponse() {} }, env);
store.sql = sql;
env.STORE = { idFromName: () => 'id', get: () => store };
const ctx = { waitUntil: p => { p && p.catch && p.catch(() => {}); } };
const IP = '203.0.113.7';
const call = (body, headers = {}, ipAddr = IP) => worker.fetch(new Request('https://wqzachery.dpdns.org/api/chat/analyze', { method: 'POST', duplex: 'half', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', 'cf-connecting-ip': ipAddr, ...headers } }), env, ctx);
const go = async (body, h, ipAddr) => { const r = await call(body, h, ipAddr); let j = null; try { j = await r.json(); } catch {} return { s: r.status, j }; };

/* ---------- seed chat rows (as the chat room would store them) ---------- */
const keyA = 'A'.repeat(24), keyB = 'B'.repeat(24), keyC = 'C'.repeat(24);
const uA = await chatUid(keyA), uB = await chatUid(keyB), uC = await chatUid(keyC);
const ins = (uid, nick, text, to = '', toNick = '') => { const dm = to ? (uid < to ? uid + ':' + to : to + ':' + uid) : ''; return Number(db.prepare('INSERT INTO chat(uid,nick,to_uid,to_nick,dm,text,ts,ip) VALUES(?,?,?,?,?,?,?,?) RETURNING id').get(uid, nick, to, toNick, dm, text, Date.now(), '198.51.100.23').id); };
const p1 = ins(uB, '秘密昵称甲', '最早的一条，不该进上下文');
const p2 = ins(uC, '秘密昵称乙', '第二条 ' + '长'.repeat(700));
const dmSecret = ins(uA, '秘密昵称丙', '私信内容绝密XYZ', uB, '秘密昵称甲');
const p3 = ins(uA, '秘密昵称丙', '我的手机 13812345678，邮箱 me@example.com');
const p4 = ins(uB, '秘密昵称甲', '第四条：见 https://x.example/cb?token=abcDEF123456&lang=zh');
const target = ins(uC, '秘密昵称乙', '请问这个网盘怎么上传文件？我的身份证 11010519491231002X，IP 10.0.0.8');
const dmTarget = ins(uB, '秘密昵称甲', '在吗？想问你个事', uA, '秘密昵称丙');
const emptyMsg = ins(uA, '秘密昵称丙', '   ');

/* ===== 1. normal analysis ===== */
{
  AI_CALLS.length = 0;
  const { s, j } = await go({ id: target, key: keyA });
  t('normal: 200 ok', s === 200 && j && j.ok === true, s + ' ' + JSON.stringify(j));
  t('normal: intent is wording, not a number', j.intent.label === '提问' && j.intent.level === '较可能' && !('probabilities' in j.intent) && !/\d%/.test(JSON.stringify(j)));
  t('normal: alternative intent listed (help 0.15 < 0.2 → none; check shape)', Array.isArray(j.intent.alts));
  t('normal: tone has friendly / sentiment / style with levels', j.tone.friendly.label === '比较友好' && j.tone.sentiment.label === '中性' && j.tone.style.label === '直接' && j.tone.style.level === '不确定');
  t('normal: uncertainty spelled out (style unsure + limited context)', j.uncertainty.some(x => x.includes('表达方式')) && j.uncertainty.some(x => x.includes('最多 3 条')));
  t('normal: 3 reply ideas with tones 友好/简洁/礼貌澄清', j.replies.length === 3 && j.replies.map(r => r.tone).join() === '友好,简洁,礼貌澄清' && j.suggest === 'ok');
  t('normal: reason from the chat wrapper', j.reason.includes('看起来像在提问'));
  t('normal: note says 模型推测，仅供参考', j.note === '模型推测，仅供参考');
  t('normal: no backend model name in the response', !/clef|gpt-oss|llama|@cf\//i.test(JSON.stringify(j)));
  const clef = AI_CALLS.find(c => c.model === '@cf/cloudflare/clef-flash');
  t('clef: called with model "clef-flash", string state, typed questions', clef && clef.opts.model === 'clef-flash' && typeof clef.opts.state === 'string' && Object.keys(clef.opts.questions).length >= 1 && Object.keys(clef.opts.questions).length <= 64);
  t('clef: intent = choice with the 6 options', clef.opts.questions.intent.type === 'choice' && Object.keys(clef.opts.questions.intent.criteria).join() === 'question,joke,complaint,help,thanks,unsure');
  t('clef: friendly = score (ordered criteria list)', clef.opts.questions.friendly.type === 'score' && Array.isArray(clef.opts.questions.friendly.criteria));
  const st = clef.opts.state;
  t('context: target + only the 3 previous public messages', st.includes('请问这个网盘') && st.includes('第四条') && st.includes('我的手机') && st.includes('第二条') && !st.includes('最早的一条'));
  t('context: DM rows never mixed into public context', !st.includes('绝密XYZ'));
  t('context: each message capped at 500 chars', !st.includes('长'.repeat(501)) && st.includes('长'.repeat(400)));
  t('context: nicknames never sent (labels instead)', !/秘密昵称/.test(st) && st.includes('目标发送者'));
  t('pii: phone / email / id card / IP / URL token replaced before sending', !/13812345678|me@example\.com|11010519491231002X|10\.0\.0\.8|abcDEF123456/.test(st) && st.includes('[手机号]') && st.includes('[邮箱]') && st.includes('[身份证号]') && st.includes('[IP]') && st.includes('token=[令牌]'), st);
  const gen = AI_CALLS.find(c => c.model !== '@cf/cloudflare/clef-flash');
  t('generation: reuses the site chat wrapper (AI_MODELS first model, Astra system prompt)', gen && gen.model === '@cf/openai/gpt-oss-120b' && gen.opts.messages[0].role === 'system' && gen.opts.messages[0].content.includes('GPT-6 Astra'));
  t('generation: prompt carries no raw PII either', !/13812345678|me@example\.com|11010519491231002X|10\.0\.0\.8|abcDEF123456/.test(JSON.stringify(gen.opts.messages)));
}
/* ===== 2. bad input / missing message / DM access ===== */
{
  let r = await go({});
  t('no id → 400 empty', r.s === 400 && r.j.code === 'empty');
  r = await go({ id: '' }); t('empty id → 400 empty', r.s === 400 && r.j.code === 'empty');
  r = await go({ id: 'abc' }); t('string id → 400 bad_id', r.s === 400 && r.j.code === 'bad_id');
  r = await go({ id: -3 }); t('negative id → 400 bad_id', r.s === 400 && r.j.code === 'bad_id');
  r = await go({ id: 1.5 }); t('fractional id → 400 bad_id', r.s === 400 && r.j.code === 'bad_id');
  r = await go({ id: 999999 }); t('unknown message → 404 not_found', r.s === 404 && r.j.code === 'not_found');
  r = await go({ id: target, key: 'short' }); t('malformed chat key → 400 bad_key', r.s === 400 && r.j.code === 'bad_key');
  r = await go({ id: target, text: '客户端传的任意文本' }); t('client text is ignored (server reads by id)', r.s === 200 && !AI_CALLS.some(c => JSON.stringify(c.opts).includes('客户端传的任意文本')));
  r = await go({ id: emptyMsg }); t('whitespace-only message → 400 empty', r.s === 400 && r.j.code === 'empty');
  r = await go({ id: dmTarget }); t('DM without key → 404 (no leak)', r.s === 404 && r.j.code === 'not_found');
  r = await go({ id: dmTarget, key: keyC }); t('DM by an outsider → 404', r.s === 404);
  AI_CALLS.length = 0;
  r = await go({ id: dmTarget, key: keyA }); t('DM by a participant → 200', r.s === 200 && r.j.ok);
  const st = (AI_CALLS.find(c => c.model.includes('clef')) || { opts: { state: '' } }).opts.state;
  t('DM context = earlier messages of that DM only', st.includes('绝密XYZ') && !st.includes('第四条'));
  r = await go('{"id":'); t('invalid JSON → 400', r.s === 400);
  r = await go({ id: target, pad: 'x'.repeat(5000) }); t('oversized body → 413', r.s === 413);
  r = await worker.fetch(new Request('https://wqzachery.dpdns.org/api/chat/analyze', { headers: { 'cf-connecting-ip': IP } }), env, ctx);
  t('GET → 404 (POST only)', r.status === 404);
}
/* ===== 3. malformed Clef output → clef_bad_format, quota refunded ===== */
{
  const used = () => (db.prepare("SELECT n FROM ana_use WHERE k='*' AND day=?").get(cnDay(Date.now())) || { n: 0 }).n;
  const mut = f => async () => { const r = okClef(); f(r); return r; };
  const cases = [
    ['string instead of object', async () => 'intent: question'],
    ['null', async () => null],
    ['answers missing', mut(r => { delete r.answers; })],
    ['answers is an array', mut(r => { r.answers = []; })],
    ['one answer missing', mut(r => { delete r.answers.style; })],
    ['type mismatch', mut(r => { r.answers.intent.type = 'score'; })],
    ['choice not among options', mut(r => { r.answers.intent.choice = 'love'; })],
    ['unknown probability key', mut(r => { r.answers.sentiment.probabilities.hate = 0; })],
    ['probability > 1', mut(r => { r.answers.sentiment.probabilities.neutral = 1.6; })],
    ['probabilities do not sum to 1', mut(r => { r.answers.intent.probabilities = { question: 0.2, joke: 0.1 }; })],
    ['NaN confidence', mut(r => { r.answers.intent.confidence = NaN; })],
    ['score out of range', mut(r => { r.answers.friendly.score = 9; })],
    ['score not a number', mut(r => { r.answers.friendly.score = '3'; })],
    ['noul out of range', mut(r => { r.answers.ambiguous.noul = -0.5; })],
    ['choice missing confidence', mut(r => { delete r.answers.style.confidence; })],
  ];
  for (const [n, impl] of cases) {
    clefImpl = impl; const before = used();
    const r = await go({ id: target });
    t('bad format: ' + n + ' → 502 clef_bad_format, quota refunded', r.s === 502 && r.j.code === 'clef_bad_format' && r.j.ok === false && used() === before, r.s + ' ' + JSON.stringify(r.j) + ' used ' + before + '→' + used());
  }
  clefImpl = async () => ({ result: okClef() });
  t('REST-style {result:{answers}} wrapper accepted', (await go({ id: target })).s === 200);
  clefImpl = async () => okClef();
}
/* ===== 4. Clef failure / timeout; generation failure ===== */
{
  clefImpl = async () => { throw new Error('3040: capacity'); };
  let r = await go({ id: target });
  t('clef throws → 503 clef_failed', r.s === 503 && r.j.code === 'clef_failed' && !r.j.error.includes('3040'));
  const old = ANA.clefMs; ANA.clefMs = 150;
  clefImpl = () => new Promise(res => setTimeout(() => res(okClef()), 1000));
  const t0 = Date.now(); r = await go({ id: target });
  t('clef hangs → 504 clef_timeout within the timeout', r.s === 504 && r.j.code === 'clef_timeout' && Date.now() - t0 < 900, r.s + ' ' + (Date.now() - t0) + 'ms');
  ANA.clefMs = old; clefImpl = async () => okClef();

  genImpl = async () => { throw new Error('all models down'); };
  r = await go({ id: target });
  t('generation throws → 200 with classification, suggest failed + 建议生成失败', r.s === 200 && r.j.ok && r.j.intent.label && r.j.suggest === 'failed' && r.j.suggestError === '建议生成失败' && r.j.replies.length === 0);
  t('generation failed → fallback reason still says it is a guess', /模型推测/.test(r.j.reason));
  genImpl = async () => '我觉得这是在提问。';
  r = await go({ id: target }); t('generation returns non-JSON → suggest failed', r.s === 200 && r.j.suggest === 'failed');
  genImpl = async () => '{"reason":"x","replies":[{"tone":"友好","text":"只有一条"}]}';
  r = await go({ id: target }); t('generation returns < 2 replies → suggest failed', r.j.suggest === 'failed');
  const og = ANA.genMs; ANA.genMs = 150;
  genImpl = async () => new ReadableStream({ start(c) { setTimeout(() => { try { c.enqueue(new TextEncoder().encode('data: {"response":"{}"}\n\n')); c.close(); } catch {} }, 1000); } });
  const t1 = Date.now(); r = await go({ id: target });
  t('generation timeout → classification returned, suggest failed, fast', r.s === 200 && r.j.suggest === 'failed' && Date.now() - t1 < 900, Date.now() - t1 + 'ms');
  ANA.genMs = og; genImpl = async () => GEN_OK;
  genImpl = async () => '```json\n' + GEN_OK + '\n```';
  r = await go({ id: target }); t('generation in a ```json fence still parsed', r.j.suggest === 'ok' && r.j.replies.length === 3);
  genImpl = async () => GEN_OK;
}
/* ===== 5. rate limits: per IP, whole site (China day), CHAT_RL, admin ===== */
{
  db.exec('DELETE FROM ana_use');
  env.CHAT_ANA_IP_DAILY = '3'; env.CHAT_ANA_DAILY = '5';
  const ipA = '198.51.100.1', ipB = '198.51.100.2', ipC = '198.51.100.3';
  const rs = []; for (let i = 0; i < 4; i++) rs.push(await go({ id: target }, {}, ipA));
  t('per-IP cap (CHAT_ANA_IP_DAILY=3): 3 ok then 429 ip_cap', rs.slice(0, 3).every(r => r.s === 200) && rs[3].s === 429 && rs[3].j.code === 'ip_cap' && rs[3].j.error.includes('每天 3 次'), rs.map(r => r.s).join());
  t('remaining count returned (2,1,0)', rs.slice(0, 3).map(r => r.j.left).join() === '2,1,0');
  const b1 = await go({ id: target }, {}, ipB), b2 = await go({ id: target }, {}, ipB), c1 = await go({ id: target }, {}, ipC);
  t('site cap (CHAT_ANA_DAILY=5): another IP gets 2 more, then 429 site_cap', b1.s === 200 && b2.s === 200 && c1.s === 429 && c1.j.code === 'site_cap', [b1.s, b2.s, c1.s].join());
  t('429 message tells when it resets (北京时间 0 点)', c1.j.error.includes('北京时间 0 点'));
  const rows = db.prepare('SELECT k FROM ana_use').all().map(r => r.k);
  t('counters store a hash, never the IP', rows.length >= 2 && !rows.some(k => k.includes('198.51')) && rows.includes('*'));
  const adm = await go({ id: target }, { 'x-admin-key': 'adm_TEST_KEY' }, ipC);
  t('admin exempt from analysis caps (like /api/chat)', adm.s === 200 && adm.j.left === -1);
  // China day boundary: 2026-10-21 23:59 Beijing (15:59 UTC) vs 2026-10-22 00:01 Beijing (16:01 UTC)
  t('China day: 15:59 UTC is still 10-21, 16:01 UTC is 10-22', cnDay(Date.UTC(2026, 9, 21, 15, 59)) === '2026-10-21' && cnDay(Date.UTC(2026, 9, 21, 16, 1)) === '2026-10-22');
  const dk = 'k_daytest';
  const a1 = store.anaBegin(dk, '2026-10-21', 1, 0), a2 = store.anaBegin(dk, '2026-10-21', 1, 0), a3 = store.anaBegin(dk, '2026-10-22', 1, 0);
  t('per-IP counter resets on the next China day', a1.ok && !a2.ok && a2.why === 'ip' && a3.ok);
  env.CHAT_ANA_IP_DAILY = '0'; env.CHAT_ANA_DAILY = '0'; db.exec('DELETE FROM ana_use');
  let all = true; for (let i = 0; i < 25; i++) if ((await go({ id: target }, {}, ipA)).s !== 200) all = false;
  t('0 = unlimited for both caps', all);
  delete env.CHAT_ANA_IP_DAILY; delete env.CHAT_ANA_DAILY; db.exec('DELETE FROM ana_use');
  const ds = []; for (let i = 0; i < 21; i++) ds.push((await go({ id: target }, {}, ipB)).s);
  t('defaults: 20 per IP per day, 21st → 429', ds.slice(0, 20).every(s => s === 200) && ds[20] === 429, ds.join());
  env.CHAT_ANA_IP_DAILY = 'abc';
  t('invalid env value falls back to default', (await go({ id: target }, {}, ipB)).s === 429);
  delete env.CHAT_ANA_IP_DAILY; db.exec('DELETE FROM ana_use');
  env.CHAT_ANA_DAILY = '300';
  db.prepare("INSERT INTO ana_use(k,day,n) VALUES('*',?,300)").run(cnDay(Date.now()));
  const sc = await go({ id: target }, {}, '192.0.2.99');
  t('defaults: site cap 300 → 429 site_cap', sc.s === 429 && sc.j.code === 'site_cap' && sc.j.error.includes('300'));
  delete env.CHAT_ANA_DAILY; db.exec('DELETE FROM ana_use');
  rlBlocked = true; const rl = await go({ id: target }); rlBlocked = false;
  t('short-term CHAT_RL limit → 429 rate', rl.s === 429 && rl.j.code === 'rate');
  t('not-found does not burn quota', (await go({ id: 424242 }, {}, ipC)).s === 404 && !db.prepare('SELECT n FROM ana_use WHERE k<>?').all('*').length);
  // concurrency: the check-and-count is one synchronous DO call → no overshoot
  db.exec('DELETE FROM ana_use'); env.CHAT_ANA_IP_DAILY = '4';
  const par = await Promise.all(Array.from({ length: 10 }, () => go({ id: target }, {}, ipA)));
  t('10 parallel requests with cap 4 → exactly 4 succeed', par.filter(r => r.s === 200).length === 4 && par.filter(r => r.s === 429).length === 6, par.map(r => r.s).join());
  delete env.CHAT_ANA_IP_DAILY; db.exec('DELETE FROM ana_use');
}
/* ===== 6. PII scrubber ===== */
{
  const cases = [
    ['手机 13812345678 打我', '[手机号]'], ['+86 138-1234-5678', '[手机号]'], ['8613812345678', '[手机号]'], ['电话 010-62345678', '[电话]'], ['call +1 415 555 0100', '[电话]'],
    ['邮箱 a.b+c@mail.example.co', '[邮箱]'], ['身份证 11010519491231002X', '[身份证号]'], ['旧证 110105491231002', '[身份证号]'],
    ['IP 192.168.1.20 访问', '[IP]'], ['v6 2001:db8:85a3::8a2e:370:7334', '[IP]'], ['fe80::1ff:fe23:4567:890a', '[IP]'],
    ['https://a.example/x?access_token=Zz9_8yY7&x=1', 'access_token=[令牌]'], ['https://a.example/reset/aB3dE5fG7hJ9kL1mN3pQ5rS7tU9', '/[令牌]'],
    ['https://a.example/?q=hello&sig=0123456789abcdefABCDEF', 'sig=[令牌]'], ['Authorization: Bearer abcdefghijklmnop123', 'Bearer [令牌]'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', '[令牌]'], ['key sk-abcdefghijklmnopqrstuv', '[令牌]'],
  ];
  for (const [i, want] of cases) { const o = scrubPII(i); t('pii: ' + i.slice(0, 32) + ' → ' + want, o.includes(want), o); }
  const keep = ['现在 12:30:45 了', '日期 2026-10-21', '价格 1999 元', '订单 20261021', 'https://example.com/docs?page=2&lang=zh', '我有 3 个问题', 'C++ 和 a:b:c'];
  for (const k of keep) t('pii: keeps ordinary text: ' + k, scrubPII(k) === k, scrubPII(k));
  t('pii: query keys kept, only values replaced', scrubPII('https://x.example/p?token=abc123&lang=zh') === 'https://x.example/p?token=[令牌]&lang=zh', scrubPII('https://x.example/p?token=abc123&lang=zh'));
}
/* ===== 7. logs carry no content / IPs / keys ===== */
{
  const all = LOGS.join('\n');
  t('nothing logged with message text, IPs, chat keys or the admin key', !/请问这个网盘|13812345678|绝密|203\.0\.113|198\.51\.100|AAAAAAAAAAAAAAAAAAAAAAAA|adm_TEST_KEY/.test(all), all.slice(0, 300));
  const wsrc = fs.readFileSync(path.join(root, 'worker/worker.js'), 'utf8');
  const blk = wsrc.slice(wsrc.indexOf('「聊天分析」 one message'), wsrc.indexOf('/* ---------------- admin: AI analysis of chat sessions'));
  t('analysis code has no console.* calls and does not touch lastAIError', blk.length > 1000 && !/console\./.test(blk) && !/lastAIError/.test(blk));
}
/* ===== 8. config + page copy ===== */
{
  const wr = fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8'), ch = fs.readFileSync(path.join(root, 'site/chat.html'), 'utf8');
  t('wrangler.jsonc: no new migration (only v1)', (wr.match(/"tag"/g) || []).length === 1 && wr.includes('"tag": "v1"'));
  t('wrangler.jsonc: CHAT_ANA_IP_DAILY / CHAT_ANA_DAILY vars present', /"CHAT_ANA_IP_DAILY": "20"/.test(wr) && /"CHAT_ANA_DAILY": "300"/.test(wr));
  t('chat page says 模型推测，仅供参考 and names no model', ch.includes('模型推测，仅供参考') && !/clef|gpt-oss|llama/i.test(ch));
  t('chat page has no 好感度 wording', !/好感度/.test(ch));
  t('Clef questions: 1..64, ids valid', Object.keys(ANA_Q).length >= 1 && Object.keys(ANA_Q).length <= 64 && Object.keys(ANA_Q).every(k => /^[A-Za-z0-9_.-]{1,100}$/.test(k)));
}
console.log(`${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
