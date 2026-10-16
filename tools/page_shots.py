# Deterministic page screenshots for pixel-diffing CSS refactors. Usage: python3 tools/page_shots.py <label> [base]
# -> work/shots/pg_<label>_<page>_<w>.png ; animations/transitions frozen, boot hidden, /api stubbed (empty data).
import asyncio, sys
from playwright.async_api import async_playwright
LABEL = sys.argv[1]; BASE = sys.argv[2] if len(sys.argv) > 2 else 'http://127.0.0.1:8766'
OUT = __file__.rsplit('/', 2)[0] + '/work/shots/'
UA = 'Mozilla/5.0 (Linux; Android 14; 23127PN0CC) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36 EdgA/129.0.0.0'
FREEZE = "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}#boot{display:none!important}"
PAGES = ['/p/home', '/p/drive', '/p/ai', '/p/chat', '/admin']
async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path='/usr/bin/chromium')
        for w in [390, 1280]:
            ctx = await b.new_context(viewport={'width': w, 'height': 900}, user_agent=UA if w < 500 else None, is_mobile=w < 500, has_touch=w < 500)
            await ctx.route('**/api/**', lambda r: r.fulfill(status=200, content_type='application/json', body='{"files":[],"folders":[],"used":0,"cap":"100 GB","models":[]}'))
            await ctx.add_init_script("document.addEventListener('DOMContentLoaded',()=>{const s=document.createElement('style');s.textContent=%r;document.head.appendChild(s)})" % FREEZE)
            p = await ctx.new_page()
            for path in PAGES:
                await p.goto(BASE + path, wait_until='load'); await p.wait_for_timeout(1500)
                await p.evaluate("document.querySelectorAll('.rv,.bt').forEach(e=>e.classList.add('in'))")
                await p.wait_for_timeout(300)
                await p.screenshot(path=f"{OUT}pg_{LABEL}_{path.strip('/').replace('/', '_')}_{w}.png")
            await ctx.close()
        await b.close()
asyncio.run(main())
