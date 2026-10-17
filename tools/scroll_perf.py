# Fast-scroll frame-time benchmark. Usage: python3 tools/scroll_perf.py [base_url] [runs]
# Needs tools/lproxy.py running (default http://127.0.0.1:8766). Chromium, Android UA, 402x874, CPU throttle 4x.
import asyncio, sys, json, statistics
from playwright.async_api import async_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8766'
PATHS = (sys.argv[4].split(',') if len(sys.argv)>4 else ['/p/home'])
SEL = (sys.argv[3].split(',') if len(sys.argv)>3 else None)
RUNS = int(sys.argv[2]) if len(sys.argv) > 2 else 3
UA = 'Mozilla/5.0 (Linux; Android 14; 23127PN0CC) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36 EdgA/129.0.0.0'
CSS = {
 'noglass': '*{-webkit-backdrop-filter:none!important;backdrop-filter:none!important}',
 'nolens': '.lens{-webkit-backdrop-filter:blur(7px) saturate(170%)!important;backdrop-filter:blur(7px) saturate(170%)!important}',
 'noorb': '.orb,.blob{filter:none!important;animation:none!important}',
 'orbonly': '.orb{filter:none!important}',
 'blobonly': '.blob{filter:none!important;animation:none!important}',
 'fix': '.orb{filter:none!important;background-image:radial-gradient(circle,color-mix(in srgb,var(--c,#6ee7b7) 60%,transparent) 0,transparent 70%)!important}.blob{filter:none!important;animation:none!important}',
 'noanim': '*{animation-iteration-count:1!important}',
}
DROP_SCROLL = """(()=>{const a=EventTarget.prototype.addEventListener;EventTarget.prototype.addEventListener=function(t,f,o){if(t==='scroll'&&(this===window||this===document))return;return a.call(this,t,f,o)}})();"""
COLLECT = """(()=>{window.__ft=[];let l=0;const f=t=>{if(l)window.__ft.push(t-l);l=t;requestAnimationFrame(f)};requestAnimationFrame(f)})();"""
VARIANTS = dict(x for x in {
 'base': [], 'noglass': ['noglass'], 'nolens': ['nolens'], 'noorb': ['noorb'], 'orbonly': '.orb{filter:none!important}',
 'blobonly': '.blob{filter:none!important;animation:none!important}',
 'fix': '.orb{filter:none!important;background-image:radial-gradient(circle,color-mix(in srgb,var(--c,#6ee7b7) 60%,transparent) 0,transparent 70%)!important}.blob{filter:none!important;animation:none!important}',
 'noanim': ['noanim'], 'nojs': ['nojs'],
 'all_off': ['noglass', 'noorb', 'noanim', 'nojs'],
 'orbonly':['orbonly'],'blobonly':['blobonly'],'fix':['fix'],'fix+noglass':['fix','noglass'],
}.items() if not SEL or x[0] in SEL)
async def run(pw, path, vname, opts):
    b = await pw.chromium.launch(executable_path='/usr/bin/chromium', args=['--enable-gpu-rasterization', '--ignore-gpu-blocklist'])
    ctx = await b.new_context(viewport={'width': 402, 'height': 874}, device_scale_factor=3, is_mobile=True, has_touch=True, user_agent=UA)
    await ctx.add_init_script("try{localStorage.getItem('wqzAnnSeen')||localStorage.setItem('wqzAnnSeen','*')}catch(e){}")   # no update popup during tests (tools/ann_test.py covers it)
    if 'nojs' in opts: await ctx.add_init_script(DROP_SCROLL)
    css = ''.join(CSS[o] for o in opts if o in CSS)
    if css: await ctx.add_init_script(f"document.addEventListener('DOMContentLoaded',()=>{{const s=document.createElement('style');s.textContent={json.dumps(css)};document.head.appendChild(s)}})")
    p = await ctx.new_page()
    await p.goto(BASE + path, wait_until='load'); await p.wait_for_timeout(3500)  # boot animation
    cdp = await ctx.new_cdp_session(p)
    await cdp.send('Emulation.setCPUThrottlingRate', {'rate': 4})
    fr = p.main_frame
    for f in p.frames:
        if f.url.endswith('/p/home'): fr = f
    await fr.evaluate(COLLECT)
    for i in range(3):  # fast flings down then up
        await cdp.send('Input.synthesizeScrollGesture', {'x': 200, 'y': 600, 'yDistance': -2600, 'speed': 6000, 'gestureSourceType': 'touch', 'repeatCount': 1})
        await cdp.send('Input.synthesizeScrollGesture', {'x': 200, 'y': 300, 'yDistance': 2600, 'speed': 6000, 'gestureSourceType': 'touch', 'repeatCount': 1})
    ft = await fr.evaluate('window.__ft')
    await b.close()
    ft = ft[5:]
    return ft
def stats(ft):
    if not ft: return {}
    s = sorted(ft); n = len(s)
    return {'frames': n, 'avg_ms': round(sum(s) / n, 1), 'p95_ms': round(s[int(n * .95)], 1), 'jank_pct': round(100 * sum(1 for x in s if x > 25) / n, 1), 'fps': round(1000 / (sum(s) / n), 1)}
async def main():
    out = {}
    async with async_playwright() as pw:
        for path in ['/p/home', '/']:
            pass
        for path in PATHS:
            for vn, opts in VARIANTS.items():
                if path not in PATHS: continue
                agg = []
                for _ in range(RUNS): agg += await run(pw, path, vn, opts)
                out[f'{path} {vn}'] = stats(agg); print(f'{path:8} {vn:8}', out[f'{path} {vn}'], flush=True)
    json.dump(out, open('/tmp/scroll_perf.json', 'w'), indent=1)
asyncio.run(main())
