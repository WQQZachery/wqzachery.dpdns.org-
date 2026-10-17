# Evidence shots for the bottom tab-bar refraction (Chromium + Android Edge UA, 402x874 @3x).
# Usage: python3 tools/bar_refr.py <label> [base] [content: stripes|real]
#  -> work/shots/refr_<label>_{rest,drag,slide,off}.png (full bar crop, 2x zoom) + _ends.png (zoomed bar ends)
# 'off' = same frame with the SVG lens filters removed (plain blur), for comparison.
import asyncio, sys
from playwright.async_api import async_playwright
LABEL = sys.argv[1] if len(sys.argv) > 1 else 'x'
BASE = sys.argv[2] if len(sys.argv) > 2 else 'http://127.0.0.1:8766'
CONTENT = sys.argv[3] if len(sys.argv) > 3 else 'stripes'
UA = 'Mozilla/5.0 (Linux; Android 14; 23127PN0CC) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36 EdgA/129.0.0.0'
OUT = __file__.rsplit('/', 2)[0] + '/work/shots/'
# busy, high-contrast content injected at the bottom of the visible page so warping/fringes are obvious
STRIPES = """(()=>{const d=document.createElement('div');d.id='__stripes';d.style.cssText='position:fixed;left:0;right:0;bottom:0;height:150px;z-index:2147483647;pointer-events:none;'+
'background:repeating-linear-gradient(90deg,#fff 0 3px,#000 3px 12px),#000';
const t=document.createElement('div');t.textContent='Refraction 折射测试 ABCDEFGHIJ 0123456789';t.style.cssText='position:absolute;left:0;right:0;bottom:44px;font:700 22px sans-serif;color:#ff0;text-align:center;mix-blend-mode:difference';
d.appendChild(t);document.body.appendChild(d)})()"""
async def bar_box(p):
    return await p.evaluate("(()=>{const r=document.getElementById('bar').getBoundingClientRect();return [r.left,r.top,r.width,r.height]})()")
async def shot(p, name, box):
    x, y, w, h = box
    await p.screenshot(path=f'{OUT}refr_{LABEL}_{name}.png', clip={'x': x - 6, 'y': y - 10, 'width': w + 12, 'height': h + 20})
async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path='/usr/bin/chromium', args=['--enable-gpu-rasterization', '--ignore-gpu-blocklist'])
        ctx = await b.new_context(viewport={'width': 402, 'height': 874}, device_scale_factor=3, is_mobile=True, has_touch=True, user_agent=UA)
        await ctx.add_init_script("try{localStorage.getItem('wqzAnnSeen')||localStorage.setItem('wqzAnnSeen','*')}catch(e){}")   # no update popup during tests (tools/ann_test.py covers it)
        p = await ctx.new_page()
        await p.goto(BASE + '/drive', wait_until='load'); await p.wait_for_timeout(2500)
        await p.wait_for_timeout(1500)  # all panes loaded
        if CONTENT == 'stripes':
            for f in p.frames:
                if '/p/' in f.url:
                    try: await f.evaluate(STRIPES)
                    except Exception as e: print('inject fail', f.url, e)
        await p.wait_for_timeout(600)
        box = await bar_box(p)
        info = await p.evaluate("(()=>({barLens:getComputedStyle(document.getElementById('glass')||document.getElementById('bar')).backdropFilter,lensCls:document.getElementById('lens').className,chromium:/Chrome\\//.test(navigator.userAgent)}))()")
        print(info)
        await shot(p, 'rest', box)
        # drag the lens from tab 1 (网盘) toward tab 2 and hold mid-way
        x, y, w, h = box; iw = (w - 8) / 4; cy = y + h / 2
        sx = x + 4 + iw * 1.5
        await p.mouse.move(sx, cy); await p.mouse.down()
        for k in range(1, 13): await p.mouse.move(sx + k * iw * 0.55 / 12, cy); await p.wait_for_timeout(16)
        await p.wait_for_timeout(250)
        print('drag state', await p.evaluate('window.__st&&window.__st()'))
        await shot(p, 'drag', box)
        await p.mouse.up(); await p.wait_for_timeout(900)
        # tap-slide: tap 主页 and capture mid-flight
        await p.mouse.click(x + 4 + iw * .5, cy)
        await p.wait_for_timeout(110)
        print('slide state', await p.evaluate('window.__st&&window.__st()'))
        await shot(p, 'slide', box)
        await p.wait_for_timeout(900)
        # same rest frame with refraction disabled
        await p.evaluate("document.querySelectorAll('.lens').forEach(e=>e.classList.remove('lens'))")
        await p.wait_for_timeout(300); await shot(p, 'off', box)
        await b.close()
asyncio.run(main())
