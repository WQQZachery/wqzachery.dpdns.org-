#!/usr/bin/env python3
"""Drive page: keyboard-only upload, parallel pool (<=3), per-file failure + single retry, drag & drop, mouse pick,
new-folder dialog (empty / a/b / .x / duplicate / Esc / server error / success, no double submit).
Runs against the MOCK API (nothing written to the live drive):
  MPORT=8768 python3 tools/mock_api.py &   env -u HTTP_PROXY -u HTTPS_PROXY PORT=8767 UP=http://127.0.0.1:8768 python3 tools/lproxy.py &
  python3 tools/drive_test.py [http://127.0.0.1:8767] [up|mk|all]"""
import asyncio, sys, json, urllib.request
from playwright.async_api import async_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1].startswith('http') else 'http://127.0.0.1:8767'
PART = (sys.argv[-1] if sys.argv[-1] in ('up', 'mk', 'all') else 'all')
ok = bad = 0
def check(n, c, i=''):
    global ok, bad
    if c: ok += 1; print('PASS', n)
    else: bad += 1; print('FAIL', n, str(i)[:400])
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
def stats(): return json.loads(op.open(BASE + '/api/__stats').read())
def reset(): op.open(urllib.request.Request(BASE + '/api/__reset', data=b'{}', method='POST'))
def fl(name, n=2048): return {'name': name, 'mimeType': 'text/plain', 'buffer': (name * 50).encode()[:n] or b'x'}
ROWS = "[...document.querySelectorAll('#ups .up')].map(r=>({n:r.querySelector('.un').textContent,c:r.className,t:r.querySelector('.ut').textContent}))"

