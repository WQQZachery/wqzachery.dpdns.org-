#!/usr/bin/env python3
"""AI page: local multi-session history, copy, retry/regenerate, interrupted streams, save failure, screen-reader hooks.
Runs against the MOCK API (no real AI calls, nothing written to the live site):
  MPORT=8768 python3 tools/mock_api.py &   env -u HTTP_PROXY -u HTTPS_PROXY PORT=8767 UP=http://127.0.0.1:8768 python3 tools/lproxy.py &
  python3 tools/ai_persist_test.py [http://127.0.0.1:8767]"""
import asyncio, sys, json, urllib.request
from playwright.async_api import async_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8767'
ok = bad = 0
def check(n, c, i=''):
    global ok, bad
    if c: ok += 1; print('PASS', n)
    else: bad += 1; print('FAIL', n, str(i)[:400])
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
def stats(): return json.loads(op.open(BASE + '/api/__stats').read())
def reset(): op.open(urllib.request.Request(BASE + '/api/__reset', data=b'{}', method='POST'))
DB = "JSON.parse(localStorage.getItem('astra.v2')||'null')"
async def send(p, t):
    await p.fill('#in', t); await p.click('#send')
async def idle(p, ms=15000):
    await p.wait_for_function("!document.querySelector('#send.stop')", timeout=ms)
