#!/usr/bin/env python3
"""Shell tab switching: per-pane loading state, slow page, failed page + 重新加载, fast switching (no duplicate loads,
no stale pane shown), no JS errors. Uses playwright routing to slow down / fail the /p/* pages.
  python3 tools/tab_test.py [base]      (base = a tools/lproxy.py preview, default http://127.0.0.1:8767)"""
import asyncio, sys
from playwright.async_api import async_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8767'
ok = bad = 0
def check(n, c, i=''):
    global ok, bad
    if c: ok += 1; print('PASS', n)
    else: bad += 1; print('FAIL', n, str(i)[:300])
async def tab(p, i):
    await p.focus(f'#row .it[data-i="{i}"]'); await p.keyboard.press('Enter')
ON = "[...document.querySelectorAll('.pane')].findIndex(x=>x.classList.contains('on'))"
async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path='/usr/bin/chromium')
        ctx = await b.new_context(viewport={'width': 1200, 'height': 860})
        await ctx.add_init_script("try{localStorage.getItem('wqzAnnSeen')||localStorage.setItem('wqzAnnSeen','*')}catch(e){}")   # no update popup during tests (tools/ann_test.py covers it)
        p = await ctx.new_page(); errs = []; p.on('pageerror', lambda e: errs.append(str(e)))
        reqs = {}
        p.on('request', lambda r: reqs.__setitem__(r.url.split('?')[0].replace(BASE, ''), reqs.get(r.url.split('?')[0].replace(BASE, ''), 0) + 1))
        fail_chat = {'on': True}
        async def slow_drive(route):
            await asyncio.sleep(4); await route.continue_()
        async def chat_route(route):
            if fail_chat['on']: await route.fulfill(status=503, content_type='text/html', body='<h1>503 Service Unavailable</h1>')
            else: await route.continue_()
        await p.route('**/p/drive', slow_drive); await p.route('**/p/chat', chat_route)
        await p.goto(BASE + '/ai'); await p.wait_for_timeout(300)
        st = await p.evaluate('window.__paneState()')
        check('start on /ai: no TDZ error, AI pane loading/ok', st[2] in ('loading', 'ok') and not errs, (st, errs))
        await p.wait_for_timeout(700)
        # fast switching while drive is still slow: ai → drive → home → drive
        await tab(p, 1); await p.wait_for_timeout(120); await tab(p, 0); await p.wait_for_timeout(120); await tab(p, 1)
        await p.wait_for_function(f'{ON}===1', timeout=5000)
        await p.wait_for_timeout(500)
        ph = p.locator('.pane[data-tab=drive] .ph')
        vis = await ph.is_visible(); txt = (await ph.inner_text()) if vis else ''
        check('slow page: spinner + 正在加载 shown in the drive pane (no black screen)', vis and '正在加载' in txt, txt)
        check('slow page: status role for screen readers', await ph.get_attribute('role') == 'status')
        await p.wait_for_function("window.__paneState()[1]==='ok'", timeout=12000)
        check('slow page: placeholder removed once loaded', await ph.count() == 0)
        check('drive pane still the visible one (no stale pane swap)', await p.evaluate(ON) == 1)
        check('fast switching: /p/drive requested once', reqs.get('/p/drive') == 1, reqs.get('/p/drive'))
        # failed page
        await tab(p, 3); await p.wait_for_function(f'{ON}===3', timeout=5000)
        await p.wait_for_function("window.__paneState()[3]==='err'", timeout=8000)
        e = p.locator('.pane[data-tab=chat] .ph.err'); t = await e.inner_text()
        check('failed page: error text + 重新加载 button (role=alert)', '失败' in t and '重新加载' in t and await e.get_attribute('role') == 'alert', t)
        n0 = reqs.get('/p/chat', 0); fail_chat['on'] = False
        await e.locator('button').click()
        await p.wait_for_function("window.__paneState()[3]==='ok'", timeout=8000)
        check('retry: chat pane reloads and works', await p.locator('.pane[data-tab=chat] .ph').count() == 0 and reqs.get('/p/chat', 0) - n0 == 1, reqs.get('/p/chat'))
        # switching back and forth does not reload anything
        before = dict(reqs)
        for i in (0, 2, 1, 3, 0, 2):
            await tab(p, i); await p.wait_for_timeout(250)
        check('switching between loaded tabs makes no new page requests', all(reqs.get(k, 0) == before.get(k, 0) for k in ('/p/home', '/p/drive', '/p/ai', '/p/chat')), {k: (before.get(k), reqs.get(k)) for k in ('/p/home', '/p/drive', '/p/ai', '/p/chat')})
        check('every pane ok', await p.evaluate('window.__paneState()') == ['ok'] * 4, await p.evaluate('window.__paneState()'))
        # home first visit: no TDZ, bar appears
        p2 = await ctx.new_page(); e2 = []; p2.on('pageerror', lambda e: e2.append(str(e)))
        await p2.goto(BASE + '/'); await p2.wait_for_timeout(3200)
        check('/ loads: all panes start, no page errors', not e2 and (await p2.evaluate('window.__paneState()'))[0] == 'ok', (e2, await p2.evaluate('window.__paneState()')))
        check('/ bar visible after boot', not await p2.evaluate("document.querySelector('#bar').classList.contains('hide')"))
        check('no page errors', not errs, errs)
        await b.close()
    print(f'{ok} passed, {bad} failed'); sys.exit(1 if bad else 0)
asyncio.run(main())