async def up_tests(p):
    # ---- keyboard only: Tab until the upload button has focus, Enter opens the chooser
    await p.goto(BASE + '/p/drive'); await p.wait_for_timeout(600)
    await p.evaluate("document.activeElement&&document.activeElement.blur()")
    seen = []
    for _ in range(40):
        await p.keyboard.press('Tab')
        idv = await p.evaluate("document.activeElement.id||document.activeElement.textContent.trim().slice(0,10)")
        seen.append(idv)
        if idv == 'pick': break
    check('keyboard: Tab reaches the upload button (#pick)', seen[-1] == 'pick', seen)
    vis = await p.evaluate("(()=>{const s=getComputedStyle(document.activeElement);return s.outlineStyle!=='none'&&parseFloat(s.outlineWidth)>0})()")
    check('keyboard: visible focus ring on #pick', vis)
    name = await p.evaluate("document.activeElement.textContent.trim()")
    check('keyboard: accessible name', '上传' in name, name)
    async with p.expect_file_chooser(timeout=8000) as fc:
        await p.keyboard.press('Enter')
    ch = await fc.value
    check('keyboard: Enter opens the file chooser (multiple)', ch.is_multiple())
    await ch.set_files([fl('kb1.txt')])
    await p.wait_for_function("[...document.querySelectorAll('#ups .up')].some(r=>r.classList.contains('ok'))", timeout=15000)
    await p.wait_for_timeout(300); sr = await p.inner_text('#upsr'); check('keyboard: success announced in live region', '上传成功' in sr, sr)
    # Space also works
    await p.focus('#pick')
    async with p.expect_file_chooser(timeout=8000) as fc:
        await p.keyboard.press('Space')
    await (await fc.value).set_files([])
    check('keyboard: Space opens the file chooser', True)
    # ---- mouse: clicking the drop zone opens the chooser
    async with p.expect_file_chooser(timeout=8000) as fc:
        await p.click('#drop b')
    await (await fc.value).set_files([])
    check('mouse: clicking the drop zone opens the chooser', True)
    # ---- 5 files: <=3 at once, one failing (finish 502 once), one rejected at init (bad), others finish
    reset(); await p.reload(); await p.wait_for_timeout(500)
    files = [fl('a1.txt'), fl('a2.txt'), fl('x-failonce.txt'), fl('a4.txt'), fl('bad-5.txt')]
    t0 = asyncio.get_event_loop().time()
    await p.set_input_files('#file', files)
    await p.wait_for_function("(()=>{const r=[...document.querySelectorAll('#ups .up')];return r.length>=5&&r.every(x=>/\\b(ok|err)\\b/.test(x.className))})()", timeout=30000)
    dt = asyncio.get_event_loop().time() - t0
    s = stats(); rows = await p.evaluate(ROWS)
    check('pool: never more than 3 uploads at once', s['put_max'] <= 3, s['put_max'])
    check('pool: really parallel (>1 at once)', s['put_max'] >= 2, s['put_max'])
    check('pool: 4 uploads × 1.2 s finished faster than serial (<4.8 s)', dt < 4.8, round(dt, 2))
    oks = [r['n'] for r in rows if ' ok' in r['c']]; errs = [r for r in rows if ' err' in r['c']]
    check('one failure does not stop the others (a1,a2,a4 ok)', set(oks) >= {'a1.txt', 'a2.txt', 'a4.txt'}, rows)
    check('each failed file has its own error text', len(errs) == 2 and all('上传失败' in r['t'] for r in errs), errs)
    # ---- duplicate pick while queued is skipped
    # ---- single retry of the failed save step: only /api/up/finish repeats, exactly once even on double click
    s0 = stats(); rb = p.locator('#ups .up.err', has_text='x-failonce.txt').locator('.rt')
    check('retry button visible on the failed file', await rb.is_visible())
    await rb.dblclick()
    await p.wait_for_function("[...document.querySelectorAll('#ups .up')].some(r=>r.textContent.includes('x-failonce')&&r.classList.contains('ok'))", timeout=15000)
    s1 = stats()
    check('retry: re-saved once (finish +1, no new init/PUT)', s1['finish'] - s0['finish'] == 1 and s1['init'] == s0['init'] and s1['puts'] == s0['puts'], (s0, s1))
    await p.wait_for_timeout(900)
    names = await p.evaluate("[...document.querySelectorAll('#list [data-path], #list .it, #list li')].map(e=>e.textContent).join('|')")
    check('list refreshed with uploaded files', 'a1.txt' in names and 'x-failonce.txt' in names, names[:300])
    # ---- bad file: retry runs init again and fails again (server keeps rejecting), no duplicate rows
    s0 = stats(); await p.locator('#ups .up.err', has_text='bad-5.txt').locator('.rt').click()
    await p.wait_for_function("[...document.querySelectorAll('#ups .up')].some(r=>r.textContent.includes('bad-5')&&r.classList.contains('err'))", timeout=15000)
    s1 = stats(); n = await p.locator('#ups .up', has_text='bad-5.txt').count()
    check('retry of init failure: one new init, still shown as failed, single row', s1['init'] - s0['init'] == 1 and n == 1, (s1['init'] - s0['init'], n))
    # ---- same file twice while uploading → second is skipped
    reset(); await p.reload(); await p.wait_for_timeout(500)
    # (a real re-pick gives the same name/size/lastModified; set_input_files would stamp a new lastModified, so drop the same File twice)
    await p.evaluate("""()=>{const f=new File(['same bytes'],'dup.txt',{type:'text/plain',lastModified:1700000000000});
      for(let k=0;k<2;k++){const dt=new DataTransfer();dt.items.add(f);document.querySelector('#drop').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}))}}""")
    await p.wait_for_timeout(2500)
    s = stats(); check('duplicate pick while uploading is skipped (1 init)', s['init'] == 1, s['init'])
    # ---- drag & drop still works
    reset()
    await p.evaluate("""()=>{const dt=new DataTransfer();dt.items.add(new File(['hello drop'],'drop.txt',{type:'text/plain'}));
      const d=document.querySelector('#drop');for(const t of ['dragenter','dragover','drop'])d.dispatchEvent(new DragEvent(t,{bubbles:true,cancelable:true,dataTransfer:dt}))}""")
    await p.wait_for_function("[...document.querySelectorAll('#ups .up')].some(r=>r.textContent.includes('drop.txt')&&r.classList.contains('ok'))", timeout=15000)
    check('drag & drop upload works', stats()['finish'] == 1)