async def main():
    reset()
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path='/usr/bin/chromium')
        ctx = await b.new_context(viewport={'width': 1200, 'height': 900})
        await ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin=BASE)
        p = await ctx.new_page(); errs = []; p.on('pageerror', lambda e: errs.append(str(e)))
        rej = []; p.on('console', lambda m: rej.append(m.text) if 'Unhandled' in m.text or m.type == 'error' else None)
        # ---- migration from the old sessionStorage copy
        await p.goto(BASE + '/p/ai')
        await p.evaluate("""sessionStorage.setItem('astra',JSON.stringify({sid:'old-sid-1',hist:[{role:'user',content:'旧问题'},{role:'assistant',content:'旧回答'}]}));localStorage.removeItem('astra.v2')""")
        await p.reload(); await p.wait_for_timeout(500)
        db = await p.evaluate(DB); txt = await p.inner_text('#inner')
        check('migration: old sessionStorage chat imported into v2 store + shown', db and any(s['id'] == 'old-sid-1' for s in db['list']) and '旧回答' in txt, (db, txt[:100]))
        check('migration: old sessionStorage key removed', await p.evaluate("sessionStorage.getItem('astra')") is None)
        # ---- new conversation, send, reply saved
        await p.click('#new'); await send(p, '你好 A'); await idle(p)
        db = await p.evaluate(DB); cur = [s for s in db['list'] if s['id'] == db['cur']][0]
        check('send: user + assistant saved after reply', [m['role'] for m in cur['msgs']] == ['user', 'assistant'] and '收到' in cur['msgs'][1]['content'], cur)
        check('send: session title from first message', cur['title'] == '你好 A', cur['title'])
        # ---- close the page, open again → restored
        sid = db['cur']; await p.close()
        p = await ctx.new_page(); p.on('pageerror', lambda e: errs.append(str(e)))
        await p.goto(BASE + '/p/ai'); await p.wait_for_timeout(400)
        t = await p.inner_text('#inner')
        check('reopen: conversation restored after closing the page', '你好 A' in t and '收到' in t, t[:200])
        # ---- reopen through the shell (/ai tab) also restores
        p2 = await ctx.new_page(); await p2.goto(BASE + '/ai'); await p2.wait_for_timeout(1500)
        fr = p2.frame_locator('section[data-tab=ai] iframe'); t2 = await fr.locator('#inner').inner_text()
        check('reopen via /ai shell: restored', '你好 A' in t2, t2[:100]); await p2.close()
        # ---- second session, history list, switch, delete
        await p.click('#new'); await send(p, '第二个对话'); await idle(p)
        await p.click('#hist'); await p.wait_for_selector('#hs.on')
        items = await p.locator('#hsl .hi').all_inner_texts()
        check('history: lists all saved sessions (3)', len(items) == 3 and any('你好 A' in x for x in items), items)
        await p.locator('#hsl .hi', has_text='你好 A').click(); await p.wait_for_timeout(200)
        t = await p.inner_text('#inner'); check('history: switch shows that session', '你好 A' in t and '第二个对话' not in t, t[:120])
        await p.click('#hist'); await p.locator('#hsl li', has_text='第二个对话').locator('[data-del]').click()
        check('history: delete needs a second tap (确认删除)', await p.locator('#hsl [data-del].arm').count() == 1)
        await p.locator('#hsl [data-del].arm').click(); await p.wait_for_timeout(150)
        db = await p.evaluate(DB)
        check('history: delete removes it from storage', not any(s['title'] == '第二个对话' for s in db['list']) and len(db['list']) == 2, [s['title'] for s in db['list']])
        await p.keyboard.press('Escape'); check('history: Esc closes the sheet', not await p.locator('#hs.on').count())
        # ---- empty session is not saved
        await p.click('#new'); await p.wait_for_timeout(100)
        db = await p.evaluate(DB); check('empty new conversation is not stored', len(db['list']) == 2, len(db['list']))
        # ---- partial save during a slow stream + reload mid-stream
        await send(p, '长回答 #slow'); await p.wait_for_timeout(3200)
        db = await p.evaluate(DB); cur = [s for s in db['list'] if s['id'] == db['cur']][0]
        check('streaming: partial reply saved while it streams (st=partial)', cur['msgs'][-1].get('st') == 'partial' and len(cur['msgs'][-1]['content']) > 5, cur['msgs'][-1])
        sr_busy = await p.evaluate("!!document.querySelector('.msg.a[aria-busy=true]')")
        check('a11y: streaming bubble is aria-busy', sr_busy)
        live = await p.inner_text('#sr'); check('a11y: polite live region announced the start', '正在回答' in live, live)
        await p.reload(); await p.wait_for_timeout(500)
        t = await p.inner_text('#inner'); check('reload mid-stream: partial reply kept, marked 回答被中断', '第0段' in t and '回答被中断' in t, t[-200:])
        await p.wait_for_timeout(9000)   # let the mock finish the abandoned stream
        # ---- copy reply + code block
        await p.click('#new'); await send(p, '给我代码 #code'); await idle(p)
        await p.locator('.acts [data-act=copy]').last.click(); await p.wait_for_timeout(200)
        clip = await p.evaluate('navigator.clipboard.readText()')
        check('copy: whole reply copied as original markdown', '```python' in clip and 'print("hi")' in clip, clip)
        check('copy: button shows 已复制', '已复制' in await p.locator('.acts [data-act=copy]').last.inner_text())
        await p.locator('.cpb').last.click(); await p.wait_for_timeout(200)
        clip = await p.evaluate('navigator.clipboard.readText()')
        check('copy: code-block button copies only the code', clip.strip() == 'print("hi")', clip)
        live = await p.inner_text('#sr'); check('a11y: copy result announced', '复制' in live, live)
        # ---- retry after a server error really re-sends
        n0 = stats()['chat']; await send(p, '会失败一次 #failonce'); await idle(p)
        t = await p.inner_text('#inner'); check('error: message shown with 重试', '模拟：服务器出错了' in t and await p.locator('[data-act=retry]').count() == 1, t[-150:])
        db = await p.evaluate(DB); cur = [s for s in db['list'] if s['id'] == db['cur']][0]
        check('error: the user message is kept (not silently dropped)', cur['msgs'][-1]['content'] == '会失败一次 #failonce')
        await p.locator('[data-act=retry]').dblclick(); await idle(p)
        n1 = stats()['chat']; t = await p.inner_text('#inner')
        check('retry: re-sent exactly once (double click ignored) and answered', n1 - n0 == 2 and '收到：会失败一次' in t, (n1 - n0, t[-120:]))
        # ---- regenerate the last reply
        n0 = stats()['chat']; await p.locator('[data-act=regen]').click(); await idle(p)
        db = await p.evaluate(DB); cur = [s for s in db['list'] if s['id'] == db['cur']][0]
        check('regenerate: new request, old reply replaced (no duplicate)', stats()['chat'] - n0 == 1 and [m['role'] for m in cur['msgs']][-2:] == ['user', 'assistant'] and sum(1 for m in cur['msgs'] if m['role'] == 'assistant' and '会失败一次' in m['content']) == 1, [m['content'][:20] for m in cur['msgs']])
        # ---- cut stream (no done event) → kept as interrupted + regenerate offered
        await send(p, '断开 #cut'); await idle(p)
        t = await p.inner_text('#inner')
        check('cut stream: partial kept, marked interrupted, 重新生成 offered', '会被中断的' in t and '连接意外断开' in t and await p.locator('[data-act=regen]').count() == 1, t[-200:])
        # ---- SSE error event
        await send(p, '报错 #err'); await idle(p)
        t = await p.inner_text('#inner'); check('SSE error: shown with retry', 'AI 暂时不可用' in t and await p.locator('[data-act=retry]').count() == 1, t[-120:])
        # ---- stop button keeps partial
        await send(p, '停止 #slow'); await p.wait_for_timeout(1600); await p.click('#send'); await idle(p)
        db = await p.evaluate(DB); cur = [s for s in db['list'] if s['id'] == db['cur']][0]
        check('stop: partial reply saved as stopped', cur['msgs'][-1]['role'] == 'assistant' and cur['msgs'][-1].get('st') == 'stopped', cur['msgs'][-1])
        await p.wait_for_timeout(9000)
        # ---- save failure is visible
        await p.evaluate("()=>{Storage.prototype.setItem=function(){const e=new Error('quota');e.name='QuotaExceededError';throw e}}")
        await send(p, '保存失败测试'); await idle(p)
        sv = await p.locator('#sv').inner_text(); vis = await p.locator('#sv').is_visible()
        check('save failure: visible warning (not silently "saved")', vis and '没能保存' in sv, sv)
        await p.screenshot(path=__file__.rsplit('/', 2)[0] + '/work/shots/ai_save_fail.png')
        # ---- keyboard: history button reachable and has state
        exp = await p.get_attribute('#hist', 'aria-expanded'); check('a11y: history button exposes aria-expanded', exp == 'false', exp)
        check('no page errors', not errs, errs)
        await b.close()
    print(f'{ok} passed, {bad} failed'); sys.exit(1 if bad else 0)
asyncio.run(main())
