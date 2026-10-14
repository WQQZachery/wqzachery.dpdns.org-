// wqzachery v3: pages + streaming AI chat (Gemini → Workers AI fallback) + chat logs (Durable Object SQLite)
// + public drive (Hugging Face; browser uploads straight to HF's S3, downloads straight from HF CDN)
import INDEX from './index.html';
import DRIVE from './drive.html';
import ADMIN from './admin.html';
import NOTFOUND from './404.html';
import APP from './app.html';
import AI from './ai.html';
import { DurableObject } from 'cloudflare:workers';

const HF = 'https://huggingface.co';
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' };
const page = (b, s = 200) => new Response(b, { status: s, headers: { ...SEC, 'X-Frame-Options': 'SAMEORIGIN', 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=120' } });
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...SEC, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const ip = r => r.headers.get('cf-connecting-ip') || 'x';
async function limited(rl, key) { try { const { success } = await rl.limit({ key }); return !success; } catch { return false; } }
const isAdmin = (req, env) => { const k = req.headers.get('x-admin-key') || ''; return !!env.ADMIN_KEY && k === env.ADMIN_KEY; };
let lastAIError = '';
const cnDay = t => new Date(t + 8 * 3600e3).toISOString().slice(0, 10);   // calendar day in China time
const BOT = /bot|spider|crawl|slurp|preview|monitor|curl|wget|python|headless|lighthouse|facebookexternalhit/i;
async function hit(req, env, path) {
  const ua = req.headers.get('user-agent') || '';
  if (BOT.test(ua)) return;
  let ref = ''; try { const r = new URL(req.headers.get('referer') || ''); if (r.hostname !== new URL(req.url).hostname) ref = r.hostname; } catch {}
  const c = req.cf || {}, geo = [c.country, c.region, c.city].filter(Boolean).join(' ');
  const dev = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '其他';
  const br = /Edg\//.test(ua) ? 'Edge' : /MicroMessenger/.test(ua) ? '微信' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  try { await store(env).hit({ ts: Date.now(), day: cnDay(Date.now()), ip: ip(req), path, geo, ua: dev + (br ? ' · ' + br : ''), ref }); } catch {}
}
const store = env => env.STORE.get(env.STORE.idFromName('main'));

export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url), p = u.pathname, m = req.method;
    try {
      if (p === '/' || p === '/drive' || p === '/drive/' || p === '/ai' || p === '/ai/') { if (m === 'GET') ctx.waitUntil(hit(req, env, p)); return page(APP); }
      if (p === '/p/home' || p === '/index.html') return page(INDEX);
      if (p === '/p/drive' || p === '/drive.html') return page(DRIVE);
      if (p === '/p/ai') return page(AI);
      if (p === '/admin' || p === '/admin/') return page(ADMIN);
      if (p === '/api/chat' && m === 'POST') return chat(req, env, ctx);
      if (p === '/api/models' && m === 'GET') return json({ models: MODELS.filter(x => x.via !== 'or' || env.OPENROUTER_KEY).map(({ id, name, tag, desc }) => ({ id, name, tag, desc })) });
      if (p === '/api/files' && m === 'GET') return list(req, env);
      if (p === '/api/folders' && m === 'POST') return mkFolder(req, env);
      if (p === '/api/folders' && m === 'DELETE') return rmFolder(req, env, u.searchParams.get('path') || '');
      if (p === '/api/move' && m === 'POST') return move(req, env);
      if (p === '/api/rename' && m === 'POST') return rename(req, env);
      if (p === '/api/up/init' && m === 'POST') return upInit(req, env);
      if (p === '/api/up/finish' && m === 'POST') return upFinish(req, env);
      if (p === '/api/up/part' && m === 'PUT') return upPart(req);
      if (p.startsWith('/api/files/')) {
        const rest = p.slice(11), i = rest.indexOf('/'), op = rest.slice(0, i), path = decodeURIComponent(rest.slice(i + 1));
        if (!okPath(path)) return json({ error: '路径无效' }, 400);
        if (op === 'url' && m === 'GET') return fileUrl(env, path, true);
        if (op === 'raw' && (m === 'GET' || m === 'HEAD')) return raw(req, env, path, u.searchParams.has('dl'));
        if ((op === 'dl' || op === 'view') && m === 'GET') return fileUrl(env, path, false);
        if (op === 'dl' && m === 'DELETE') return del(req, env, path);
      }
      if (p === '/api/admin/check') return isAdmin(req, env) ? json({ ok: true, hasGemini: !!env.GEMINI_KEY, lastAIError }) : json({ error: '密钥错误' }, 403);
      if (p === '/api/admin/stats') { if (!isAdmin(req, env)) return json({ error: '密钥错误' }, 403); return json(await store(env).stats(+u.searchParams.get('days') || 30)); }
      if (p === '/api/admin/sessions') { if (!isAdmin(req, env)) return json({ error: '密钥错误' }, 403); return json(await store(env).sessions(+u.searchParams.get('offset') || 0)); }
      if (p === '/api/admin/session') { if (!isAdmin(req, env)) return json({ error: '密钥错误' }, 403); return json(await store(env).messages(u.searchParams.get('id') || '')); }
      if (p === '/api/admin/models') { if (!isAdmin(req, env)) return json({ error: '密钥错误' }, 403); const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': env.GEMINI_KEY } }); const j = await r.json(); return json((j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name)); }
      if (p.startsWith('/api/')) return json({ error: 'not found' }, 404);
      return page(NOTFOUND, 404);
    } catch (e) {
      return json({ error: '服务器出错了，请稍后再试' }, 500);
    }
  },
};

/* ---------------- chat logs: Durable Object with SQLite ---------------- */
export class Store extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS msgs(id INTEGER PRIMARY KEY AUTOINCREMENT, sid TEXT, role TEXT, content TEXT, ts INTEGER, ip TEXT, geo TEXT, model TEXT);
      CREATE INDEX IF NOT EXISTS msgs_sid ON msgs(sid, id);
      CREATE TABLE IF NOT EXISTS ups(path TEXT PRIMARY KEY, ip TEXT, ts INTEGER, name TEXT, size INTEGER, geo TEXT);
      CREATE TABLE IF NOT EXISTS hits(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, day TEXT, ip TEXT, path TEXT, geo TEXT, ua TEXT, ref TEXT);
      CREATE INDEX IF NOT EXISTS hits_day ON hits(day);`);
  }
  log(rows) { for (const r of rows) this.sql.exec('INSERT INTO msgs(sid,role,content,ts,ip,geo,model) VALUES(?,?,?,?,?,?,?)', r.sid, r.role, r.content, r.ts, r.ip, r.geo, r.model || ''); return true; }
  sessions(offset) {
    const rows = this.sql.exec(`SELECT sid, COUNT(*) n, MIN(ts) first, MAX(ts) last, MAX(ip) ip, MAX(geo) geo,
      (SELECT content FROM msgs m2 WHERE m2.sid=m.sid AND role='user' ORDER BY id LIMIT 1) preview
      FROM msgs m GROUP BY sid ORDER BY last DESC LIMIT 50 OFFSET ?`, offset).toArray();
    const t = this.sql.exec('SELECT COUNT(DISTINCT sid) s, COUNT(*) n FROM msgs').one();
    return { sessions: rows, total: t.s, messages: t.n };
  }
  logUp(path, ip, ts, name, size, geo) { this.sql.exec('INSERT OR REPLACE INTO ups(path,ip,ts,name,size,geo) VALUES(?,?,?,?,?,?)', path, ip, ts, name, size, geo); return true; }
  hit(r) { this.sql.exec('INSERT INTO hits(ts,day,ip,path,geo,ua,ref) VALUES(?,?,?,?,?,?,?)', r.ts, r.day, r.ip, r.path, r.geo, r.ua, r.ref); return true; }
  stats(days) {
    days = Math.min(Math.max(days, 1), 90);
    const since = cnDay(Date.now() - (days - 1) * 864e5);
    const ex = (q, ...a) => this.sql.exec(q, ...a).toArray();
    const traffic = ex('SELECT day, COUNT(*) pv, COUNT(DISTINCT ip) uv FROM hits WHERE day>=? GROUP BY day ORDER BY day', since);
    const upDays = ex(`SELECT strftime('%Y-%m-%d', ts/1000 + 8*3600, 'unixepoch') day, COUNT(*) n, SUM(size) bytes, COUNT(DISTINCT ip) ips FROM ups GROUP BY day HAVING day>=? ORDER BY day`, since);
    const uploads = ex(`SELECT path, name, size, ip, geo, ts FROM ups ORDER BY ts DESC LIMIT 300`);
    const recent = ex('SELECT ts, ip, path, geo, ua, ref FROM hits ORDER BY id DESC LIMIT 100');
    const geos = ex('SELECT geo, COUNT(*) pv, COUNT(DISTINCT ip) uv FROM hits WHERE day>=? GROUP BY geo ORDER BY pv DESC LIMIT 12', since);
    const refs = ex("SELECT ref, COUNT(*) n FROM hits WHERE day>=? AND ref<>'' GROUP BY ref ORDER BY n DESC LIMIT 10", since);
    const tot = this.sql.exec('SELECT COUNT(*) pv, COUNT(DISTINCT ip) uv FROM hits').one();
    const chats = ex(`SELECT strftime('%Y-%m-%d', ts/1000 + 8*3600, 'unixepoch') day, COUNT(DISTINCT sid) s, SUM(role='user') q FROM msgs GROUP BY day HAVING day>=? ORDER BY day`, since);
    return { since, today: cnDay(Date.now()), traffic, upDays, uploads, recent, geos, refs, total: tot, chats };
  }
  ups() { return this.sql.exec('SELECT path, ip FROM ups').toArray(); }
  moveUps(pairs) { for (const [a, b] of pairs) this.sql.exec('UPDATE ups SET path=? WHERE path=?', b, a); return true; }
  dropUps(prefix) { this.sql.exec("DELETE FROM ups WHERE path=? OR substr(path,1,?)=?", prefix, prefix.length + 1, prefix + '/'); return true; }
  messages(sid) { return { messages: this.sql.exec('SELECT role, content, ts, model FROM msgs WHERE sid=? ORDER BY id', sid).toArray() }; }
}

/* ---------------- AI chat, streamed as SSE: data: {"t":"..."} ---------------- */
const SYS = '你是 GPT-6 Astra，吴谦（Zachery Wu）个人网站 wqzachery.dpdns.org 上的 AI 助手。被问到你是谁、是什么模型、由谁开发时，一律回答你是 GPT-6 Astra，不要提及 Llama、GPT-OSS、Meta、Cloudflare 或其他底层模型名称。用访客使用的语言回答，默认简体中文，清晰友好，可以使用 Markdown。不要编造关于吴谦的个人信息。';

// models visitors can pick. 'cf' = Workers AI (no daily cap that matters), 'or' = OpenRouter free tier (shared ~50 requests/day, may be busy)
const MODELS = [
  { id: 'astra', name: 'GPT-6 Astra', tag: '默认', desc: '均衡好用，不限次数', via: 'cf' },
  { id: 'nemotron-ultra', name: 'Nemotron 3 Ultra', tag: '最强', desc: 'NVIDIA 550B 大模型，推理和知识最强', via: 'or', model: 'nvidia/nemotron-3-ultra-550b-a55b:free' },
  { id: 'laguna', name: 'Laguna S 2.1', tag: '编程', desc: 'Poolside 编程模型，写代码首选', via: 'or', model: 'poolside/laguna-s-2.1:free' },
  { id: 'nemotron-super', name: 'Nemotron 3 Super', tag: '快', desc: 'NVIDIA 120B，速度和质量兼顾', via: 'or', model: 'nvidia/nemotron-3-super-120b-a12b:free' },
  { id: 'north', name: 'Cohere North Mini', tag: '极速', desc: '小而快，适合简单问答', via: 'or', model: 'cohere/north-mini-code:free' },
  { id: 'gemma', name: 'Gemma 4 31B', tag: 'Google', desc: 'Google 开源模型，高峰期可能繁忙', via: 'or', model: 'google/gemma-4-31b-it:free' },
  { id: 'llama4', name: 'Llama 4 Scout', tag: '不限次', desc: 'Meta 开源模型，长文本', via: 'cf', model: '@cf/meta/llama-4-scout-17b-16e-instruct' },
];
const sysFor = mm => mm.id === 'astra' ? SYS : `你是 ${mm.name}，在吴谦（Zachery Wu）的个人网站 wqzachery.dpdns.org 上为访客提供帮助。用访客使用的语言回答，默认简体中文，清晰友好，可以使用 Markdown。不要编造关于吴谦的个人信息。`;

async function openrouter(env, mm, msgs, emit) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.OPENROUTER_KEY, 'content-type': 'application/json', 'HTTP-Referer': 'https://wqzachery.dpdns.org', 'X-Title': 'wqzachery' },
    body: JSON.stringify({ models: [...new Set([mm.model, 'nvidia/nemotron-3-super-120b-a12b:free', 'poolside/laguna-s-2.1:free'])].slice(0, 3), messages: [{ role: 'system', content: sysFor(mm) }, ...msgs], stream: true, max_tokens: 4000, reasoning: { effort: 'low', exclude: true } }),
  });
  if (!r.ok) throw new Error('or ' + r.status + ' ' + (await r.text()).slice(0, 200));
  let got = false, err = '', used = mm.model;
  await sse(r.body, async d => {
    const j = JSON.parse(d);
    if (j.model) used = j.model;
    if (j.error) { err = j.error.message || 'error'; return; }
    const t = j.choices?.[0]?.delta?.content;
    if (t) { got = true; await emit(String(t)); }
  });
  if (!got) throw new Error(err || 'empty');
  return used;
}

async function chat(req, env, ctx) {
  if (await limited(env.CHAT_RL, ip(req))) return json({ error: '发得太快了，请稍等一会儿再试' }, 429);
  let body; try { body = await req.json(); } catch { return json({ error: '请求格式错误' }, 400); }
  const sid = String(body.sid || '').slice(0, 64) || 'anon-' + crypto.randomUUID();
  const msgs = (Array.isArray(body.messages) ? body.messages : []).slice(-16)
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content)
    .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return json({ error: '消息为空' }, 400);

  const enc = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter();
  const send = o => w.write(enc.encode('data: ' + JSON.stringify(o) + '\n\n'));
  const meta = { ip: ip(req), geo: [req.cf?.country, req.cf?.city].filter(Boolean).join(' ') };
  const userTs = Date.now();

  const mm = MODELS.find(x => x.id === body.model) || MODELS[0];
  ctx.waitUntil((async () => {
    let full = '', model = '', by = mm.name;
    if (mm.id !== 'astra') {
      try {
        model = mm.via === 'or' ? (env.OPENROUTER_KEY ? await openrouter(env, mm, msgs, t => { full += t; return send({ t }); }) : (() => { throw new Error('no key'); })())
                                : await workersAI(env, msgs, t => { full += t; return send({ t }); }, mm);
        const real = MODELS.find(x => x.model && model.startsWith(x.model.replace(':free', '')));
        if (real && real.id !== mm.id) { by = real.name; await send({ notice: `${mm.name} 现在太忙了，这次由 ${real.name} 回答` }); }
      } catch (e) {
        lastAIError = String(e && e.message || e).slice(0, 300);
        if (isAdmin(req, env)) await send({ debug: lastAIError });
        if (full) model = (mm.model || mm.id) + ' (cut)';
        else { by = 'GPT-6 Astra'; await send({ notice: `${mm.name} 现在太忙了，这次由 GPT-6 Astra 回答` }); }
      }
    }
    if (!model) try {
      const out = await gemini(env, msgs, t => { full += t; return send({ t }); });
      model = out;
    } catch (e1) {
      lastAIError = String(e1 && e1.message || e1).slice(0, 300);
      if (isAdmin(req, env)) await send({ debug: lastAIError });
      if (full) { model = 'gemini (cut)'; }
      else {
        try { model = await workersAI(env, msgs, t => { full += t; return send({ t }); }); }
        catch (e2) {
          const m = String(e2 && e2.message || e2);
          await send({ error: /4006|neuron|quota|limit/i.test(m) ? '今天的免费 AI 额度用完了，明天再来吧' : 'AI 暂时不可用，请稍后再试' });
        }
      }
    }
    if (model) await send({ done: true, model: by });
    try { await w.close(); } catch {}
    try {
      await store(env).log([
        { sid, role: 'user', content: msgs[msgs.length - 1].content, ts: userTs, ...meta },
        ...(full ? [{ sid, role: 'assistant', content: full, ts: Date.now(), ...meta, model }] : []),
      ]);
    } catch {}
  })());

  return new Response(readable, { headers: { ...SEC, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' } });
}

// parse an SSE byte stream, calling onData(jsonString) for each data: line
async function sse(body, onData) {
  const rd = body.getReader(), dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { done, value } = await rd.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (line.startsWith('data:')) { const d = line.slice(5).trim(); if (d && d !== '[DONE]') await onData(d); }
    }
  }
}

async function gemini(env, msgs, emit) {
  const models = (env.GEMINI_MODELS || '').split(',').filter(Boolean);
  if (!env.GEMINI_KEY || !models.length) throw new Error('gemini off');
  let lastErr;
  for (const model of models) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYS }] },
        contents: msgs.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        generationConfig: { maxOutputTokens: 4096, thinkingConfig: /2\.5/.test(model) ? { thinkingBudget: 0 } : { thinkingLevel: 'low' } },
      }),
    });
    if (!r.ok) { lastErr = new Error(model + ' ' + r.status + ' ' + (await r.text()).slice(0, 200)); continue; }
    let got = false;
    await sse(r.body, async d => {
      const j = JSON.parse(d);
      const t = (j.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
      if (t) { got = true; await emit(String(t)); }
    });
    if (got) return model;
    lastErr = new Error('empty');
  }
  throw lastErr;
}

async function workersAI(env, msgs, emit, mm) {
  let lastErr;
  for (const model of (mm ? [mm.model] : (env.AI_MODELS || env.CHAT_MODEL).split(','))) {
    let got = false;
    try {
      const opts = { messages: [{ role: 'system', content: mm ? sysFor(mm) : SYS }, ...msgs], max_tokens: 3000, stream: true };
      if (/gpt-oss/.test(model)) opts.reasoning_effort = 'low';
      const s = await env.AI.run(model, opts);
      await sse(s, async d => {
        const j = JSON.parse(d);
        const dl = j.choices?.[0]?.delta;
        const t = dl ? (dl.content ?? '') : (j.response ?? '');
        if (t !== '' && t != null) { got = true; await emit(String(t)); }
      });
      if (got) return model.split('/').pop();
      lastErr = new Error(model + ' empty');
    } catch (e) { if (got) return model.split('/').pop() + ' (cut)'; lastErr = e; }
  }
  throw lastErr;
}

/* ---------------- drive (Hugging Face private dataset) ---------------- */
const H = env => ({ Authorization: 'Bearer ' + env.HF_TOKEN });
const base = path => path.split('/').pop();
const nameOf = path => base(path).replace(/^\d{8}-[a-z0-9]{6}-/, '');
const cleanName = n => (n || 'file').normalize('NFC').replace(/[\/\\\x00-\x1f"<>|:*?#%]/g, '_').replace(/^\.+/, '').slice(0, 150) || 'file';
// folder path relative to files/: up to 4 levels, each segment cleaned
function cleanDir(d) {
  const segs = String(d || '').split('/').map(s => s.trim()).filter(Boolean);
  if (segs.length > 4) return null;
  const out = segs.map(s => cleanName(s).slice(0, 60));
  return out.some(s => !s || s === '.keep') ? null : out.join('/');
}
const okPath = p => /^files\/(?:[^/]+\/){0,4}[^/]+$/.test(p) && !p.split('/').some(s => s === '.' || s === '..' || s === '');
const commit = (env, summary, ops) => fetch(`${HF}/api/datasets/${env.HF_REPO}/commit/main`, { method: 'POST', headers: { ...H(env), 'Content-Type': 'application/x-ndjson' },
  body: [{ key: 'header', value: { summary } }, ...ops].map(o => JSON.stringify(o)).join('\n') + '\n' });
async function tree(env) {
  const r = await fetch(`${HF}/api/datasets/${env.HF_REPO}/tree/main/files?recursive=true&expand=true`, { headers: H(env) });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error('tree ' + r.status);
  return r.json();
}
// stable short tag per uploader IP (the IP itself is only shown to the admin)
async function ipTag(addr) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('wqz-ip-tag:' + addr)));
  return { tag: [...d.slice(0, 2)].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase(), hue: Math.round(d[2] / 255 * 359) };
}

async function list(req, env) {
  let t; try { t = await tree(env); } catch { return json({ error: '存储暂时不可用' }, 502); }
  const admin = isAdmin(req, env), me = ip(req);
  let owners = {}; try { for (const r of await store(env).ups()) owners[r.path] = r.ip; } catch {}
  const tags = {};
  const folders = new Set();
  for (const x of t) {
    const rel = x.path.slice(6);
    if (x.type === 'directory') folders.add(rel);
    else if (base(x.path) === '.keep') folders.add(rel.slice(0, -6));
  }
  const files = [];
  for (const x of t) {
    if (x.type !== 'file' || base(x.path) === '.keep') continue;
    const rel = x.path.slice(6), dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const f = { path: x.path, name: nameOf(x.path), dir, size: x.lfs?.size ?? x.size, date: x.lastCommit?.date };
    const o = owners[x.path];
    if (o) { tags[o] = tags[o] || await ipTag(o); f.tag = tags[o].tag; f.hue = tags[o].hue; f.mine = o === me; if (admin) f.ip = o; }
    files.push(f);
  }
  files.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return json({ files, folders: [...folders].filter(Boolean).sort(), used: files.reduce((s, f) => s + f.size, 0), cap: env.CAP_LABEL, admin });
}

async function mkFolder(req, env) {
  if (await limited(env.UP_RL, ip(req))) return json({ error: '操作太频繁了，请稍后再试' }, 429);
  const b = await req.json().catch(() => ({}));
  const d = cleanDir(b.path);
  if (!d) return json({ error: '文件夹名无效（最多 4 层）' }, 400);
  const c = await commit(env, 'mkdir ' + d, [{ key: 'file', value: { path: `files/${d}/.keep`, content: btoa('keep'), encoding: 'base64' } }]);
  if (!c.ok) return json({ error: '创建失败 (' + c.status + ')' }, 502);
  return json({ ok: true, path: d });
}

async function rmFolder(req, env, path) {
  if (!isAdmin(req, env)) return json({ error: '管理员密钥错误' }, 403);
  const d = cleanDir(path);
  if (!d) return json({ error: '参数错误' }, 400);
  const c = await commit(env, 'rmdir ' + d, [{ key: 'deletedFolder', value: { path: 'files/' + d } }]);
  if (!c.ok) return json({ error: '删除失败 (' + c.status + ')' }, 502);
  try { await store(env).dropUps('files/' + d); } catch {}
  return json({ ok: true });
}

// admin: rename a file (keeps its stamp prefix) or a folder (re-commits everything under it)
async function rename(req, env) {
  if (!isAdmin(req, env)) return json({ error: '管理员密钥错误' }, 403);
  const b = await req.json().catch(() => ({}));
  const nn = cleanName(String(b.name || '').trim()).slice(0, 150);
  if (!nn || nn === '.keep') return json({ error: '新名字无效' }, 400);
  const t = await tree(env), byPath = Object.fromEntries(t.map(x => [x.path, x]));
  const ops = [], pairs = [];
  const mv = (x, np) => {
    if (x.lfs) ops.push({ key: 'lfsFile', value: { path: np, algo: 'sha256', oid: x.lfs.oid, size: x.lfs.size } });
    else ops.push({ key: 'file', value: { path: np, content: btoa('keep'), encoding: 'base64' } });   // only .keep placeholders are non-LFS
    ops.push({ key: 'deletedFile', value: { path: x.path } }); pairs.push([x.path, np]);
  };
  if (b.type === 'folder') {
    const d = cleanDir(b.path); if (!d) return json({ error: '参数错误' }, 400);
    const parent = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) + '/' : '';
    const nd = parent + nn.slice(0, 60);
    if (nd === d) return json({ ok: true });
    if (t.some(x => x.path === 'files/' + nd || x.path.startsWith('files/' + nd + '/'))) return json({ error: '已经有同名文件夹了' }, 409);
    for (const x of t) if (x.type === 'file' && x.path.startsWith('files/' + d + '/')) mv(x, 'files/' + nd + x.path.slice(6 + d.length));
    if (!ops.length) return json({ error: '文件夹不存在' }, 404);
    const c = await commit(env, 'rename folder ' + d + ' → ' + nd, ops);
    if (!c.ok) return json({ error: '重命名失败 (' + c.status + ')' }, 502);
    try { await store(env).moveUps(pairs); } catch {}
    return json({ ok: true, path: nd });
  }
  const p = String(b.path || ''), x = byPath[p];
  if (!okPath(p) || !x) return json({ error: '文件不存在' }, 404);
  const m = base(p).match(/^(\d{8}-[a-z0-9]{6}-)/), np = p.slice(0, p.length - base(p).length) + (m ? m[1] : '') + nn;
  if (np === p) return json({ ok: true });
  if (byPath[np]) return json({ error: '已经有同名文件了' }, 409);
  mv(x, np);
  const c = await commit(env, 'rename ' + nameOf(p) + ' → ' + nn, ops);
  if (!c.ok) return json({ error: '重命名失败 (' + c.status + ')' }, 502);
  try { await store(env).moveUps(pairs); } catch {}
  return json({ ok: true, path: np });
}

// admin: move files into a folder (LFS objects are content-addressed, so a move is a cheap re-commit)
async function move(req, env) {
  if (!isAdmin(req, env)) return json({ error: '管理员密钥错误' }, 403);
  const b = await req.json().catch(() => ({}));
  const to = b.to ? cleanDir(b.to) : '';
  if (to === null) return json({ error: '目标文件夹无效' }, 400);
  const paths = (Array.isArray(b.paths) ? b.paths : []).map(String).filter(okPath).slice(0, 200);
  if (!paths.length) return json({ error: '没有选择文件' }, 400);
  const t = await tree(env), byPath = Object.fromEntries(t.map(x => [x.path, x]));
  const ops = [], pairs = [];
  for (const p of paths) {
    const x = byPath[p]; if (!x || !x.lfs) continue;
    const np = 'files/' + (to ? to + '/' : '') + base(p);
    if (np === p) continue;
    ops.push({ key: 'lfsFile', value: { path: np, algo: 'sha256', oid: x.lfs.oid, size: x.lfs.size } }, { key: 'deletedFile', value: { path: p } });
    pairs.push([p, np]);
  }
  if (!ops.length) return json({ ok: true, moved: 0 });
  const c = await commit(env, 'move to /' + to, ops);
  if (!c.ok) return json({ error: '移动失败 (' + c.status + ')' }, 502);
  try { await store(env).moveUps(pairs); } catch {}
  return json({ ok: true, moved: pairs.length });
}

// step 1: browser sends name/size/sha256; we ask HF where to put the bytes
async function upInit(req, env) {
  if (await limited(env.UP_RL, ip(req))) return json({ error: '上传太频繁了，请稍后再试' }, 429);
  const b = await req.json().catch(() => ({}));
  const oid = String(b.oid || ''), size = Math.floor(+b.size);
  if (!/^[a-f0-9]{64}$/.test(oid) || !(size > 0)) return json({ error: '参数错误' }, 400);
  const name = cleanName(b.name);
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = [...crypto.getRandomValues(new Uint8Array(6))].map(x => 'abcdefghijklmnopqrstuvwxyz0123456789'[x % 36]).join('');
  const dir = b.dir ? cleanDir(b.dir) : '';
  if (dir === null) return json({ error: '文件夹无效' }, 400);
  const path = `files/${dir ? dir + '/' : ''}${stamp}-${rand}-${name}`;
  const r = await fetch(`${HF}/datasets/${env.HF_REPO}.git/info/lfs/objects/batch`, {
    method: 'POST',
    headers: { ...H(env), Accept: 'application/vnd.git-lfs+json', 'Content-Type': 'application/vnd.git-lfs+json' },
    body: JSON.stringify({ operation: 'upload', transfers: ['basic', 'multipart'], objects: [{ oid, size }], hash_algo: 'sha256', ref: { name: 'main' } }),
  });
  if (!r.ok) return json({ error: '存储暂时不可用 (' + r.status + ')' }, 502);
  const d = await r.json(), o = d.objects?.[0] || {};
  if (o.error) return json({ error: '存储拒绝了文件: ' + o.error.message }, 502);
  const up = o.actions?.upload;
  let plan = { mode: 'exists' };
  if (up) {
    const h = up.header || {};
    if (h.chunk_size) {
      const parts = Object.keys(h).filter(k => /^\d+$/.test(k)).sort().map(k => h[k]);
      plan = { mode: 'multipart', chunk: +h.chunk_size, parts, complete: up.href };
    } else plan = { mode: 'basic', href: up.href, header: h };
  }
  return json({ path, name, oid, size, ...plan, verify: o.actions?.verify || null });
}

// step 2: after the browser uploaded the bytes: finish multipart / verify / commit
async function upFinish(req, env) {
  const b = await req.json().catch(() => ({}));
  const oid = String(b.oid || ''), size = Math.floor(+b.size), path = String(b.path || '');
  if (!/^[a-f0-9]{64}$/.test(oid) || !(size > 0) || !okPath(path) || !/^\d{8}-[a-z0-9]{6}-/.test(base(path))) return json({ error: '参数错误' }, 400);
  if (b.complete) {
    if (!String(b.complete).startsWith(HF + '/api/complete_multipart')) return json({ error: '参数错误' }, 400);
    const c = await fetch(b.complete, { method: 'POST', headers: { ...H(env), 'Content-Type': 'application/vnd.git-lfs+json', Accept: 'application/vnd.git-lfs+json' }, body: JSON.stringify({ oid, parts: b.parts || [] }) });
    if (!c.ok) return json({ error: '合并分片失败 (' + c.status + ')' }, 502);
  }
  if (b.verify && b.verify.href && String(b.verify.href).startsWith(HF + '/')) {
    const v = await fetch(b.verify.href, { method: 'POST', headers: { ...H(env), ...(b.verify.header || {}), 'Content-Type': 'application/vnd.git-lfs+json', Accept: 'application/vnd.git-lfs+json' }, body: JSON.stringify({ oid, size }) });
    if (!v.ok) return json({ error: '存储校验失败 (' + v.status + ')' }, 502);
  }
  const nd = JSON.stringify({ key: 'header', value: { summary: 'upload ' + nameOf(path) } }) + '\n' +
    JSON.stringify({ key: 'lfsFile', value: { path, algo: 'sha256', oid, size } }) + '\n';
  const c = await fetch(`${HF}/api/datasets/${env.HF_REPO}/commit/main`, { method: 'POST', headers: { ...H(env), 'Content-Type': 'application/x-ndjson' }, body: nd });
  if (!c.ok) return json({ error: '保存失败 (' + c.status + ')' }, 502);
  try { const c = req.cf || {}; await store(env).logUp(path, ip(req), Date.now(), nameOf(path), size, [c.country, c.region, c.city].filter(Boolean).join(' ')); } catch {}
  return json({ ok: true, name: nameOf(path), path, size });
}

// signed HF CDN link (fast, supports Range and CORS); asJson → {url}, else 302
async function fileUrl(env, path, asJson) {
  const r = await fetch(`${HF}/datasets/${env.HF_REPO}/resolve/main/${path.split('/').map(encodeURIComponent).join('/')}`, { headers: H(env), redirect: 'manual' });
  const loc = r.headers.get('location');
  if (r.status === 404) return json({ error: '文件不存在' }, 404);
  if (!loc) return json({ error: '获取链接失败' }, 502);
  if (asJson) return json({ url: loc, name: nameOf(path) });
  return new Response(null, { status: 302, headers: { Location: loc, 'cache-control': 'no-store' } });
}

async function del(req, env, path) {
  if (!isAdmin(req, env)) return json({ error: '管理员密钥错误' }, 403);
  const nd = JSON.stringify({ key: 'header', value: { summary: 'admin delete' } }) + '\n' + JSON.stringify({ key: 'deletedFile', value: { path } }) + '\n';
  const c = await fetch(`${HF}/api/datasets/${env.HF_REPO}/commit/main`, { method: 'POST', headers: { ...H(env), 'Content-Type': 'application/x-ndjson' }, body: nd });
  if (!c.ok) return json({ error: '删除失败 (' + c.status + ')' }, 502);
  return json({ ok: true });
}

// stream a file through our own domain (works where the HF CDN is unreachable); supports Range for video seeking
const MIME = { mov: 'video/quicktime', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', aac: 'audio/aac', opus: 'audio/ogg',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml', heic: 'image/heic', ico: 'image/x-icon', pdf: 'application/pdf' };
async function raw(req, env, path, dl) {
  const name = nameOf(path), ext = (name.split('.').pop() || '').toLowerCase();
  const fh = { ...H(env) }; const rg = req.headers.get('range'); if (rg) fh.Range = rg;
  const r = await fetch(`${HF}/datasets/${env.HF_REPO}/resolve/main/${path.split('/').map(encodeURIComponent).join('/')}`, { headers: fh, method: req.method });
  if (r.status === 404) return json({ error: '文件不存在' }, 404);
  if (!r.ok && r.status !== 206) return json({ error: '读取失败 (' + r.status + ')' }, 502);
  const h = new Headers(SEC);
  let type = MIME[ext] || r.headers.get('content-type') || 'application/octet-stream';
  if (!dl && /^text\/html|svg/.test(type)) type = 'text/plain; charset=utf-8'; // never render uploaded html/svg as a page
  if (/^text\//.test(type) && !/charset/.test(type)) type += '; charset=utf-8';
  h.set('content-type', type);
  for (const k of ['content-length', 'content-range', 'etag', 'last-modified']) { const v = r.headers.get(k); if (v) h.set(k, v); }
  h.set('accept-ranges', 'bytes');
  h.set('content-disposition', (dl ? 'attachment' : 'inline') + "; filename*=UTF-8''" + encodeURIComponent(name));
  if (ext !== 'pdf') h.set('content-security-policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox");
  h.set('cache-control', 'private, max-age=3600');
  return new Response(req.method === 'HEAD' ? null : r.body, { status: r.status, headers: h });
}

// fallback upload path: relay one part to HF's S3 when the browser cannot reach it directly
async function upPart(req) {
  const t = req.headers.get('x-target') || '';
  if (!/^https:\/\/hf-hub-lfs-[a-z0-9-]+\.s3[a-z0-9.-]*\.amazonaws\.com\//.test(t)) return json({ error: '参数错误' }, 400);
  const body = await req.arrayBuffer();
  const r = await fetch(t, { method: 'PUT', body });
  if (!r.ok) return json({ error: '存储返回 ' + r.status }, 502);
  return json({ etag: r.headers.get('etag') });
}