async def mk_tests(p):
    reset(); await p.goto(BASE + '/p/drive'); await p.wait_for_timeout(700)
    await p.focus('#mk'); await p.keyboard.press('Enter'); await p.wait_for_timeout(100)
    check('mk: dialog opens from keyboard, focus in name field', await p.is_visible('#mkd') and await p.evaluate("document.activeElement.id") == 'mkn')
    async def tryname(n):
        await p.fill('#mkn', n); await p.keyboard.press('Enter'); await p.wait_for_timeout(250)
        return (await p.inner_text('#mkm')).strip()
    s0 = stats()['folders_post']
    m = await tryname('');        check('mk: empty name rejected', '请输入' in m, m)
    m = await tryname('   ');     check('mk: blank name rejected', '请输入' in m, m)
    m = await tryname('a/b');     check('mk: a/b rejected', '不能包含' in m, m)
    m = await tryname('.x');      check('mk: .x rejected', '点开头' in m, m)
    m = await tryname('照片');    check('mk: duplicate (known) rejected', '同名' in m, m)
    check('mk: invalid names never reach the server', stats()['folders_post'] == s0)
    check('mk: field marked aria-invalid', await p.get_attribute('#mkn', 'aria-invalid') == 'true')
    # server-side duplicate (created elsewhere after the list loaded)
    op.open(urllib.request.Request(BASE + '/api/folders', data=json.dumps({'path': '别处'}).encode(), headers={'content-type': 'application/json'}, method='POST'))
    m = await tryname('别处'); check('mk: server 409 duplicate shown, dialog stays', '同名' in m and await p.is_visible('#mkd'), m)
    m = await tryname('boom'); await p.wait_for_timeout(300)
    m = (await p.inner_text('#mkm')).strip()
    check('mk: server error shown, button re-enabled', '创建失败' in m and not await p.is_disabled('#mks'), m)
    await p.keyboard.press('Escape'); await p.wait_for_timeout(100)
    check('mk: Esc closes, focus back on ＋ 文件夹', not await p.is_visible('#mkd') and await p.evaluate("document.activeElement.id") == 'mk')
    # success, double submit → one request
    await p.click('#mk'); await p.fill('#mkn', '新文件夹'); s0 = stats()['folders_post']
    await p.evaluate("document.querySelector('#mks').click();document.querySelector('#mks').click()")
    txt = await p.inner_text('#mks'); check('mk: waiting state while creating', '创建中' in txt, txt)
    await p.wait_for_function("document.querySelector('#mkd').hidden", timeout=5000)
    check('mk: double submit sends one request', stats()['folders_post'] - s0 == 1, stats()['folders_post'] - s0)
    msg = await p.inner_text('#msg'); check('mk: success message', '已创建' in msg, msg)
    dest = await p.inner_text('#dest'); check('mk: opened the new folder', '新文件夹' in dest, dest)
    # cancel button
    await p.click('#mk'); await p.click('#mkc'); check('mk: 取消 closes', not await p.is_visible('#mkd'))

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path='/usr/bin/chromium')
        ctx = await b.new_context(viewport={'width': 1200, 'height': 900})
        await ctx.add_init_script("try{localStorage.getItem('wqzAnnSeen')||localStorage.setItem('wqzAnnSeen','*')}catch(e){}")   # no update popup during tests (tools/ann_test.py covers it)
        p = await ctx.new_page(); errs = []; p.on('pageerror', lambda e: errs.append(str(e)))
        p.on('filechooser', lambda fc: None)   # turn on chooser interception before the first key press
        await p.goto(BASE + '/p/drive'); await p.wait_for_timeout(300)
        if PART in ('up', 'all'): await up_tests(p)
        if PART in ('mk', 'all'): await mk_tests(p)
        check('no page errors', not errs, errs)
        await b.close()
    print(f'{ok} passed, {bad} failed'); sys.exit(1 if bad else 0)
asyncio.run(main())
