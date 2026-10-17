// wqzachery v3: pages + streaming AI chat (Gemini → Workers AI fallback) + chat logs (Durable Object SQLite)
// + public drive (Hugging Face; browser uploads straight to HF's S3, downloads straight from HF CDN)
import INDEX0 from './index.html';
import DRIVE0 from './drive.html';
import ADMIN0 from './admin.html';
import NOTFOUND from './404.html';
import APP0 from './app.html';
import AI0 from './ai.html';
import CHAT0 from './chat.html';
import PRIVACY0 from './privacy.html';
import SHARED_CSS from './shared.css';
import SHARED_JS from './shared.js';
import OG from './og.png';
import { DurableObject } from 'cloudflare:workers';

const HF = 'https://huggingface.co';
// /shared.css + /shared.js are cached for a year; pages reference them with ?v=<content hash> (placeholder __V__)
const fnv = t => { let h = 0x811c9dc5; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); };
const VER = fnv(SHARED_CSS + SHARED_JS);
const fill = h => h.split('__V__').join(VER);
const [INDEX, DRIVE, ADMIN, APP, AI, CHAT_HTML, PRIVACY] = [INDEX0, DRIVE0, ADMIN0, APP0, AI0, CHAT0, PRIVACY0].map(fill);
const asset = (body, type) => new Response(body, { headers: { ...SEC, 'content-type': type + '; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable', 'access-control-allow-origin': '*' } });
const LLMS = `# 吴谦 · Zachery Wu

> 吴谦（Zachery Wu）的个人网站，运行在 Cloudflare Workers 上，月成本 $0。包含个人主页、公共网盘、AI 助手 GPT-6 Astra 和实时聊天室。

## 页面
- [主页](https://wqzachery.dpdns.org/): 个人介绍、项目、常用工具、联系方式与更新日志
- [公共网盘](https://wqzachery.dpdns.org/drive): 任何人可上传、在线预览和下载文件（单文件 ≤2 GB，每 IP 每天 ≤5 GB / 50 个，禁止可执行文件），存储在 Hugging Face
- [隐私说明](https://wqzachery.dpdns.org/privacy): 记录哪些数据、发给哪些第三方、保存多久
- [AI 助手](https://wqzachery.dpdns.org/ai): GPT-6 Astra 聊天，支持多模型（含 DeepSeek R1、Qwen、GLM 等国产模型）、联网搜索与低/中/高思考等级
- [聊天室](https://wqzachery.dpdns.org/chat): 实时公共聊天室（WebSocket），匿名昵称、在线人数、私信与 @提及

## 关于作者
- 名字：吴谦（Zachery Wu）
- GitHub: https://github.com/WQQZachery
- 日常使用 Claude、ChatGPT、Gemini、Grok、GitHub Copilot 等 AI 与开发工具

## 技术
- Cloudflare Workers + Durable Objects (SQLite) + Workers AI
- 网盘存储：Hugging Face 私有数据集，浏览器直传 S3 分片
- 域名：wqzachery.dpdns.org
`;
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' };
const page = (b, s = 200, x = {}) => new Response(b, { status: s, headers: { ...SEC, 'X-Frame-Options': 'SAMEORIGIN', 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=120', ...x } });
const NOIDX = { 'X-Robots-Tag': 'noindex, nofollow' };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...SEC, ...NOIDX, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const ip = r => r.headers.get('cf-connecting-ip') || 'x';
async function limited(rl, key) { try { const { success } = await rl.limit({ key }); return !success; } catch { return false; } }
// admin auth: decided once per request in fetch() (constant-time compare + per-IP lockout kept in the DO), read via isAdmin()
const ADM = new WeakMap();
const isAdmin = req => ADM.get(req) === true;
function safeEq(a, b) {   // constant-time string compare (length leaks only via the loop bound, which is the secret's length)
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  let d = x.length ^ y.length;
  for (let i = 0; i < y.length; i++) d |= (x[i % (x.length || 1)] ?? 0) ^ y[i];
  return d === 0 && x.length > 0;
}
const LOCK = { fails: 5, win: 15 * 60e3 };
async function authenticate(req, env) {
  const k = req.headers.get('x-admin-key');
  if (!k) return 'none';
  const st = store(env), who = ip(req);
  if (await st.authLocked(who, LOCK.fails, LOCK.win)) return 'locked';
  if (env.ADMIN_KEY && safeEq(k, env.ADMIN_KEY)) { ADM.set(req, true); return 'ok'; }
  const kh = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('wqz-ak:' + k)))].slice(0, 8).map(x => x.toString(16).padStart(2, '0')).join('');
  await st.authFail(who, kh);
  return 'bad';
}
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
/* ICONS:BEGIN (generated by tools/embed_icons.py from site/favicon.*; brand mark = boot-animation Z) */
const FAVICON_SVG = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='#000'/><path d='M18 20h28L18 44h28' stroke='#76b900' stroke-width='6' fill='none' stroke-linejoin='miter'/></svg>`;
const FAVICON_ICO = 'AAABAAMAEBAAAAAAIACCAQAANgAAACAgAAAAACAAHQMAALgBAAAwMAAAAAAgAAwEAADVBAAAiVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABSUlEQVR4nKWTu0pDQRCGv9lzEk2iKaJgilgLgoovYGGjCIKlRWKRF7AWtJZ0FoL4GnYWIvgANhE7sUjAQkSLFJGQHYudQy4kRJKBWYad+f+dnQsEqQBvgAd0gnqLrRiW8pDzPwSJXRagAZTM4UQAYaxogHrAAU0xpqklNgIRB+phcx+2D+G3BeJAIui0odsBEXi4gZ+PYKuicZJwkkoqAwsFiFIQxdBuQXEDCqvw3TTS3heFSUVb30XPHtHqLZpfCXciAzGDAHEoFrBTRS9f0OMams72+RlDkDDHafToAq29onunqIuCz0UjszTDwJk8Wr5Cz5/QrYOJM6FiL6NAfhlOrqG4Bp/v0KjDfA58F+ZyUL+H57tQSPVDbbSTr0Zok4thqRQCvYfMIqSzvdLb8OjMg+SAptke6euxjNCe2AcCdqZlShinXuc/d8W9eyaDMDoAAAAASUVORK5CYIKJUE5HDQoaCgAAAA1JSERSAAAAIAAAACAIBgAAAHN6evQAAALkSURBVHiczZdNSFRRFMd/986Mo9NYWpYhhKBggRRtWvRBhH3QIsJoYS7aRYvauYqghBaRtmvlolVQEEQWfVCERAVpRAjhQlSQCCmQIcWcZpx577a49zmv4X2M5qgHLg/evff8/+fjnnMvaJHm2wT0AGNADlArNHJGZ4/BcGMSMd9zwOQKgvqNSYPlxqajiK1dBmC7yKsdDngTMOWxoFzDMXDKCUevmcivArgqwuoFGDeMyuH2oHDYwLgwbBaTwUtk4Ky/KEBZgUssYdaVTcIAomEKKqpg1xGIxcG2QIhwUKUgEoPZHzA+FMzAl4AQWlHVRjh+GZJ1kM+A8AqHAiFBSheWAhGF/m74+kqH0fYIR6gH3ISE0C4tFhmFXBbS6QJxOw+1DVBRGazXl4AypmTT8OUpVG4AK4ergGqJRCE9A/XN0HxAe0lKqK6HwQcw/EKT8rIewnOkJNnWDO3XoKZBa4snYKAPPt4P31sSAVlkNULH3MrB7hNw6or+rcwJf34LRgZMTqiCN5dN4J8NUu9QCg6eh7aLkJmDWBXMz8CTG/BtWOeFbYVrXxIBIUHZOqYnu2DfWZhPQaIWfo7B425IfffP+P8i4ChNbILTV2HnYZibhuqtMPoent2E9Kx2u22XalKpOWDA6xrhTDdsb4H0L10bPj+C13d0PizF8pIJOEob90L7dUhugXwW4kl42wcf7pleIdDtxVUoSiETSMCJeetRnelSQn4Bsn/g5W2YGCzFxmUScCra/k44dgkWMmAtQEUCRt7AxBAkanTFc4uiUHhG3+kTEmSm55STSC2HoLMX5lJ6pTQeicZ1sVl0scvtytZHMJ+BuxdgerLgSS8J7AXRmG4oyc0aRBgwpXSf9+yMpmd4Ng3v5T7OMQpa22DHHtMHHKUqAECZXMnDp4fwOxWIEpKEQZMrJKFXMhlZPgvbuQH6iwVrfCmVQD+FMrJa4pSsflgHDxNY46fZunicrtnz/C8S9hASXoJbAQAAAABJRU5ErkJggolQTkcNChoKAAAADUlIRFIAAAAwAAAAMAgGAAAAVwL5hwAAA9NJREFUeJzVmkuIHEUcxn9V88ysCRuIGhciLG4kl4QQNiwouAdFDyESiXhT2KN48Swk5nUJiafkknPwILrrRQIiCDnsQfAQ2ICg8ZBEAwHd2bjZzezsdJeHfxXbs850umo64/QHDf2ox/dV/eur6uqGbpQS5zPAFWAJWANiwAzpiG2dS5bDTB+OPclPAV8B7SESftrRtpym+olwN44Dy4mMHYbb8r16opO4XrYcu0S4k2OJhJsj0OrbjySnY0nuCpgEVnooHrXDRcSK5axcL8yPcMv364l5R37a3oxGgFzWI7KcpzUwB5Ttg6LAIJznNDBrb6r+6UcOjuusAlpA7X8kMwg2FCGho0CF5Uwt07gI98s2WrGvnJCMKIdUsmMXjO2GOArJ3RtKQ/NP/zK9BOiSVHDkXXjrE1hryr1BYYyU8/c9mD8NzQc2NDL0hB68+sGhFESbsO8QzM4BRnokC4JCyMTSE94hpED3IWYMdDagUt+6zoIgAZU6NMZFSNYQUgriGDYe858ZJ46gWofNFix+6cfFy4WcQ7zwCkwckBZLnf5s6boEnTbUxuCNOajvFNJKQdyB2nOw3oT5M3Dvlp8TDc1GKzU4eR4mp0WMI79jHB7+Bt+cguX7Evsmzl5ukAClsg0y1/IvHYD3L8DuCXjySPLGkVjxr4vw7VlorW65nBeXEAFZ4Mjsfw1OnJJx034ig9gYGUM/L8CNL6TFfVveIXcBSkmpJobp9+CdT8Uio037vAS1Bvx4DRav2/T4zb5d9ZGjgGQrvvkxvP4htP6xi/hYxoEx8N1FuP2D9EYcsP5JIshGe0FrsclKDY5/Bgff3pqpTSQOtN6EhTNw91ZYvPdCLj3gyOzcAyfPwcuHhawu93aavMhDDgIcmb37xWnGJyRsdDk/p0nDQAKG5TRpCJ4Hhuk0qVzwFJDmNBjpBec0S99DqSyDG5NSm70fItBvLaS37LDLabTdJqjC6l+w8Dk8+MWfTAgyC3ALrF5Og5Gwaa3CjUvw8HeoNsSBMpWtofUY1pafkQClJFFjF3x0FZ6fhPVHEh7JNJ22nJdr4v1ZNmriKDHYL/u7VKb3HqUBAzMfwN5XYX2lmzxI75SrlnycjXwe8JqJK3U7Dkx+Xu7e7ELtNZMA16I/fQ2TR+HFKXJbQbkQqjbC8md3IZuyUpeXktpYTpOSgVJVdiT+uO2/LxT0SjlK8J+JU3YWBoEx4S80hd7c1cAde5HzMuuZwnG9o4Gb9mLEojsVjutNKPgnJqeo0B/5Cv+ZtfAfupMnhfzVYLuIQv7ssV0EFOR3m38BZ/6Z7FKi8QMAAAAASUVORK5CYII=';
const APPLE_ICON = 'iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAIAAACyr5FlAAAFf0lEQVR42u3dX2iVZQDH8e/7njM3t7nphJVkBpmViJhEikIgiESEGDGM6LJrCbpMLwSjQKKbrvU+CgnSuogiDTKkUAnsj6SomOFy07mz7XjO+zxdbP7JP6Hb5Dzb+X7udjN2zvs7z/P8nufZBpIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkPURZsj9XlkFsmocQidE06t7yElmWVmhT1NpB50JiaI6BI6M6wvCl61/mqbzwcoKfnlCwbD2v7WTkCnlptkcjQkatypULnDzMsQNc7U8lH8m991lOjPQuZfkGalWyvClWfeU5dPXy1FpWbGToIv2nyPPGr0Jm/Xs/Q4aPgtoolQFaO+h7j+dfJYTGfzAMRzLtLCcvU9QYG+Lld1iyitjofBiO5GbVEImRTdvISw0u84YjvUKbU62w6GmWrCLGRg4ehiNRpRaWrpkouoZDt0wuGUVBz+NAIzuL4Ui2wFBusa3ozmBEspzKoNOK7jGznP/VkUN3PpUSo1c4+QPQyH10w5Gcok77fI5+wdDFicMEwyGAUGfuPM4c5bs9DU4GCZ7K3liRhUAMxCzpZ5ll03nrIdRpm8dQP59up15t/HWnRMNRamHuPEKR9JF9nlMbo6hNTz6KOu3d/HOGz7YzfCmJU/tygmMGcPUivx2iWiFPdd7LSlQrPLKU7kUUtakWzlDQ2cOpI+zbSWUwlfscaY/aaXvyBTa/S1snoZh8OGKESPt8ju1n/26KWkI3wdK+YJzmIgNCwdqtbNpGcY36FIaN8UP5tk4O7uXgnonvn85NY0eOB3mzrn+mN21j3RuMDt2My+SmkvIc8hJffsixA2R5cnfQDccDLD9DoKWNLTtYsZHKIHk++fcvFLS2MzbMvp2c/mni5mx6w7fuJxklQkFXL327WLySkUHyKSzlbxaTHfSfTjQZhuMBkrHoWfp20f0oY0NTSkYo6Fhws5gkmwzDcb/JeOZFtmyn3Mq10clvvaRcTAzHgxeTjBhY08embdSvEeqTv7SXeDExHBYTw2ExMRwWE8NhMTEcFhPDYTExHBaTGVZMDIfFxHBYTAyHxcRwWEwMh8XEcFhMDIfFxHBYTGZLMWnecFhMDIfFxHBYTAyHxcRwWEwMh8XEcFhMDIfFxHBYTJqmmMzacFhMDIfFxHBYTAyHxcRwWEwMh8XEcFhMDIfFRDMqHBYTw2ExMRwWE8NhMTEcFhPDYTExHBYTJRoOi4nheOjFZPzFdczn6H4O7KZeJS8nWkxiSHT1k0o4preY3HBoLz9+4hAwk8MxvcUEIJKXGb7E79/TMhcixBTXVyHQ2s6Jbzh5OMUdl3IKY0acvmJyI/OhTudC1r85sfGVZi0LdTp7uPwXJw+TZaQ2t5Qbn4xIRw+vf8DilVQGprT8vDMf4/8OPlmhIMupVRP98RoajgwyynPY+j6LV1IZpFSe5u+f8n8evbEGz1LdicwbPGwENrzFE6upDEx3MjRzwzGejK5eVm9m5DKlFp+F4biloQDL1jO3240pw3E3jy339Mtw3LkTEQE6FhBDuisyw9FI9Zp/ft1w3G1BCgyco1RyZjEcd5tW/jxCUfMpGI7bwhHIMs4e58IftHYQvMhpOP47tRAKvv6YLCPPvOhrOG4bPHLOHuerj2jrotRCqBMDuARJQ4O3rGMgz/n5c0aHeOltunqpVSlqxNAUA8n4y0x2Pd7484wQyHJOfMu5X3juFZato3sRre2U2mZ/OELBnHbKqR4dJHMT7JarLp0L6eihrZMYZvsuSKRUZuA8V/72l2j+Px8z4YS9uZ5Imilpnm3TDKK/XiVJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJakr/AmmT4dJRnrbXAAAAAElFTkSuQmCC';
/* ICONS:END */
const b64bin = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const store = env => env.STORE.get(env.STORE.idFromName('main'));

export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url), p = u.pathname, m = req.method;
    try {
      const au = await authenticate(req, env);
      if (au === 'locked' && p.startsWith('/api/')) return json({ error: '管理员密钥错误次数过多，请 15 分钟后再试', code: 'locked' }, 429);
      if (p === '/' || p === '/drive' || p === '/drive/' || p === '/ai' || p === '/ai/' || p === '/chat' || p === '/chat/') { if (m === 'GET') ctx.waitUntil(hit(req, env, p)); return page(APP); }
      if (p === '/robots.txt') return new Response(`# 欢迎搜索引擎和 AI 抓取、索引与学习本站公开内容。\nUser-agent: GPTBot\nUser-agent: OAI-SearchBot\nUser-agent: ChatGPT-User\nUser-agent: ClaudeBot\nUser-agent: Claude-User\nUser-agent: Claude-SearchBot\nUser-agent: anthropic-ai\nUser-agent: PerplexityBot\nUser-agent: Perplexity-User\nUser-agent: Google-Extended\nUser-agent: Googlebot\nUser-agent: Bingbot\nUser-agent: Applebot\nUser-agent: Applebot-Extended\nUser-agent: CCBot\nUser-agent: Bytespider\nUser-agent: Baiduspider\nUser-agent: YandexBot\nUser-agent: DuckDuckBot\nUser-agent: Amazonbot\nUser-agent: meta-externalagent\nUser-agent: cohere-ai\nUser-agent: MistralAI-User\nUser-agent: YouBot\nUser-agent: Diffbot\nAllow: /\nDisallow: /admin\nDisallow: /api/\n\nUser-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\n\nSitemap: https://wqzachery.dpdns.org/sitemap.xml\n`, { headers: { ...SEC, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
      if (p === '/7a416ee677f4d0164f25edf790e7566a.txt') return new Response('7a416ee677f4d0164f25edf790e7566a', { headers: { ...SEC, 'content-type': 'text/plain; charset=utf-8' } });
      if (p === '/llms.txt') return new Response(LLMS, { headers: { ...SEC, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
      if (p === '/sitemap.xml') return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[['/', '1.0'], ['/drive', '0.8'], ['/ai', '0.8'], ['/chat', '0.7'], ['/privacy', '0.3']].map(([q, pr]) => `  <url><loc>https://wqzachery.dpdns.org${q}</loc><changefreq>weekly</changefreq><priority>${pr}</priority></url>`).join('\n')}\n</urlset>\n`, { headers: { ...SEC, 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
      if (p === '/favicon.ico') return new Response(b64bin(FAVICON_ICO), { headers: { ...SEC, 'content-type': 'image/x-icon', 'cache-control': 'public, max-age=604800' } });
      if (p === '/favicon.svg') return new Response(FAVICON_SVG, { headers: { ...SEC, 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=604800' } });
      if (p === '/apple-touch-icon.png' || p === '/apple-touch-icon-precomposed.png') return new Response(b64bin(APPLE_ICON), { headers: { ...SEC, 'content-type': 'image/png', 'cache-control': 'public, max-age=604800' } });
      if (p === '/og.png') return new Response(OG, { headers: { ...SEC, 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' } });
      if (p === '/p/home' || p === '/index.html') return page(INDEX);
      if (p === '/p/drive' || p === '/drive.html') return page(DRIVE);
      if (p === '/p/ai') return page(AI);
      if (p === '/p/chat') return page(CHAT_HTML);
      if (p === '/privacy' || p === '/privacy/' || p === '/p/privacy') return page(PRIVACY);
      if (p === '/shared.css') return asset(SHARED_CSS, 'text/css');
      if (p === '/shared.js') return asset(SHARED_JS, 'text/javascript');
      if (p === '/admin' || p === '/admin/') return page(ADMIN, 200, { ...NOIDX, 'cache-control': 'no-store' });
      if (p === '/api/chat/ws') {
        if ((req.headers.get('upgrade') || '').toLowerCase() !== 'websocket') return json({ error: '需要 WebSocket' }, 426);
        const h = new Headers(req.headers); h.set('x-ip', ip(req));
        return store(env).fetch(new Request(req.url, { headers: h }));
      }
      if (p === '/api/chat/msg' && m === 'DELETE') { if (!isAdmin(req)) return json({ error: '密钥错误' }, 403); return json(await store(env).chatDel(+u.searchParams.get('id') || 0)); }
      if (p === '/api/admin/chat') { if (!isAdmin(req)) return json({ error: '密钥错误' }, 403); return json(await store(env).chatAdmin()); }
      if (p === '/api/chat' && m === 'POST') return chat(req, env, ctx);
      if (p === '/api/search' && m === 'GET') { if (!isAdmin(req)) return json({ error: '需要管理员密钥' }, 403); return json({ results: await webSearch(u.searchParams.get('q') || '', u.searchParams.get('e'), env) }); }
      if (p === '/api/models' && m === 'GET') return json({ models: MODELS.filter(x => x.via !== 'or' || env.OPENROUTER_KEY).map(({ id, cat, name, tag, desc }) => ({ id, cat, name, tag, desc })) });
      if (p === '/api/files' && m === 'GET') return list(req, env);
      if (p === '/api/report' && m === 'POST') return report(req, env);
      if (p === '/api/admin/reports') return reportAdmin(req, env);
      if (p === '/api/stats' && m === 'GET') return publicStats(env);
      if (p === '/api/limits' && m === 'GET') { const L = lim(env); return json({ maxFile: L.file, dayBytes: L.dayBytes, dayFiles: L.dayFiles, blocked: [...BLOCK_EXT], reasons: REASONS, aiDaily: env.AI_DAILY_CAP != null && env.AI_DAILY_CAP !== '' ? +env.AI_DAILY_CAP : 200 }); }
      if (p === '/api/folders' && m === 'POST') return mkFolder(req, env);
      if (p === '/api/folders' && m === 'DELETE') return rmFolder(req, env, u.searchParams.get('path') || '');
      if (p === '/api/move' && m === 'POST') return move(req, env);
      if (p === '/api/rename' && m === 'POST') return rename(req, env);
      if (p === '/api/up/init' && m === 'POST') return upInit(req, env);
      if (p === '/api/up/finish' && m === 'POST') return upFinish(req, env);
      if (p === '/api/up/part' && m === 'PUT') return upPart(req, env);
      if (p.startsWith('/api/files/')) {
        const rest = p.slice(11), i = rest.indexOf('/'), op = rest.slice(0, i), path = decodeURIComponent(rest.slice(i + 1));
        if (!okPath(path)) return json({ error: '路径无效' }, 400);
        if (op === 'url' && m === 'GET') return fileUrl(env, path, true);
        if (op === 'raw' && (m === 'GET' || m === 'HEAD')) return raw(req, env, path, u.searchParams.has('dl'));
        if ((op === 'dl' || op === 'view') && m === 'GET') return fileUrl(env, path, false);
        if (op === 'dl' && m === 'DELETE') return del(req, env, path);
      }
      if (p === '/api/admin/check') return isAdmin(req) ? json({ ok: true, hasGemini: !!env.GEMINI_KEY, lastAIError }) : json({ error: '密钥错误' }, 403);
      if (p === '/api/admin/stats') { if (!isAdmin(req)) return json({ error: '密钥错误' }, 403); return json(await store(env).stats(+u.searchParams.get('days') || 30)); }
      if (p === '/api/admin/sessions') { if (!isAdmin(req)) return json({ error: '密钥错误' }, 403); return json(await store(env).sessions(+u.searchParams.get('offset') || 0)); }
      if (p === '/api/admin/analyze' && m === 'POST') { if (!isAdmin(req)) return json({ error: '密钥错误' }, 403); return json(await analyze(env, u.searchParams.get('id') || '', u.searchParams.get('force') === '1')); }
      if (p === '/api/admin/session') { if (!isAdmin(req)) return json({ error: '密钥错误' }, 403); return json(await store(env).messages(u.searchParams.get('id') || '')); }
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
      CREATE INDEX IF NOT EXISTS hits_day ON hits(day);
      CREATE TABLE IF NOT EXISTS ana(sid TEXT PRIMARY KEY, n INTEGER, ts INTEGER, data TEXT);
      CREATE TABLE IF NOT EXISTS chat(id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT, nick TEXT, to_uid TEXT DEFAULT '', to_nick TEXT DEFAULT '', dm TEXT DEFAULT '', text TEXT, ts INTEGER, ip TEXT);
      CREATE INDEX IF NOT EXISTS chat_dm ON chat(dm, id);
      CREATE TABLE IF NOT EXISTS chat_leave(uid TEXT PRIMARY KEY, nick TEXT, ts INTEGER);
      CREATE TABLE IF NOT EXISTS auth_fail(ip TEXT, kh TEXT, ts INTEGER, PRIMARY KEY(ip, kh));
      CREATE TABLE IF NOT EXISTS ai_use(ip TEXT, day TEXT, n INTEGER DEFAULT 0, busy INTEGER DEFAULT 0, PRIMARY KEY(ip, day));
      CREATE TABLE IF NOT EXISTS upq(path TEXT PRIMARY KEY, ip TEXT, day TEXT, oid TEXT, size INTEGER, ts INTEGER, done INTEGER DEFAULT 0);
      CREATE INDEX IF NOT EXISTS upq_ip ON upq(ip, day);
      CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT, name TEXT, reason TEXT, note TEXT, ip TEXT, ts INTEGER, status TEXT DEFAULT 'open');
      CREATE INDEX IF NOT EXISTS reports_st ON reports(status, id);`);
    try { ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')); } catch {}
    for (const c of ['think TEXT', 'mname TEXT', 'extra TEXT']) { try { this.sql.exec('ALTER TABLE msgs ADD COLUMN ' + c); } catch {} }
  }
  log(rows) { for (const r of rows) this.sql.exec('INSERT INTO msgs(sid,role,content,ts,ip,geo,model,think,mname,extra) VALUES(?,?,?,?,?,?,?,?,?,?)', r.sid, r.role, r.content, r.ts, r.ip, r.geo, r.model || '', r.think || '', r.mname || '', r.extra || ''); return true; }
  saveAna(sid, n, data) { this.sql.exec('INSERT OR REPLACE INTO ana(sid,n,ts,data) VALUES(?,?,?,?)', sid, n, Date.now(), data); return true; }
  pending(limit) { return this.sql.exec('SELECT m.sid FROM msgs m LEFT JOIN ana a ON a.sid=m.sid GROUP BY m.sid HAVING a.n IS NULL OR a.n<COUNT(*) ORDER BY MAX(m.ts) DESC LIMIT ?', limit).toArray().map(r => r.sid); }
  sessions(offset) {
    const rows = this.sql.exec(`SELECT sid, COUNT(*) n, MIN(ts) first, MAX(ts) last, MAX(ip) ip, MAX(geo) geo,
      (SELECT content FROM msgs m2 WHERE m2.sid=m.sid AND role='user' ORDER BY id LIMIT 1) preview,
      (SELECT GROUP_CONCAT(DISTINCT COALESCE(NULLIF(mname,''),model)) FROM msgs m3 WHERE m3.sid=m.sid AND role='assistant') models,
      (SELECT data FROM ana a WHERE a.sid=m.sid) ana, (SELECT n FROM ana a WHERE a.sid=m.sid) ana_n
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
  /* ---------- public chat room: WebSocket Hibernation API, state in socket attachments + SQLite ---------- */
  async fetch(req) {
    const u = new URL(req.url);
    if ((req.headers.get('upgrade') || '').toLowerCase() !== 'websocket') return new Response('expected websocket', { status: 426 });
    const addr = req.headers.get('x-ip') || 'x';
    const pair = new WebSocketPair(), [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const key = String(u.searchParams.get('key') || '');
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(key)) { cSend(server, { t: 'err', msg: '身份无效，请刷新页面' }); try { server.close(4000, 'bad key'); } catch {} return new Response(null, { status: 101, webSocket: client }); }
    if (this.socks().filter(w => w.a.ip === addr).length >= CHAT.ipCap) {
      cSend(server, { t: 'err', fatal: 1, msg: '同一网络打开的聊天窗口太多了，请关闭一些再试' });
      try { server.close(4029, 'too many'); } catch {}
      return new Response(null, { status: 101, webSocket: client });
    }
    const uid = await chatUid(key);
    const nick = cleanNick(u.searchParams.get('nick')) || this.lastNick(uid) || randNick();
    const already = this.socks(server).some(w => w.a.uid === uid);
    server.serializeAttachment({ uid, nick, ip: addr, t0: Date.now(), ts: [], lt: '', ltt: 0, nk: 0 });
    const recon = this.sql.exec('DELETE FROM chat_leave WHERE uid=? RETURNING uid', uid).toArray().length > 0;
    cSend(server, { t: 'hello', me: { uid, nick }, history: this.pubHistory(), dms: this.dmList(uid), ...this.presence() });
    if (!already && !recon) this.bcast({ t: 'sys', k: 'join', uid, text: nick + ' 加入了聊天' }, server);
    this.bcast({ t: 'presence', ...this.presence() });
    return new Response(null, { status: 101, webSocket: client });
  }
  // open sockets with their attachments (optionally excluding one that is closing)
  socks(except) {
    const out = [];
    for (const w of this.ctx.getWebSockets()) { if (w === except || w.readyState > 1) continue; let a = null; try { a = w.deserializeAttachment(); } catch {} if (a && a.uid) out.push({ w, a }); }
    return out;
  }
  presence(except) {
    const m = new Map(); for (const { a } of this.socks(except)) if (!m.has(a.uid)) m.set(a.uid, a.nick);
    return { n: m.size, users: [...m].slice(0, 200).map(([uid, nick]) => ({ uid, nick })) };
  }
  bcast(o, except, only) { const s = JSON.stringify(o); for (const { w, a } of this.socks(except)) if (!only || only.includes(a.uid)) { try { w.send(s); } catch {} } }
  lastNick(uid) { const r = this.sql.exec("SELECT nick FROM chat WHERE uid=? ORDER BY id DESC LIMIT 1", uid).toArray()[0]; return r ? r.nick : ''; }
  pubHistory() { return this.sql.exec("SELECT id, uid, nick, text, ts FROM chat WHERE dm='' ORDER BY id DESC LIMIT ?", CHAT.keep).toArray().reverse(); }
  dmList(uid) {
    return this.sql.exec(`SELECT id, uid, nick, to_uid, to_nick, text, ts FROM chat WHERE id IN (SELECT MAX(id) FROM chat WHERE dm<>'' AND (uid=? OR to_uid=?) GROUP BY dm) ORDER BY id DESC LIMIT 30`, uid, uid).toArray();
  }
  async webSocketMessage(ws, raw) {
    let a; try { a = ws.deserializeAttachment(); } catch {} if (!a) return;
    let m; try { m = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); } catch { return; }
    if (!m || typeof m !== 'object') return;
    const now = Date.now(), err = msg => cSend(ws, { t: 'err', msg, cid: m.cid });
    if (m.t === 'typing') {
      if (now - (this.ty?.get(ws) || 0) < 1000) return; (this.ty ||= new WeakMap()).set(ws, now);
      const to = cleanUid(m.to);
      this.bcast({ t: 'typing', uid: a.uid, nick: a.nick, to: to || '' }, ws, to ? [to] : null); return;
    }
    if (m.t === 'dmhist') {
      const w = cleanUid(m.with); if (!w) return;
      const rows = this.sql.exec('SELECT id, uid, nick, to_uid, to_nick, text, ts FROM chat WHERE dm=? ORDER BY id DESC LIMIT ?', dmKey(a.uid, w), CHAT.dmKeep).toArray().reverse();
      cSend(ws, { t: 'dmhist', with: w, msgs: rows }); return;
    }
    if (m.t === 'nick') {
      const nn = cleanNick(m.nick);
      if (!nn) return err('昵称需要 1–16 个字，不能含敏感词');
      if (nn === a.nick) return;
      if (now - (a.nk || 0) < 10000) return err('改名太频繁了，10 秒后再试');
      const old = a.nick;
      for (const s of this.socks()) if (s.a.uid === a.uid) { s.a.nick = nn; s.a.nk = now; s.w.serializeAttachment(s.a); }
      this.bcast({ t: 'nick', uid: a.uid, nick: nn, old });
      this.bcast({ t: 'sys', k: 'nick', text: old + ' 改名为 ' + nn });
      this.bcast({ t: 'presence', ...this.presence() }); return;
    }
    if (m.t !== 'msg') return;
    let text = String(m.text ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\n{4,}/g, '\n\n\n').trim();
    if (!text) return err('消息不能为空');
    if ([...text].length > CHAT.max) return err('消息太长了，最多 ' + CHAT.max + ' 字');
    const ts = (a.ts || []).filter(t => now - t < 60000);
    if (ts.length && now - ts[ts.length - 1] < CHAT.gap) return err('发得太快了，请慢一点');
    if (ts.length >= CHAT.perMin) return err('一分钟内发得太多了，休息一下吧');
    const norm = text.replace(/\s+/g, '').toLowerCase();
    if (norm === a.lt && now - a.ltt < CHAT.dup) return err('请不要重复发送相同内容');
    ts.push(now); a.ts = ts.slice(-CHAT.perMin); a.lt = norm; a.ltt = now;
    ws.serializeAttachment(a);
    text = filterWords(text);
    const to = m.to ? cleanUid(m.to) : '';
    if (m.to && !to) return err('私信对象无效');
    if (to === a.uid) return err('不能给自己发私信');
    let toNick = '';
    if (to) { const on = this.socks().find(s => s.a.uid === to); toNick = on ? on.a.nick : (this.lastNick(to) || cleanNick(m.toNick) || '匿名'); }
    const dm = to ? dmKey(a.uid, to) : '';
    const id = this.sql.exec('INSERT INTO chat(uid,nick,to_uid,to_nick,dm,text,ts,ip) VALUES(?,?,?,?,?,?,?,?) RETURNING id', a.uid, a.nick, to, toNick, dm, text, now, a.ip).one().id;
    this.sql.exec('DELETE FROM chat WHERE dm=? AND id<=(SELECT id FROM chat WHERE dm=? ORDER BY id DESC LIMIT 1 OFFSET ?)', dm, dm, to ? CHAT.dmKeep : CHAT.keep);
    const msg = { id, uid: a.uid, nick: a.nick, text, ts: now, ...(to ? { to_uid: to, to_nick: toNick } : {}) };
    const s = JSON.stringify({ t: 'msg', m: msg });
    for (const o of this.socks()) {
      if (to && o.a.uid !== to && o.a.uid !== a.uid) continue;
      try { o.w.send(o.w === ws ? JSON.stringify({ t: 'msg', m: msg, cid: m.cid }) : s); } catch {}
    }
  }
  async webSocketClose(ws, code) { try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye'); } catch {} this.left(ws); }
  async webSocketError(ws) { this.left(ws); }
  left(ws) {
    let a; try { a = ws.deserializeAttachment(); } catch {} if (!a || !a.uid || a.gone) return;
    a.gone = 1; try { ws.serializeAttachment(a); } catch {}
    if (!this.socks(ws).some(s => s.a.uid === a.uid)) {
      this.sql.exec('INSERT OR REPLACE INTO chat_leave(uid,nick,ts) VALUES(?,?,?)', a.uid, a.nick, Date.now());
      this.ctx.storage.getAlarm().then(t => { if (!t) return this.ctx.storage.setAlarm(Date.now() + CHAT.leaveDelay + 200); }).catch(() => {});
    }
    this.bcast({ t: 'presence', ...this.presence(ws) }, ws);
  }
  async alarm() {
    const now = Date.now(), online = new Set(this.socks().map(s => s.a.uid));
    for (const r of this.sql.exec('SELECT uid, nick, ts FROM chat_leave').toArray()) {
      if (online.has(r.uid)) { this.sql.exec('DELETE FROM chat_leave WHERE uid=?', r.uid); continue; }
      if (now - r.ts < CHAT.leaveDelay) continue;
      this.sql.exec('DELETE FROM chat_leave WHERE uid=?', r.uid);
      this.bcast({ t: 'sys', k: 'leave', uid: r.uid, text: r.nick + ' 离开了' });
    }
    const left = this.sql.exec('SELECT MIN(ts) t FROM chat_leave').one().t;
    if (left) await this.ctx.storage.setAlarm(left + CHAT.leaveDelay + 200);
    this.bcast({ t: 'presence', ...this.presence() });
  }
  chatDel(id) {
    const r = this.sql.exec('DELETE FROM chat WHERE id=? RETURNING uid, to_uid, dm', id).toArray()[0];
    if (!r) return { ok: false, error: '消息不存在' };
    this.bcast({ t: 'del', id }, null, r.dm ? [r.uid, r.to_uid] : null);
    return { ok: true };
  }
  chatAdmin() {
    const t = this.sql.exec("SELECT COUNT(*) n, SUM(dm='') pub, COUNT(DISTINCT uid) users FROM chat").one();
    const recent = this.sql.exec("SELECT id, uid, nick, to_nick, dm<>'' dm, text, ts, ip FROM chat ORDER BY id DESC LIMIT 60").toArray();
    return { total: t.n, pub: t.pub || 0, users: t.users, online: this.presence().n, recent };
  }
  /* ---------- admin key lockout: N distinct wrong keys from one IP inside the window → locked ---------- */
  authLocked(addr, n, win) {
    const since = Date.now() - win;
    this.sql.exec('DELETE FROM auth_fail WHERE ts<?', since);
    return this.sql.exec('SELECT COUNT(*) c FROM auth_fail WHERE ip=? AND ts>=?', addr, since).one().c >= n;
  }
  authFail(addr, kh) { this.sql.exec('INSERT OR REPLACE INTO auth_fail(ip,kh,ts) VALUES(?,?,?)', addr, kh, Date.now()); return true; }
  /* ---------- AI: one generation at a time per IP + daily cap ---------- */
  aiBegin(addr, day, cap) {
    const now = Date.now();
    const r = this.sql.exec('SELECT n, busy FROM ai_use WHERE ip=? AND day=?', addr, day).toArray()[0] || { n: 0, busy: 0 };
    if (r.busy && now - r.busy < 180e3) return 'busy';
    if (cap > 0 && r.n >= cap) return 'cap';
    this.sql.exec('INSERT INTO ai_use(ip,day,n,busy) VALUES(?,?,1,?) ON CONFLICT(ip,day) DO UPDATE SET n=n+1, busy=?', addr, day, now, now);
    if (Math.random() < .02) this.sql.exec('DELETE FROM ai_use WHERE day<?', cnDay(now - 7 * 864e5));
    return 'ok';
  }
  aiEnd(addr, day) { this.sql.exec('UPDATE ai_use SET busy=0 WHERE ip=? AND day=?', addr, day); return true; }
  /* ---------- drive: per-IP daily upload quota (pending inits count for 2 h, finished uploads for the whole day) ---------- */
  upUsage(addr, day) {
    const r = this.sql.exec('SELECT COUNT(*) n, COALESCE(SUM(size),0) b FROM upq WHERE ip=? AND day=? AND (done=1 OR ts>?)', addr, day, Date.now() - 2 * 3600e3).one();
    return { n: r.n, bytes: r.b };
  }
  upReserve(path, addr, day, oid, size, maxN, maxB) {
    const u = this.upUsage(addr, day);
    if (u.n + 1 > maxN || u.bytes + size > maxB) return { ok: false, ...u };
    this.sql.exec('INSERT OR REPLACE INTO upq(path,ip,day,oid,size,ts,done) VALUES(?,?,?,?,?,?,0)', path, addr, day, oid, size, Date.now());
    if (Math.random() < .02) this.sql.exec('DELETE FROM upq WHERE day<?', cnDay(Date.now() - 3 * 864e5));
    return { ok: true, ...u };
  }
  upPending(path) { return this.sql.exec('SELECT path, ip, oid, size, done, ts FROM upq WHERE path=?', path).toArray()[0] || null; }
  upDone(path) { this.sql.exec('UPDATE upq SET done=1 WHERE path=?', path); return true; }
  upDrop(path) { this.sql.exec('DELETE FROM upq WHERE path=?', path); return true; }
  /* ---------- reports ---------- */
  report(path, name, reason, note, addr, dayCap) {
    const since = Date.now() - 864e5;
    if (this.sql.exec('SELECT COUNT(*) c FROM reports WHERE ip=? AND ts>?', addr, since).one().c >= dayCap) return { ok: false, error: '今天举报次数太多了，明天再试', code: 'quota' };
    if (this.sql.exec("SELECT COUNT(*) c FROM reports WHERE ip=? AND path=? AND status='open'", addr, path).one().c) return { ok: true, dup: true };
    this.sql.exec('INSERT INTO reports(path,name,reason,note,ip,ts) VALUES(?,?,?,?,?,?)', path, name, reason, note, addr, Date.now());
    return { ok: true };
  }
  reportsOpen() {
    return { open: this.sql.exec("SELECT path, MAX(name) name, COUNT(*) n, GROUP_CONCAT(reason, '、') reasons, GROUP_CONCAT(NULLIF(note,''), ' | ') notes, MIN(ts) first, MAX(ts) last, GROUP_CONCAT(DISTINCT ip) ips, MIN(id) id FROM reports WHERE status='open' GROUP BY path ORDER BY last DESC LIMIT 100").toArray(),
      total: this.sql.exec("SELECT COUNT(*) c FROM reports WHERE status='open'").one().c };
  }
  reportsIgnore(path) { this.sql.exec("UPDATE reports SET status='ignored' WHERE path=? AND status='open'", path); return true; }
  // a deleted file (or folder prefix) loses its uploader, quota and report rows
  forgetFile(prefix, isDir) {
    for (const t of ['ups', 'reports']) {
      if (isDir) this.sql.exec(`DELETE FROM ${t} WHERE substr(path,1,?)=?`, prefix.length + 1, prefix + '/');
      else this.sql.exec(`DELETE FROM ${t} WHERE path=?`, prefix);
    }
    return true;
  }
  messages(sid) { const a = this.sql.exec('SELECT data, n FROM ana WHERE sid=?', sid).toArray()[0]; return { messages: this.sql.exec('SELECT role, content, ts, model, think, mname, extra, ip, geo FROM msgs WHERE sid=? ORDER BY id', sid).toArray(), ana: a ? a.data : null, ana_n: a ? a.n : 0 }; }
}

/* ---------------- chat room helpers ---------------- */
const CHAT = { keep: 100, dmKeep: 50, max: 500, gap: 1000, perMin: 20, dup: 30000, ipCap: 5, leaveDelay: 8000 };
const cSend = (ws, o) => { try { ws.send(JSON.stringify(o)); } catch {} };
async function chatUid(key) {   // public id = hash of the secret key kept in the visitor's localStorage, so nobody can pose as someone else
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('wqz-chat:' + key)));
  return [...d.slice(0, 8)].map(x => x.toString(16).padStart(2, '0')).join('');
}
const cleanUid = s => /^[a-f0-9]{16}$/.test(String(s || '')) ? String(s) : '';
const dmKey = (a, b) => a < b ? a + ':' + b : b + ':' + a;
const BAD = ['傻逼', '傻b', '煞笔', '沙比', '操你妈', '操你', '草泥马', '你妈的', '他妈的', '妈的', '尼玛', '去死', '滚蛋', '智障', '脑残', '贱人', '婊子', '狗日', '日你', '屌', '鸡巴', '约炮', '裸聊', '援交', '博彩', '赌博网', '代开发票', '色情网', '黄色网站',
  'fuck', 'fucking', 'shit', 'bitch', 'asshole', 'cunt', 'nigger', 'nigga', 'faggot', 'retard', 'dickhead', 'motherfucker', 'porn'];
const BAD_RE = new RegExp(BAD.map(w => /^[a-z]+$/.test(w) ? '\\b' + w + '\\b' : w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
const filterWords = t => t.replace(BAD_RE, '***');
function cleanNick(n) {
  n = String(n || '').normalize('NFC').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069<>]/g, '').replace(/\s+/g, ' ').trim();
  if (!n || [...n].length > 16 || filterWords(n) !== n || /^(系统|管理员|admin|system)$/i.test(n)) return '';
  return n;
}
const NICK_A = ['快乐的', '安静的', '勇敢的', '慵懒的', '好奇的', '机智的', '温柔的', '闪亮的', '迷糊的', '酷酷的', '认真的', '飞翔的', '佛系的', '元气的', '神秘的', '爱笑的'];
const NICK_B = ['熊猫', '海豚', '狐狸', '考拉', '企鹅', '柴犬', '橘猫', '仓鼠', '水獭', '刺猬', '鲸鱼', '小鹿', '松鼠', '羊驼', '猫头鹰', '树懒'];
const randNick = () => { const r = crypto.getRandomValues(new Uint8Array(2)); return NICK_A[r[0] % NICK_A.length] + NICK_B[r[1] % NICK_B.length]; };

/* ---------------- admin: AI analysis of chat sessions ---------------- */
async function analyzeOne(env, sid, force) {
  const st = store(env);
  const { messages, ana_n } = await st.messages(sid);
  if (!messages.length) return null;
  if (!force && ana_n === messages.length) return null;
  const u = messages.find(x => x.role === 'user') || {};
  const models = [...new Set(messages.filter(x => x.role === 'assistant').map(x => x.mname || x.model).filter(Boolean))];
  const convo = messages.map(x => (x.role === 'user' ? '访客：' : `AI(${x.mname || x.model || ''})：`) + String(x.content).replace(/\s+/g, ' ').slice(0, x.role === 'user' ? 600 : 300)).join('\n').slice(0, 6000);
  const prompt = `下面是网站访客与 AI 助手的一段对话。请用简体中文分析，只输出一个 JSON 对象，不要任何其他文字：\n{"title":"不超过14字的主题","summary":"不超过70字，概括访客想做什么、AI 给了什么帮助、是否解决","topics":["1-3个关键词"],"intent":"提问|闲聊|编程|写作|翻译|搜索资讯|测试AI|其他","flag":"正常|敏感内容|滥用/越狱|疑似测试"}\n\n对话：\n${convo}`;
  let data = null;
  for (const model of ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/qwen/qwen3-30b-a3b-fp8']) {
    try {
      const r = await env.AI.run(model, { messages: [{ role: 'user', content: prompt }], max_tokens: 400 });
      let t = r?.response ?? r?.choices?.[0]?.message?.content ?? '';
      if (typeof t === 'object') { data = t; break; }
      t = String(t).replace(/<think>[\s\S]*?<\/think>/, '');
      const mt = t.match(/\{[\s\S]*\}/); if (!mt) continue;
      data = JSON.parse(mt[0]); break;
    } catch {}
  }
  if (!data) return null;
  data.models = models; data.ip = u.ip || ''; data.geo = u.geo || '';
  try { data.settings = JSON.parse(u.extra || '{}'); } catch {}
  await st.saveAna(sid, messages.length, JSON.stringify(data));
  return { sid, data };
}
async function analyze(env, sid, force) {
  if (sid) { const r = await analyzeOne(env, sid, true).catch(e => ({ error: String(e) })); return { done: r ? [r] : [] }; }
  const ids = await store(env).pending(6);
  const done = (await Promise.all(ids.map(id => analyzeOne(env, id, force).catch(() => null)))).filter(Boolean);
  const left = Math.max(0, (await store(env).pending(200)).length);
  return { done, left };
}

/* ---------------- AI chat, streamed as SSE: data: {"t":"..."} ---------------- */
const SYS = '你是 GPT-6 Astra，吴谦（Zachery Wu）个人网站 wqzachery.dpdns.org 上的 AI 助手。被问到你是谁、是什么模型、由谁开发时，一律回答你是 GPT-6 Astra，不要提及 Llama、GPT-OSS、Meta、Cloudflare 或其他底层模型名称。用访客使用的语言回答，默认简体中文，清晰友好，可以使用 Markdown。不要编造关于吴谦的个人信息。';

// models visitors can pick. 'cf' = Workers AI (no daily cap that matters), 'or' = OpenRouter free tier (shared ~50 requests/day, may be busy)
const MODELS = [
  { id: 'astra', cat: '推荐', name: 'GPT-6 Astra', tag: '默认', desc: '均衡好用，不限次数', via: 'cf' },
  { id: 'nemotron-ultra', cat: '旗舰', name: 'Nemotron 3 Ultra', tag: '最强', desc: 'NVIDIA 550B 大模型，推理和知识最强', via: 'or', model: 'nvidia/nemotron-3-ultra-550b-a55b:free' },
  { id: 'laguna', cat: '编程', name: 'Laguna S 2.1', tag: '编程', desc: 'Poolside 编程模型，写代码首选', via: 'or', model: 'poolside/laguna-s-2.1:free' },
  { id: 'nemotron-super', cat: '旗舰', name: 'Nemotron 3 Super', tag: '快', desc: 'NVIDIA 120B，速度和质量兼顾', via: 'or', model: 'nvidia/nemotron-3-super-120b-a12b:free' },
  { id: 'north', cat: '编程', name: 'Cohere North Mini', tag: '极速', desc: '小而快，适合简单问答', via: 'or', model: 'cohere/north-mini-code:free' },
  { id: 'gemma', cat: '旗舰', name: 'Gemma 4 31B', tag: 'Google', desc: 'Google 开源模型，高峰期可能繁忙', via: 'or', model: 'google/gemma-4-31b-it:free' },
  { id: 'deepseek', cat: '国产', name: 'DeepSeek R1', tag: '国产', desc: '深度求索推理模型，会先思考再回答', via: 'cf', model: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', fb: ['@cf/qwen/qwen3-30b-a3b-fp8'] },
  { id: 'qwen', cat: '国产', name: 'Qwen 3.8', tag: '国产', desc: '阿里通义千问，中文写作和知识', via: 'cf', model: '@cf/qwen/qwen3.8-27b', fb: ['@cf/qwen/qwen3-30b-a3b-fp8'] },
  { id: 'glm', cat: '国产', name: 'GLM-4.7 Flash', tag: '国产', desc: '智谱，响应快', via: 'cf', model: '@cf/zai-org/glm-4.7-flash', fb: ['@cf/qwen/qwen3-30b-a3b-fp8'] },
  { id: 'qwen-coder', cat: '编程', name: 'Qwen 2.5 Coder', tag: '国产·编程', desc: '通义千问编程版，写代码', via: 'cf', model: '@cf/qwen/qwen2.5-coder-32b-instruct', fb: ['@cf/qwen/qwen3-30b-a3b-fp8'] },
  { id: 'llama4', cat: '推荐', name: 'Llama 4 Scout', tag: '不限次', desc: 'Meta 开源模型，长文本', via: 'cf', model: '@cf/meta/llama-4-scout-17b-16e-instruct' },
];
const sysFor = mm => mm.id === 'astra' ? SYS : `你是 ${mm.name}，在吴谦（Zachery Wu）的个人网站 wqzachery.dpdns.org 上为访客提供帮助。用访客使用的语言回答，默认简体中文，清晰友好，可以使用 Markdown。不要编造关于吴谦的个人信息。`;

async function openrouter(env, mm, msgs, emit, onThink) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.OPENROUTER_KEY, 'content-type': 'application/json', 'HTTP-Referer': 'https://wqzachery.dpdns.org', 'X-Title': 'wqzachery' },
    body: JSON.stringify({ models: [...new Set([mm.model, 'nvidia/nemotron-3-super-120b-a12b:free', 'poolside/laguna-s-2.1:free'])].slice(0, 3), messages: [{ role: 'system', content: sysFor(mm) }, ...msgs], stream: true, max_tokens: mm.effort === 'max' ? 8000 : 4000, reasoning: { effort: mm.effort === 'max' ? 'high' : (mm.effort || 'low'), exclude: false } }),
  });
  if (!r.ok) throw new Error('or ' + r.status + ' ' + (await r.text()).slice(0, 200));
  let got = false, err = '', used = mm.model;
  await sse(r.body, async d => {
    const j = JSON.parse(d);
    if (j.model) used = j.model;
    if (j.error) { err = j.error.message || 'error'; return; }
    const dl = j.choices?.[0]?.delta || {};
    const rk = dl.reasoning || dl.reasoning_content;
    if (rk && onThink) await onThink(String(rk));
    let t = dl.content;
    if (t && !got) t = String(t).replace(/^\s+/, '');
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
  // whitelist: model must be one we offer (missing → default), effort one of the four levels (missing → low)
  if (body.effort != null && !['low', 'medium', 'high', 'max'].includes(body.effort)) return json({ error: '思考强度参数无效' }, 400);
  const effort = body.effort || 'low';
  const offered = MODELS.filter(x => x.via !== 'or' || env.OPENROUTER_KEY);
  if (body.model != null && body.model !== '' && !offered.some(x => x.id === body.model)) return json({ error: '模型不存在或暂不可用' }, 400);
  const useWeb = body.web === true;
  // one generation at a time per IP + daily cap (AI_DAILY_CAP, default 200; 0 = unlimited); the admin is exempt
  const who = ip(req), day = cnDay(Date.now()), cap = env.AI_DAILY_CAP != null && env.AI_DAILY_CAP !== '' ? +env.AI_DAILY_CAP : 200;
  if (!isAdmin(req)) {
    const g = await store(env).aiBegin(who, day, cap);
    if (g === 'busy') return json({ error: '上一条回答还在生成中，请等它结束（或点停止）后再发', code: 'busy' }, 429);
    if (g === 'cap') return json({ error: `今天的提问次数已达上限（每天 ${cap} 次），明天再来吧`, code: 'cap' }, 429);
  }

  const enc = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter();
  // visitor pressed stop / closed the tab → writes fail: stop generating and release the per-IP slot right away
  let gone = false; const GONE = new Error('client gone');
  const send = o => gone ? Promise.reject(GONE) : w.write(enc.encode('data: ' + JSON.stringify(o) + '\n\n')).catch(() => { if (!gone) { gone = true; if (!isAdmin(req)) store(env).aiEnd(who, day).catch(() => {}); } throw GONE; });
  const meta = { ip: ip(req), geo: [req.cf?.country, req.cf?.city].filter(Boolean).join(' ') };
  const userTs = Date.now();

  const mm0 = MODELS.find(x => x.id === body.model) || MODELS[0];
  const mm = { ...mm0, effort };
  EFFORT.v = effort;
  ctx.waitUntil((async () => { try {
    const question = msgs[msgs.length - 1].content;
    // thinking level also steers models without a native reasoning knob
    const hint = { low: '', medium: '\n\n（请先仔细思考再回答，给出有条理的答案。）', high: '\n\n（这是一个需要深入思考的问题：请一步步推理，考虑多种可能和边界情况，检查结论后再给出完整、严谨的答案。）', max: '\n\n（极致模式：请投入最大的思考深度。先拆解问题，逐步推理并自我验证每一步，主动考虑反例、边界情况和替代方案，必要时给出计算或代码验证，最后给出完整、精确、结构清晰的答案，并指出仍不确定的部分。）' }[effort];
    let ctxBlock = '', srcList = [];   // (srcList used to be declared after its first use → TDZ error whenever web search found results)
    if (useWeb) {
      await send({ status: '正在联网搜索…' });
      const res = await webSearch(question, null, env).catch(() => []);
      if (res.length) {
        srcList = res.map(r => ({ t: r.title, u: r.url })); await send({ sources: srcList });
        const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
        ctxBlock = `\n\n[联网搜索结果，搜索时间 ${today}（北京时间）。请优先依据这些结果回答，信息有时效性时以结果为准，在用到的句子后用 [编号] 标注来源；结果不相关时照常回答并说明没有找到相关资料。]\n` +
          res.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.text}`).join('\n\n');
      } else await send({ status: '没有搜到相关结果，直接回答' });
    }
    if (ctxBlock || hint) msgs[msgs.length - 1] = { role: 'user', content: question + hint + ctxBlock };
    let full = '', model = '', by = mm.name, thinkTxt = '';
    const onThink = t => { if (thinkTxt.length > 20000) return; thinkTxt += t; return send({ k: t }); };
    if (mm.id !== 'astra') {
      try {
        model = mm.via === 'or' ? (env.OPENROUTER_KEY ? await openrouter(env, mm, msgs, t => { full += t; return send({ t }); }, onThink) : (() => { throw new Error('no key'); })())
                                : await workersAI(env, msgs, t => { full += t; return send({ t }); }, mm, onThink);
        const real = MODELS.find(x => x.model && model.startsWith(x.model.replace(':free', '')));
        if (real && real.id !== mm.id) { by = real.name; await send({ notice: `${mm.name} 现在太忙了，这次由 ${real.name} 回答` }); }
      } catch (e) {
        if (gone) throw e;
        lastAIError = String(e && e.message || e).slice(0, 300);
        if (isAdmin(req)) await send({ debug: lastAIError });
        if (full) model = (mm.model || mm.id) + ' (cut)';
        else { by = 'GPT-6 Astra'; await send({ notice: `${mm.name} 现在太忙了，这次由 GPT-6 Astra 回答` }); }
      }
    }
    if (!model) try {
      const out = await gemini(env, msgs, t => { full += t; return send({ t }); });
      model = out;
    } catch (e1) {
      if (gone) throw e1;
      lastAIError = String(e1 && e1.message || e1).slice(0, 300);
      if (isAdmin(req)) await send({ debug: lastAIError });
      if (full) { model = 'gemini (cut)'; }
      else {
        try { model = await workersAI(env, msgs, t => { full += t; return send({ t }); }, null, onThink); }
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
        { sid, role: 'user', content: question, ts: userTs, ...meta, extra: JSON.stringify({ model: mm.id, effort, web: useWeb }) },
        ...(full ? [{ sid, role: 'assistant', content: full, ts: Date.now(), ...meta, model, mname: by, think: thinkTxt, extra: srcList.length ? JSON.stringify({ sources: srcList }) : '' }] : []),
      ]);
    } catch {}
  } catch {} finally { try { await w.close(); } catch {} if (!isAdmin(req)) await store(env).aiEnd(who, day).catch(() => {}); } })());

  return new Response(readable, { headers: { ...SEC, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' } });
}

/* ---------------- web search (no API key): Bing RSS → DuckDuckGo HTML → Wikipedia, then read the top pages ---------------- */
const EFFORT = { v: 'low' };
const UA = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6' };
const unent = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/\s+/g, ' ').trim();
const tfetch = (u, o = {}, ms = 5000) => fetch(u, { ...o, signal: AbortSignal.timeout(ms) });
async function searchBing(q) {
  const r = await tfetch('https://www.bing.com/search?format=rss&count=8&mkt=' + (/[\u4e00-\u9fff]/.test(q) ? 'zh-CN' : 'en-US') + '&q=' + encodeURIComponent(q), { headers: UA });
  if (!r.ok) throw new Error('bing ' + r.status);
  const x = await r.text();
  return [...x.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => ({
    title: unent((m[1].match(/<title>([\s\S]*?)<\/title>/) || [])[1]),
    url: unent((m[1].match(/<link>([\s\S]*?)<\/link>/) || [])[1]),
    text: unent((m[1].match(/<description>([\s\S]*?)<\/description>/) || [])[1]) })).filter(r => /^https?:/.test(r.url));
}
async function searchBingHtml(q) {
  const zh = /[\u4e00-\u9fff]/.test(q);
  const r = await tfetch('https://www.bing.com/search?count=10&q=' + encodeURIComponent(q) + (zh ? '&setlang=zh-Hans&cc=CN' : '&setlang=en'), { headers: UA });
  if (!r.ok) throw new Error('bingh ' + r.status);
  const x = await r.text(), out = [];
  for (const m of x.matchAll(/<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>|<\/li>)/g)) {
    let u = unent(m[1]); const k = u.match(/[?&]u=a1([^&]+)/);
    if (k) { try { u = atob(k[1].replace(/-/g, '+').replace(/_/g, '/')); } catch {} }
    out.push({ title: unent(m[2]), url: u, text: unent(m[3] || '') });
  }
  return out.filter(r => /^https?:/.test(r.url));
}
async function searchNews(q) {
  const zh = /[\u4e00-\u9fff]/.test(q);
  const r = await tfetch('https://news.google.com/rss/search?q=' + encodeURIComponent(q) + (zh ? '&hl=zh-CN&gl=CN&ceid=CN:zh-Hans' : '&hl=en-US&gl=US&ceid=US:en'), { headers: UA });
  if (!r.ok) throw new Error('news ' + r.status);
  const x = await r.text();
  return [...x.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 6).map(m => {
    const g = t => unent((m[1].match(new RegExp('<' + t + '[^>]*>([\\s\\S]*?)<\\/' + t + '>')) || [])[1]);
    return { title: g('title'), url: g('link'), text: g('title') + ' — ' + g('pubDate') + ' · ' + g('source'), news: 1 };
  }).filter(r => /^https?:/.test(r.url));
}
// keep the searchable core of a chatty question
const cleanQ = q => q.replace(/[？?！!。，,、：:；;"“”'‘’（）()]/g, ' ').replace(/(请问|帮我|告诉我|你知道|能不能|可以|一下|是谁|是什么|颁给了谁|给了谁|怎么样|吗|呢|吧|呀)/g, ' ').replace(/\s+/g, ' ').trim() || q;
async function searchDDG(q) {
  const r = await tfetch('https://html.duckduckgo.com/html/', { method: 'POST', headers: { ...UA, 'content-type': 'application/x-www-form-urlencoded' }, body: 'q=' + encodeURIComponent(q) + '&kl=cn-zh' });
  if (!r.ok) throw new Error('ddg ' + r.status);
  const x = await r.text(), out = [];
  for (const m of x.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)) {
    let u = unent(m[1]); const k = u.match(/[?&]uddg=([^&]+)/); if (k) u = decodeURIComponent(k[1]); if (u.startsWith('//')) u = 'https:' + u;
    out.push({ title: unent(m[2]), url: u, text: unent(m[3]) });
  }
  return out.filter(r => /^https?:/.test(r.url) && !/duckduckgo\.com\/y\.js/.test(r.url));
}
async function searchWiki(q) {
  const r = await tfetch('https://zh.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=5&srsearch=' + encodeURIComponent(q), { headers: UA });
  const j = await r.json();
  return (j.query?.search || []).map(s => ({ title: s.title, url: 'https://zh.wikipedia.org/wiki/' + encodeURIComponent(s.title), text: unent(s.snippet) }));
}
async function readPage(u) {
  try {
    const r = await tfetch(u, { headers: UA, redirect: 'follow' }, 4000);
    if (!r.ok || !/html|text/.test(r.headers.get('content-type') || '')) return '';
    let h = (await r.text()).slice(0, 400000);
    h = h.replace(/<(script|style|noscript|svg|nav|footer|header|aside|form)[\s\S]*?<\/\1>/gi, ' ');
    const main = h.match(/<(article|main)[\s\S]*?<\/\1>/i);
    return unent(main ? main[0] : h).slice(0, 1800);
  } catch { return ''; }
}
// Bing serves good results to Worker IPs only for English queries, so non-English questions get an English search query too
async function toEnglishQuery(env, q) {
  try {
    const r = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fast', { max_tokens: 40, messages: [
      { role: 'system', content: 'Convert the user question into ONE short English web search query (max 10 words). Keep names, numbers and years. Output only the query.' },
      { role: 'user', content: q }] });
    return String(r.response || '').split('\n')[0].replace(/^["'\s]+|["'\s]+$/g, '').slice(0, 120);
  } catch { return ''; }
}
async function webSearch(q, only, env) {
  q = String(q || '').replace(/\s+/g, ' ').trim().slice(0, 200); if (!q) return [];
  let res = [];
  if (only) { try { res = await ({ bing: searchBing, bingh: searchBingHtml, ddg: searchDDG, wiki: searchWiki, news: searchNews }[only] || searchBing)(q); } catch {} }
  else {
    // web results and encyclopedia results side by side, interleaved
    q = cleanQ(q);
    const zh = /[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/.test(q);
    const qe = zh && env ? (await toEnglishQuery(env, q)) || q : q;
    const web = s => searchBingHtml(s).then(r => r.length ? r : searchBing(s)).catch(() => searchBing(s).catch(() => []));
    const [a, b] = await Promise.all([web(qe), searchWiki(q).catch(() => [])]);
    for (let i = 0; i < Math.max(a.length, b.length); i++) { if (a[i]) res.push(a[i]); if (b[i] && i < 2) res.push(b[i]); }
  }
  const seen = new Set(); res = res.filter(r => { const k = r.url.replace(/#.*$/, ''); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 6);
  const pages = await Promise.all(res.slice(0, 4).map(r => readPage(r.url)));
  return res.map((r, i) => ({ title: r.title.slice(0, 120), url: r.url, text: ((pages[i] && pages[i].length > r.text.length ? pages[i] : r.text) || '').slice(0, 1800) }));
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

async function workersAI(env, msgs, emit, mm, onThink) {
  let lastErr;
  for (const model of (mm ? [mm.model, ...(mm.fb || [])] : (env.AI_MODELS || env.CHAT_MODEL).split(','))) {
    let got = false;
    try {
      const opts = { messages: [{ role: 'system', content: mm ? sysFor(mm) : SYS }, ...msgs], max_tokens: 3000, stream: true };
      const ef = (mm && mm.effort) || EFFORT.v || 'low';
      if (/gpt-oss/.test(model)) opts.reasoning_effort = ef === 'max' ? 'high' : ef;
      if (ef === 'max') opts.max_tokens = 8000;
      if (/deepseek-r1|qwq|qwen3/.test(model)) opts.max_tokens = ef === 'max' ? 8000 : ef === 'high' ? 6000 : ef === 'medium' ? 4000 : 2500;
      const s = await env.AI.run(model, opts);
      // reasoning models stream a <think>…</think> block first: hide it, show only the answer
      let think = /deepseek-r1|qwq/.test(model) ? 0 : -1, buf = '', sent = 0;
      await sse(s, async d => {
        const j = JSON.parse(d);
        const dl = j.choices?.[0]?.delta;
        const rk = dl && (dl.reasoning_content || dl.reasoning);
        if (rk && onThink) await onThink(String(rk));
        let t = dl ? (dl.content ?? '') : (j.response ?? '');
        if (t === '' || t == null) return;
        t = String(t);
        if (think >= 0 && think < 2) {
          buf += t;
          if (think === 0 && !/^\s*<think>/.test(buf) && !/<\/think>/.test(buf) && buf.trim().length > 7 && !/^\s*</.test(buf)) { think = 2; t = buf; }
          else {
            const k = buf.indexOf('</think>');
            const inner = buf.replace(/^\s*<think>/, '');
            if (k < 0) { const part = inner.slice(sent); if (part && onThink) { sent += part.length; await onThink(part); } return; }
            const head = buf.slice(0, k).replace(/^\s*<think>/, ''); const rest = head.slice(sent); if (rest && onThink) await onThink(rest);
            think = 2; t = buf.slice(k + 8).replace(/^\s+/, ''); if (!t) return;
          }
        }
        if (!got) { t = t.replace(/^\s+/, ''); if (!t) return; }
        got = true; await emit(t);
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
const cleanName = n => (String(n || 'file').normalize('NFC').replace(/[\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').replace(/[\/\\\x00-\x1f"<>|:*?#%]/g, '_').replace(/^[.\s]+/, '').slice(0, 150).replace(/[.\s]+$/, '')) || 'file';
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
  const admin = isAdmin(req), me = ip(req);
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
  // reject instead of silently rewriting names (the old code turned bad characters into "_")
  const raw = String(b.path || '').normalize('NFC').split('/').map(s => s.trim()).filter(Boolean).join('/');
  if (raw !== d) return json({ error: '文件夹名无效：不能包含 / \\ : * ? " < > | # %，不能以点开头或结尾，每层最多 60 个字', code: 'name' }, 400);
  const ex = await fetch(`${HF}/api/datasets/${env.HF_REPO}/tree/main/files/${d.split('/').map(encodeURIComponent).join('/')}`, { headers: H(env) }).catch(() => null);
  if (ex && ex.ok) return json({ error: '这里已经有同名文件夹', code: 'exists' }, 409);
  const c = await commit(env, 'mkdir ' + d, [{ key: 'file', value: { path: `files/${d}/.keep`, content: btoa('keep'), encoding: 'base64' } }]);
  if (!c.ok) return json({ error: '创建失败，请稍后再试' }, 502);
  return json({ ok: true, path: d });
}

async function rmFolder(req, env, path) {
  if (!isAdmin(req)) return json({ error: '管理员密钥错误' }, 403);
  const d = cleanDir(path);
  if (!d) return json({ error: '参数错误' }, 400);
  const c = await commit(env, 'rmdir ' + d, [{ key: 'deletedFolder', value: { path: 'files/' + d } }]);
  if (!c.ok) return json({ error: '删除失败 (' + c.status + ')' }, 502);
  try { await store(env).forgetFile('files/' + d, true); } catch {}
  return json({ ok: true });
}

// admin: rename a file (keeps its stamp prefix) or a folder (re-commits everything under it)
async function rename(req, env) {
  if (!isAdmin(req)) return json({ error: '管理员密钥错误' }, 403);
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
  if (!isAdmin(req)) return json({ error: '管理员密钥错误' }, 403);
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

/* ---------- upload limits (env-configurable) and blocked types ---------- */
const GB = 1024 ** 3;
const lim = env => ({ file: +(env.UP_MAX_FILE || 2 * GB), dayBytes: +(env.UP_DAY_BYTES || 5 * GB), dayFiles: +(env.UP_DAY_FILES || 50) });
const BLOCK_EXT = new Set(('exe msi msp mst apk xapk apks aab ipa bat cmd ps1 psm1 ps1xml scr com pif cpl vbs vbe jse wsf wsh hta jar dll sys drv ocx sh bash zsh csh ksh command run ' +
  'app dmg pkg mpkg deb rpm appx appxbundle msix msixbundle reg lnk gadget inf elf so dylib out').split(' '));
const extOf = n => { const m = String(n).toLowerCase().match(/\.([a-z0-9_]{1,12})$/); return m ? m[1] : ''; };
const blockedName = n => BLOCK_EXT.has(extOf(n));
const ERR = { big: '文件太大', type: '类型不支持', quota: '今日额度已用完' };
const fmtB = b => b >= GB ? (b / GB).toFixed(b % GB ? 1 : 0) + ' GB' : Math.round(b / 1048576) + ' MB';
// magic-byte sniff of the first bytes: Windows PE (MZ), ELF, Mach-O / universal, shebang scripts, deb/rpm, and ZIPs that are APK/JAR/IPA
function sniff(u8) {
  if (!u8 || u8.length < 2) return '';
  const b = i => u8[i], s = (i, n) => String.fromCharCode(...u8.slice(i, i + n));
  if (b(0) === 0x4d && b(1) === 0x5a) return 'Windows 可执行文件';
  if (s(0, 4) === '\x7fELF') return 'Linux 可执行文件';
  const m4 = u8.length >= 4 ? ((b(0) << 24) | (b(1) << 16) | (b(2) << 8) | b(3)) >>> 0 : 0;
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(m4)) return 'macOS 可执行文件';
  if (s(0, 2) === '#!') return '脚本文件';
  if (s(0, 8) === '!<arch>\n') return '安装包';
  if (m4 === 0xedabeedb) return '安装包';
  if (s(0, 4) === 'PK\x03\x04') {
    const t = new TextDecoder('latin1').decode(u8);
    if (/AndroidManifest\.xml|classes\.dex/.test(t)) return 'Android 安装包';
    if (/META-INF\/MANIFEST\.MF/.test(t)) return 'Java 程序';
    if (/Payload\/[^\/]+\.app\//.test(t)) return 'iOS 安装包';
  }
  return '';
}
const b64u8 = t => { try { const x = atob(String(t || '').slice(0, 8192)); return Uint8Array.from(x, c => c.charCodeAt(0)); } catch { return null; } };
// read the first bytes of an uploaded (not yet committed) LFS object through a git-LFS download link
async function headBytes(env, oid, size, n = 65536) {
  const r = await fetch(`${HF}/datasets/${env.HF_REPO}.git/info/lfs/objects/batch`, { method: 'POST',
    headers: { ...H(env), Accept: 'application/vnd.git-lfs+json', 'Content-Type': 'application/vnd.git-lfs+json' },
    body: JSON.stringify({ operation: 'download', transfers: ['basic'], objects: [{ oid, size }], hash_algo: 'sha256', ref: { name: 'main' } }) });
  if (!r.ok) throw new Error('lfs batch ' + r.status);
  const o = (await r.json()).objects?.[0] || {};
  if (o.error || !o.actions?.download?.href) throw new Error('lfs object missing');
  const d = await fetch(o.actions.download.href, { headers: { ...(o.actions.download.header || {}), Range: 'bytes=0-' + (Math.min(n, size) - 1) } });
  if (!d.ok && d.status !== 206) throw new Error('lfs read ' + d.status);
  const total = +((d.headers.get('content-range') || '').split('/')[1] || d.headers.get('content-length') || -1);
  return { u8: new Uint8Array(await d.arrayBuffer()).slice(0, n), total };
}

// step 1: browser sends name/size/sha256 (+ first bytes); we check limits and ask HF where to put the bytes
async function upInit(req, env) {
  if (await limited(env.UP_RL, ip(req))) return json({ error: '上传太频繁了，请稍后再试' }, 429);
  const b = await req.json().catch(() => ({}));
  const oid = String(b.oid || ''), size = Math.floor(+b.size);
  if (!/^[a-f0-9]{64}$/.test(oid) || !(size > 0)) return json({ error: '参数错误' }, 400);
  const name = cleanName(b.name), L = lim(env);
  if (size > L.file) return json({ error: `${ERR.big}：单个文件最大 ${fmtB(L.file)}`, code: 'big' }, 413);
  if (blockedName(name)) return json({ error: `${ERR.type}：不能上传可执行文件、安装包或脚本（.${extOf(name)}）`, code: 'type' }, 415);
  const kind = b.head ? sniff(b64u8(b.head)) : '';
  if (kind) return json({ error: `${ERR.type}：检测到${kind}，不能上传`, code: 'type' }, 415);
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = [...crypto.getRandomValues(new Uint8Array(6))].map(x => 'abcdefghijklmnopqrstuvwxyz0123456789'[x % 36]).join('');
  const dir = b.dir ? cleanDir(b.dir) : '';
  if (dir === null) return json({ error: '文件夹无效' }, 400);
  const path = `files/${dir ? dir + '/' : ''}${stamp}-${rand}-${name}`;
  {
    const adm = isAdmin(req);   // the admin has no daily quota, but still gets a pending row (needed by the relay + finish checks)
    const q = await store(env).upReserve(path, ip(req), cnDay(Date.now()), oid, size, adm ? 1e9 : L.dayFiles, adm ? 1e18 : L.dayBytes);
    if (!q.ok) return json({ error: `${ERR.quota}：每个网络每天最多上传 ${L.dayFiles} 个文件、共 ${fmtB(L.dayBytes)}（今天已用 ${q.n} 个、${fmtB(q.bytes)}），北京时间 0 点重置`, code: 'quota' }, 429);
  }
  const r = await fetch(`${HF}/datasets/${env.HF_REPO}.git/info/lfs/objects/batch`, {
    method: 'POST',
    headers: { ...H(env), Accept: 'application/vnd.git-lfs+json', 'Content-Type': 'application/vnd.git-lfs+json' },
    body: JSON.stringify({ operation: 'upload', transfers: ['basic', 'multipart'], objects: [{ oid, size }], hash_algo: 'sha256', ref: { name: 'main' } }),
  });
  if (!r.ok) return json({ error: '存储暂时不可用，请稍后再试' }, 502);
  const d = await r.json(), o = d.objects?.[0] || {};
  if (o.error) return json({ error: '存储拒绝了这个文件，请稍后再试' }, 502);
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
  if (size > lim(env).file) return json({ error: ERR.big, code: 'big' }, 413);
  if (blockedName(nameOf(path))) return json({ error: ERR.type, code: 'type' }, 415);
  const st = store(env), pend = await st.upPending(path);
  if (!isAdmin(req) && (!pend || pend.oid !== oid || pend.size !== size || pend.done)) return json({ error: '上传会话无效或已过期，请重新上传' }, 400);
  if (b.complete) {
    if (!String(b.complete).startsWith(HF + '/api/complete_multipart')) return json({ error: '参数错误' }, 400);
    const c = await fetch(b.complete, { method: 'POST', headers: { ...H(env), 'Content-Type': 'application/vnd.git-lfs+json', Accept: 'application/vnd.git-lfs+json' }, body: JSON.stringify({ oid, parts: b.parts || [] }) });
    if (!c.ok) return json({ error: '网络失败：合并分片失败，请重试' }, 502);
  }
  if (b.verify && b.verify.href && String(b.verify.href).startsWith(HF + '/')) {
    const v = await fetch(b.verify.href, { method: 'POST', headers: { ...H(env), ...(b.verify.header || {}), 'Content-Type': 'application/vnd.git-lfs+json', Accept: 'application/vnd.git-lfs+json' }, body: JSON.stringify({ oid, size }) });
    if (!v.ok) return json({ error: '网络失败：存储校验失败，请重试' }, 502);
  }
  // authoritative content check on the stored bytes (the client-sent head may be forged)
  let hb; try { hb = await headBytes(env, oid, size); } catch { return json({ error: '网络失败：无法校验文件内容，请重试' }, 502); }
  if (hb.total !== size) { await st.upDrop(path).catch(() => {}); return json({ error: '文件大小与声明不符，请重新上传' }, 400); }
  const kind = sniff(hb.u8);
  if (kind) { await st.upDrop(path).catch(() => {}); return json({ error: `${ERR.type}：检测到${kind}，不能上传`, code: 'type' }, 415); }
  const nd = JSON.stringify({ key: 'header', value: { summary: 'upload ' + nameOf(path) } }) + '\n' +
    JSON.stringify({ key: 'lfsFile', value: { path, algo: 'sha256', oid, size } }) + '\n';
  // uploads now finish in parallel (up to 3 per visitor): retry once when HF reports a concurrent-commit conflict or a transient error
  const doCommit = () => fetch(`${HF}/api/datasets/${env.HF_REPO}/commit/main`, { method: 'POST', headers: { ...H(env), 'Content-Type': 'application/x-ndjson' }, body: nd });
  let c = await doCommit();
  if (!c.ok && [409, 412, 429, 500, 502, 503, 504].includes(c.status)) { await new Promise(r => setTimeout(r, 900)); c = await doCommit(); }
  if (!c.ok) return json({ error: '网络失败：保存失败，请重试' }, 502);
  await st.upDone(path).catch(() => {});
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
  if (!isAdmin(req)) return json({ error: '管理员密钥错误' }, 403);
  const nd = JSON.stringify({ key: 'header', value: { summary: 'admin delete' } }) + '\n' + JSON.stringify({ key: 'deletedFile', value: { path } }) + '\n';
  const c = await fetch(`${HF}/api/datasets/${env.HF_REPO}/commit/main`, { method: 'POST', headers: { ...H(env), 'Content-Type': 'application/x-ndjson' }, body: nd });
  if (!c.ok) return json({ error: '删除失败 (' + c.status + ')' }, 502);
  try { await store(env).forgetFile(path, false); } catch {}
  return json({ ok: true });
}

/* ---------- reports: anyone can flag a file, the admin deletes or ignores ---------- */
const REASONS = ['违法违规', '色情低俗', '侵犯版权', '侵犯隐私', '恶意软件/病毒', '垃圾广告', '其他'];
async function report(req, env) {
  if (await limited(env.UP_RL, 'rep:' + ip(req))) return json({ error: '操作太频繁了，请稍后再试' }, 429);
  const b = await req.json().catch(() => ({}));
  const path = String(b.path || ''), reason = String(b.reason || '');
  if (!okPath(path) || base(path) === '.keep') return json({ error: '文件无效' }, 400);
  if (!REASONS.includes(reason)) return json({ error: '请选择举报原因' }, 400);
  const note = String(b.note || '').replace(/[\u0000-\u001f\u007f\u202a-\u202e]/g, ' ').trim().slice(0, 300);
  const r = await store(env).report(path, nameOf(path), reason, note, ip(req), 20);
  return r.ok ? json({ ok: true }) : json({ error: r.error, code: r.code }, 429);
}
async function reportAdmin(req, env) {
  if (!isAdmin(req)) return json({ error: '管理员密钥错误' }, 403);
  if (req.method === 'GET') return json(await store(env).reportsOpen());
  const b = await req.json().catch(() => ({}));
  const path = String(b.path || '');
  if (!okPath(path)) return json({ error: '参数错误' }, 400);
  if (b.action === 'ignore') { await store(env).reportsIgnore(path); return json({ ok: true }); }
  if (b.action === 'delete') return del(req, env, path);
  return json({ error: '参数错误' }, 400);
}

/* ---------- public, verifiable site numbers for the home page ---------- */
const LAUNCH = Date.UTC(2026, 9, 11) - 8 * 3600e3;   // 2026-10-11 00:00 China time
const FEATURES = ['主页', '公共网盘', 'AI 助手', '聊天室'];
let pubCache = null;
async function publicStats(env) {
  if (pubCache && Date.now() - pubCache.t < 600e3) return json(pubCache.v);
  let files = null;
  try { files = (await tree(env)).filter(x => x.type === 'file' && base(x.path) !== '.keep').length; } catch {}
  const v = { files, days: Math.floor((Date.now() - LAUNCH) / 864e5) + 1, since: '2026-10-11', features: FEATURES.length, featureNames: FEATURES, models: MODELS.filter(x => x.via !== 'or' || env.OPENROUTER_KEY).length };
  if (files != null) pubCache = { t: Date.now(), v };
  return json(v);
}

// stream a file through our own domain (works where the HF CDN is unreachable); supports Range for video seeking
const MIME = { mov: 'video/quicktime', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', aac: 'audio/aac', opus: 'audio/ogg',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml', heic: 'image/heic', ico: 'image/x-icon', pdf: 'application/pdf' };
async function raw(req, env, path, dl) {
  const name = nameOf(path), ext = (name.split('.').pop() || '').toLowerCase();
  const fh = { ...H(env) }; const rg = req.headers.get('range'); if (rg) fh.Range = rg;
  const r = await fetch(`${HF}/datasets/${env.HF_REPO}/resolve/main/${path.split('/').map(encodeURIComponent).join('/')}`, { headers: fh, method: req.method });
  if (r.status === 404) return json({ error: '文件不存在' }, 404);
  if (!r.ok && r.status !== 206) return json({ error: '读取失败，请稍后再试' }, r.status === 416 ? 416 : 502);
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
async function upPart(req, env) {
  const t = req.headers.get('x-target') || '';
  if (!/^https:\/\/hf-hub-lfs-[a-z0-9-]+\.s3[a-z0-9.-]*\.amazonaws\.com\//.test(t)) return json({ error: '参数错误' }, 400);
  const path = req.headers.get('x-up') || '';
  const pend = okPath(path) ? await store(env).upPending(path) : null;
  if (!pend || pend.done || Date.now() - pend.ts > 6 * 3600e3) return json({ error: '上传会话无效或已过期，请重新上传' }, 400);
  const len = +(req.headers.get('content-length') || 0);
  if (len > 110 * 1048576 || len > pend.size + 1048576) return json({ error: ERR.big, code: 'big' }, 413);
  const body = await req.arrayBuffer();
  if (body.byteLength > 110 * 1048576 || body.byteLength > pend.size) return json({ error: ERR.big, code: 'big' }, 413);
  const pn = new URL(t).searchParams.get('partNumber');
  if (!pn || pn === '1') { const kind = sniff(new Uint8Array(body, 0, Math.min(65536, body.byteLength))); if (kind) return json({ error: `${ERR.type}：检测到${kind}，不能上传`, code: 'type' }, 415); }
  const r = await fetch(t, { method: 'PUT', body });
  if (!r.ok) return json({ error: '网络失败：中转上传失败，请重试' }, 502);
  return json({ etag: r.headers.get('etag') });
}
