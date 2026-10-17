#!/usr/bin/env python3
"""Boot loader timing: first visit vs returning visitor (seen within 7 days) vs prefers-reduced-motion, plus tap-to-skip.
Measures on /p/home: time until #boot is gone (content usable), LCP (buffered observer), FCP; on /: time until the tab bar shows.
  python3 tools/boot_timing.py <base> [label]     e.g. a preview of backup/pre-audit2/site on another port for the "before" numbers."""
import asyncio, sys, json
from playwright.async_api import async_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8767'
LABEL = sys.argv[2] if len(sys.argv) > 2 else BASE
GONE = "()=>!document.querySelector('#boot')"
MET = """()=>new Promise(r=>{let l=0;try{new PerformanceObserver(e=>{for(const x of e.getEntries())l=x.startTime}).observe({type:'largest-contentful-paint',buffered:true})}catch(e){}
  setTimeout(()=>{const f=performance.getEntriesByName('first-contentful-paint')[0];r({lcp:Math.round(l),fcp:f?Math.round(f.startTime):null})},50)})"""
async def home(ctx, n=3, skip=False):
    out = []
    for _ in range(n):
        p = await ctx.new_page(); await p.goto(BASE + '/p/home', wait_until='commit')
        if skip:
            await p.wait_for_selector('#boot', timeout=5000); await p.wait_for_timeout(150); await p.mouse.click(200, 200)
        await p.wait_for_function(GONE, timeout=10000, polling=16)
        t = await p.evaluate('Math.round(performance.now())'); m = await p.evaluate(MET)
        out.append({'gone': t, **m}); await p.close()
    return out
async def shell_bar(ctx):
    p = await ctx.new_page(); await p.goto(BASE + '/', wait_until='commit')
    await p.wait_for_function("()=>{const b=document.querySelector('#bar');return b&&!b.classList.contains('hide')}", timeout=10000, polling=16)
    t = await p.evaluate('Math.round(performance.now())'); await p.close(); return t
def med(xs, k): v = sorted(x[k] for x in xs if x[k] is not None); return v[len(v) // 2] if v else None
async def main():
    res = {}
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path='/usr/bin/chromium')
        for mode in ('first', 'return', 'reduced', 'skip'):
            ctx = await b.new_context(viewport={'width': 1280, 'height': 800}, reduced_motion='reduce' if mode == 'reduced' else 'no-preference')
            await ctx.add_init_script("try{localStorage.getItem('wqzAnnSeen')||localStorage.setItem('wqzAnnSeen','*')}catch(e){}")   # no update popup during tests (tools/ann_test.py covers it)
            if mode in ('first', 'reduced', 'skip'):
                # every run is a fresh visitor: clear the "seen" stamp before each page
                await ctx.add_init_script("try{if(!sessionStorage.getItem('keep'))localStorage.removeItem('wqzBootSeen')}catch(e){}")
            else:
                p = await ctx.new_page(); await p.goto(BASE + '/p/home'); await p.wait_for_timeout(2600); await p.close()   # first visit stamps it
            h = await home(ctx, skip=(mode == 'skip')); bar = await shell_bar(ctx) if mode != 'skip' else None
            res[mode] = {'boot_gone_ms': med(h, 'gone'), 'lcp_ms': med(h, 'lcp'), 'fcp_ms': med(h, 'fcp'), 'bar_visible_ms': bar}
            await ctx.close()
        await b.close()
    print(LABEL, json.dumps(res, ensure_ascii=False))
asyncio.run(main())
