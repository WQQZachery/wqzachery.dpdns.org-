# Responsive + tap-target + a11y sweep (Chromium). Needs tools/lproxy.py on :8766.
# Usage: python3 tools/mobile_check.py [base] [widths] [paths]
#  -> work/shots/mob_<w>_<page>.png and one JSON line per page/width:
#     overflowX (px of horizontal overflow), small (visible tap targets under 44x44 CSS px, excluding inline text links),
#     unnamed (buttons/links without accessible name), noLabel (form fields without a label), imgNoAlt
import asyncio, sys, json
from playwright.async_api import async_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8766'
WIDTHS = [int(x) for x in (sys.argv[2] if len(sys.argv) > 2 else '360,390,402,768,1280').split(',')]
PATHS = (sys.argv[3] if len(sys.argv) > 3 else '/,/p/drive,/p/ai,/p/chat,/admin,/privacy').split(',')
OUT = __file__.rsplit('/', 2)[0] + '/work/shots/'
UA = 'Mozilla/5.0 (Linux; Android 14; 23127PN0CC) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36 EdgA/129.0.0.0'
JS = r"""()=>{const vis=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&e.closest('[hidden],[inert],[aria-hidden=true]')===null};
const nm=e=>(e.getAttribute('aria-label')||e.getAttribute('title')||e.innerText||e.getAttribute('alt')||'').trim();
const docs=[document];
const els=s=>docs.flatMap(d=>[...d.querySelectorAll(s)]);
const inline=e=>e.tagName==='A'&&getComputedStyle(e).display==='inline'&&e.closest('p,li,td,small,span.sub');
const small=els('button,a[href],[role=button],[role=tab],select,input:not([type=hidden]),textarea').filter(e=>vis(e)&&!inline(e)&&!e.classList.contains('wz-link')).map(e=>{const r=e.getBoundingClientRect(),b=getComputedStyle(e,'::before');const hs=b.content!=='none'&&b.position==='absolute';const w=Math.max(r.width,hs?parseFloat(b.width)||0:0),h=Math.max(r.height,hs?parseFloat(b.height)||0:0);return [Math.round(w),Math.round(h),(nm(e)||e.id||e.className||e.tagName).slice(0,24)]})   /* effective hit area incl. ::before hit-slop */.filter(([w,h])=>w<44||h<44);
return {overflowX:document.documentElement.scrollWidth-innerWidth,
 small:small.length,smallEx:small.slice(0,8),
 unnamed:els('button,a[href],[role=button]').filter(e=>vis(e)&&!nm(e)&&!e.querySelector('img[alt]:not([alt=""])')).map(e=>e.outerHTML.slice(0,80)),
 noLabel:els('input:not([type=hidden]):not([hidden]),textarea,select').filter(i=>!i.getAttribute('aria-label')&&!i.getAttribute('aria-labelledby')&&!(i.id&&document.querySelector('label[for="'+i.id+'"]'))&&!i.closest('label')).map(e=>e.outerHTML.slice(0,80)),
 imgNoAlt:els('img').filter(i=>!i.hasAttribute('alt')).length, lang:document.documentElement.lang, title:document.title,
 desc:(document.querySelector('meta[name=description]')||{}).content||''}}"""
async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path='/usr/bin/chromium')
        for w in WIDTHS:
            mob = w < 768
            ctx = await b.new_context(viewport={'width': w, 'height': 800 if mob else 900}, device_scale_factor=2 if mob else 1, is_mobile=mob, has_touch=w <= 768, user_agent=UA if mob else None, reduced_motion='reduce')
            p = await ctx.new_page()
            for path in PATHS:
                await p.goto(BASE + path, wait_until='load'); await p.wait_for_timeout(2600 if path == '/' else 1500)
                fr = p.main_frame
                for f in p.frames:
                    if f.url.endswith('/p/home'): fr = f
                r = await fr.evaluate(JS)
                if path == '/': r['shellOverflowX'] = await p.evaluate('document.documentElement.scrollWidth-innerWidth')
                print(json.dumps({'w': w, 'path': path, **r}, ensure_ascii=False), flush=True)
                await p.screenshot(path=f"{OUT}mob_{w}_{path.strip('/').replace('/', '_') or 'root'}.png")
            await ctx.close()
        await b.close()
asyncio.run(main())
