# Bottom tab-bar lens legibility + edge-fringe check (Chromium, Android Edge UA, 402x874 @3x).
# Usage: python3 tools/lens_sharp.py <label> [base] [real|black|stripes]  (black = plain page behind the bar, best for the sharpness number)
#  -> work/shots/lens_<label>_{rest,held,drag,slide,ref}.png (lens crops) + printed metrics:
#     sharp = normalised Laplacian variance of the lens-centre crop (higher = crisper), ref = same tab label NOT under the lens
#     fringe = mean chroma (max-min RGB) in the lens rim bands minus the centre (needs 'stripes' content to be meaningful)
import asyncio, sys, json
import numpy as np
from PIL import Image
from playwright.async_api import async_playwright
LABEL = sys.argv[1] if len(sys.argv) > 1 else 'x'
BASE = sys.argv[2] if len(sys.argv) > 2 else 'http://127.0.0.1:8766'
CONTENT = sys.argv[3] if len(sys.argv) > 3 else 'real'
UA = 'Mozilla/5.0 (Linux; Android 14; 23127PN0CC) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36 EdgA/129.0.0.0'
OUT = __file__.rsplit('/', 2)[0] + '/work/shots/'
STRIPES = """(()=>{const d=document.createElement('div');d.style.cssText='position:fixed;left:0;right:0;bottom:0;height:150px;z-index:2147483647;pointer-events:none;background:repeating-linear-gradient(90deg,#fff 0 3px,#000 3px 12px),#000';document.body.appendChild(d)})()"""
LENS = "(()=>{const r=document.getElementById('lens').getBoundingClientRect();return [r.left,r.top,r.width,r.height]})()"
def gray(a): return a[..., :3].astype(float) @ [0.299, 0.587, 0.114]
def sharp(a):
    g = gray(a); lap = (-4 * g[1:-1, 1:-1] + g[:-2, 1:-1] + g[2:, 1:-1] + g[1:-1, :-2] + g[1:-1, 2:])
    return float(lap.var() / max(g.var(), 1e-6))
def chroma(a): a = a[..., :3].astype(float); return float((a.max(-1) - a.min(-1)).mean())
async def grab(p, name, box=None):
    png = f'{OUT}lens_{LABEL}_{name}.png'
    lb = box or await p.evaluate(LENS)
    x, y, w, h = lb
    await p.screenshot(path=png, clip={'x': x, 'y': y, 'width': w, 'height': h})
    a = np.asarray(Image.open(png).convert('RGB'))
    H, W = a.shape[:2]
    cen = a[int(H * .12):int(H * .88), int(W * .28):int(W * .72)]
    rim = np.concatenate([a[int(H * .2):int(H * .8), :int(W * .12)], a[int(H * .2):int(H * .8), -int(W * .12):]], 1)
    return {'sharp': round(sharp(cen), 3), 'rim_chroma': round(chroma(rim), 1), 'centre_chroma': round(chroma(cen), 1), 'file': png}
async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path='/usr/bin/chromium', args=['--enable-gpu-rasterization', '--ignore-gpu-blocklist'])
        ctx = await b.new_context(viewport={'width': 402, 'height': 874}, device_scale_factor=3, is_mobile=True, has_touch=True, user_agent=UA)
        await ctx.add_init_script("try{localStorage.getItem('wqzAnnSeen')||localStorage.setItem('wqzAnnSeen','*')}catch(e){}")   # no update popup during tests (tools/ann_test.py covers it)
        p = await ctx.new_page()
        await p.goto(BASE + '/drive', wait_until='load'); await p.wait_for_timeout(4000)
        if CONTENT == 'black':
            for f in p.frames:
                if '/p/' in f.url:
                    try: await f.evaluate(STRIPES.replace("repeating-linear-gradient(90deg,#fff 0 3px,#000 3px 12px),#000","#000"))
                    except Exception: pass
        if CONTENT == 'stripes':
            for f in p.frames:
                if '/p/' in f.url:
                    try: await f.evaluate(STRIPES)
                    except Exception: pass
        await p.wait_for_timeout(500)
        res = {}
        lb = await p.evaluate(LENS)
        res['rest'] = await grab(p, 'rest')
        x, y, w, h = await p.evaluate("(()=>{const r=document.getElementById('bar').getBoundingClientRect();return [r.left,r.top,r.width,r.height]})()")
        iw = (w - 8) / 4; cy = y + h / 2; sx = x + 4 + iw * 1.5
        await p.mouse.move(sx, cy); await p.mouse.down(); await p.wait_for_timeout(500)
        res['held'] = await grab(p, 'held'); res['held']['st'] = await p.evaluate('window.__st()')
        for k in range(1, 9): await p.mouse.move(sx + k * iw * 0.3 / 8, cy); await p.wait_for_timeout(16)
        await p.wait_for_timeout(250)
        res['drag'] = await grab(p, 'drag')
        await p.mouse.up(); await p.wait_for_timeout(1200)
        await p.mouse.click(x + 4 + iw * 2.5, cy); await p.wait_for_timeout(45)
        res['slide'] = await grab(p, 'slide'); res['slide']['st'] = await p.evaluate('window.__st()')
        await p.wait_for_timeout(1200)
        res['ref'] = await grab(p, 'ref', lb)   # tab 1 label, lens now sits on tab 2
        print(json.dumps(res, ensure_ascii=False, indent=1))
        await b.close()
asyncio.run(main())
