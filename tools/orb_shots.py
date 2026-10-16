# Screenshot home (and admin field) at fixed scroll offsets, for before/after visual compare.
# Usage: python3 tools/orb_shots.py <label> [base]   -> work/shots/orb_<label>_<n>.png  (needs tools/lproxy.py)
import asyncio, sys
from playwright.async_api import async_playwright
LABEL = sys.argv[1] if len(sys.argv) > 1 else 'x'
BASE = sys.argv[2] if len(sys.argv) > 2 else 'http://127.0.0.1:8766'
UA = 'Mozilla/5.0 (Linux; Android 14; 23127PN0CC) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36 EdgA/129.0.0.0'
OUT = __file__.rsplit('/', 2)[0] + '/work/shots/'
async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path='/usr/bin/chromium')
        for vw, vh, tag in [(402, 874, 'm'), (1280, 800, 'd')]:
            ctx = await b.new_context(viewport={'width': vw, 'height': vh}, device_scale_factor=1, is_mobile=tag == 'm', has_touch=tag == 'm', user_agent=UA if tag == 'm' else None)
            p = await ctx.new_page()
            await p.goto(BASE + '/p/home', wait_until='load'); await p.wait_for_timeout(3000)
            for i, y in enumerate([0, 1200, 'contact']):
                if y == 'contact': await p.evaluate("document.querySelector('.contact')&&document.querySelector('.contact').scrollIntoView()")
                else: await p.evaluate(f'scrollTo(0,{y})')
                await p.wait_for_timeout(700)
                await p.screenshot(path=f'{OUT}orb_{LABEL}_{tag}{i}.png')
            await p.goto(BASE + '/admin', wait_until='load'); await p.wait_for_timeout(1200)
            await p.screenshot(path=f'{OUT}orb_{LABEL}_{tag}admin.png')
            await ctx.close()
        await b.close()
asyncio.run(main())
