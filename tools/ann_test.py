#!/usr/bin/env python3
"""Update announcement + changelog dialog (shared.js wqzAnnounce / wqzChangelog, data /announcements.json).
  python3 tools/ann_test.py [base] [part]   base default http://127.0.0.1:8767 (lproxy + mock API); part = shell|more|all (default all)
Checks: popup only after the boot animation; once per id (localStorage wqzAnnSeen); a newer id shows again; dialog a11y
(role/aria-modal/label, focus inside, Tab trap, Esc, focus return, rest inert); 更新日志 history; home footer chip → shell dialog;
standalone /p/home; landing on /drive; phone 390x844 fits; reduced motion; text contrast; no console errors."""
import asyncio, sys, json
from playwright.async_api import async_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8767'
PART = sys.argv[2] if len(sys.argv) > 2 else 'all'
R = []
def ok(name, cond, extra=''):
    R.append((name, bool(cond))); print(('PASS ' if cond else 'FAIL ') + name + (('  ' + str(extra)) if extra and not cond else ''))
OPEN = "()=>{const o=document.getElementById('wz-an');return !!(o&&o.classList.contains('on'))}"
async def newest():
    import urllib.request
    op = urllib.request.build_opener(urllib.request.ProxyHandler({})) if '127.0.0.1' in BASE or 'localhost' in BASE else urllib.request.build_opener()
    j = json.loads(op.open(urllib.request.Request(BASE + '/announcements.json', headers={'User-Agent': 'Mozilla/5.0 ann-test'})).read())
    return next(x for x in j['entries'] if x.get('popup')), j['entries']
def lum(c):
    def ch(v):
        v /= 255; return v / 12.92 if v <= .03928 else ((v + .055) / 1.055) ** 2.4
    return .2126 * ch(c[0]) + .7152 * ch(c[1]) + .0722 * ch(c[2])
def cr(a, b):
    la, lb = sorted([lum(a), lum(b)], reverse=True); return (la + .05) / (lb + .05)
async def ctxp(b, errs, **kw):
    ctx = await b.new_context(**kw); p = await ctx.new_page()
    # the mock API has no /api/stats etc.: its 404s (and Chrome's matching 'Failed to load resource' lines) are not page errors
    p.on('console', lambda m: m.type == 'error' and not m.text.startswith('Failed to load resource') and '/api/' not in m.text and errs.append(m.text))
    p.on('pageerror', lambda e: errs.append(str(e)))
    p.on('response', lambda r: r.status >= 400 and '/api/' not in r.url and errs.append(f'{r.status} {r.url}'))
    return ctx, p
async def shell(b, ann, entries):
    errs = []
    ctx, p = await ctxp(b, errs, viewport={'width': 1280, 'height': 800})
    await ctx.add_init_script("try{if(!sessionStorage.getItem('k')){localStorage.removeItem('wqzBootSeen');localStorage.removeItem('wqzAnnSeen');sessionStorage.setItem('k','1')}}catch(e){}")
    await p.goto(BASE + '/', wait_until='commit')
    # sample while the boot animation runs: the dialog must never be up while #boot exists in the home iframe
    during = False; t0 = await p.evaluate('performance.now()'); boot_seen = False
    for _ in range(120):
        st = await p.evaluate("""()=>{const f=document.querySelector('.pane[data-tab=home] iframe');let boot=null;try{boot=!!(f&&f.contentDocument&&f.contentDocument.querySelector('#boot'))}catch(e){}
          const o=document.getElementById('wz-an');return {boot,dlg:!!o}}""")
        if st['boot']: boot_seen = True
        if st['boot'] and st['dlg']: during = True
        if st['dlg'] and not st['boot'] and boot_seen: break
        await p.wait_for_timeout(50)
    ok('boot animation was observed', boot_seen)
    ok('popup never shown during boot', not during)
    await p.wait_for_function(OPEN, timeout=12000)
    t = await p.evaluate('performance.now()')
    ok('popup shown after boot (fresh visitor)', True, round(t - t0))
    await p.wait_for_timeout(450)   # let the open transition finish before measuring
    a = await p.evaluate("""()=>{const d=document.querySelector('#wz-an [role=dialog]');const lab=document.getElementById(d.getAttribute('aria-labelledby'));
      return {modal:d.getAttribute('aria-modal'),label:lab&&lab.textContent,desc:!!d.getAttribute('aria-describedby'),focus:document.activeElement&&document.activeElement.textContent,
        inDlg:d.contains(document.activeElement),viewportInert:document.getElementById('viewport').inert,barInert:document.getElementById('bar').inert,
        ver:(document.querySelector('#wz-an .wz-anv')||{}).textContent,items:document.querySelectorAll('#wz-an .wz-ani li').length,
        btns:[...document.querySelectorAll('#wz-an button')].map(x=>({t:x.textContent||x.getAttribute('aria-label'),h:x.getBoundingClientRect().height,w:x.getBoundingClientRect().width}))}}""")
    ok('dialog aria-modal + labelled by title', a['modal'] == 'true' and a['label'] == ann['title'], a)
    ok('aria-describedby set', a['desc'])
    ok('focus starts on 我知道了', a['focus'] == '我知道了' and a['inDlg'], a['focus'])
    ok('page behind is inert (viewport + tab bar)', a['viewportInert'] and a['barInert'])
    ok('shows version + items', a['ver'] == 'v' + ann['version'] and a['items'] == len(ann['items']), a)
    ok('close × and buttons are >=44px', all(x['h'] >= 44 and x['w'] >= 44 for x in a['btns']), a['btns'])
    # Tab trap: 12 tabs forward + 5 back stay inside
    inside = True
    for k in ['Tab'] * 12 + ['Shift+Tab'] * 5:
        await p.keyboard.press(k)
        inside &= await p.evaluate("()=>document.getElementById('wz-an').contains(document.activeElement)")
    ok('focus trapped inside dialog (Tab / Shift+Tab)', inside)
    # contrast of the main texts against the panel colour composited over the dimmed page (worst case: white page behind is not possible; page is black)
    cols = await p.evaluate("""()=>{const g=e=>getComputedStyle(document.querySelector(e)).color;return {h:g('#wz-ant'),li:g('#wz-an .wz-ani li'),m:g('#wz-an .wz-anm'),k:g('#wz-an .wz-ank'),v:g('#wz-an .wz-anv'),bg:getComputedStyle(document.querySelector('#wz-an .wz-anp')).backgroundColor}}""")
    import re
    rgb = lambda s: [float(x) for x in re.findall(r'[\d.]+', s)][:4]
    bg = rgb(cols['bg']); al = bg[3] if len(bg) > 3 else 1
    panel = [bg[i] * al + 0 * (1 - al) for i in range(3)]   # page behind is black + 60% black scrim
    lift = [min(255, c + 12) for c in panel]               # allow for glass brightness/saturation lift
    worst = min(cr(rgb(cols[k])[:3], lift) for k in ('h', 'li', 'm', 'k', 'v'))
    ok('text contrast >= 4.5:1 on the glass panel', worst >= 4.5, round(worst, 2))
    await p.keyboard.press('Escape')
    await p.wait_for_function("()=>!document.getElementById('wz-an')", timeout=3000)
    s = await p.evaluate("localStorage.getItem('wqzAnnSeen')")
    ok('Esc closes and stores the id', s == ann['id'], s)
    ok('rest of page interactive again', not await p.evaluate("document.getElementById('viewport').inert||document.getElementById('bar').inert"))
    # reload: must not show again
    await p.reload(); await p.wait_for_timeout(5500)
    ok('not shown again after reading', not await p.evaluate("!!document.getElementById('wz-an')"))
    # a newer announcement (different id stored) → shows again; × closes; focus returns to what had it
    await p.evaluate("localStorage.setItem('wqzAnnSeen','older-id')"); await p.reload()
    await p.wait_for_function(OPEN, timeout=12000)
    ok('newer announcement id shows again', True)
    # 更新日志 from the popup → full history
    await p.click('#wz-an button.wz-an2')
    await p.wait_for_function("()=>document.querySelectorAll('#wz-an .wz-anl>li').length>0", timeout=5000)
    h = await p.evaluate("()=>({n:document.querySelectorAll('#wz-an .wz-anl>li').length,t:document.getElementById('wz-ant').textContent,dates:[...document.querySelectorAll('#wz-an .wz-anl time')].map(x=>x.textContent),vers:[...document.querySelectorAll('#wz-an .wz-anl .wz-anv')].map(x=>x.textContent)})")
    ok('history lists every entry', h['n'] == len(entries) and h['t'] == '更新日志', h)
    ok('history dates match data', h['dates'] == [e['date'] for e in entries])
    ok('only versioned entries show a version', len(h['vers']) == len([e for e in entries if e.get('version')]))
    await p.click('#wz-an .wz-anx'); await p.wait_for_function("()=>!document.getElementById('wz-an')", timeout=3000)
    ok('× closes and marks read', await p.evaluate("localStorage.getItem('wqzAnnSeen')") == ann['id'])
    # home footer chip (inside the iframe) → dialog opens in the SHELL (covers the tab bar), Esc returns focus to the chip
    fr = p.frame_locator('.pane[data-tab=home] iframe')
    chip = fr.locator('footer [data-changelog]')
    await chip.scroll_into_view_if_needed(); await chip.focus(); await p.keyboard.press('Enter')
    await p.wait_for_function("()=>document.querySelectorAll('#wz-an .wz-anl>li').length>0", timeout=5000)
    inner = await p.evaluate("()=>{const f=document.querySelector('.pane[data-tab=home] iframe');return !!f.contentDocument.getElementById('wz-an')}")
    ok('home 更新日志 chip opens the dialog in the shell, not the iframe', not inner)
    await p.keyboard.press('Escape')
    fb = False
    for _ in range(20):
        await p.wait_for_timeout(100)
        fb = await p.evaluate("()=>{const f=document.querySelector('.pane[data-tab=home] iframe');const a=f.contentDocument.activeElement;return {top:document.activeElement===f,inner:a&&(a.getAttribute('aria-label')||a.tagName)}}")
        if fb['top'] and fb['inner'] == '查看更新日志': break
    ok('focus returns to the 更新日志 chip', fb['top'] and fb['inner'] == '查看更新日志', fb)
    ok('no console errors (shell)', not errs, errs[:3])
    await ctx.close()
async def more(b, ann, entries):
    errs = []
    # landing on /drive (no boot animation): popup appears quickly, phone layout fits
    ctx, p = await ctxp(b, errs, viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, device_scale_factor=2)
    await p.goto(BASE + '/drive'); await p.wait_for_function(OPEN, timeout=8000)
    await p.wait_for_timeout(400)
    g = await p.evaluate("()=>{const r=document.querySelector('#wz-an .wz-anp').getBoundingClientRect();return {l:r.left,r:r.right,t:r.top,b:r.bottom,w:innerWidth,h:innerHeight,sw:document.documentElement.scrollWidth}}")
    ok('phone 390x844: panel inside viewport, no horizontal overflow', g['l'] >= 0 and g['r'] <= g['w'] and g['t'] >= 0 and g['b'] <= g['h'] and g['sw'] <= g['w'], g)
    await p.screenshot(path='/tmp/ann_phone.png')
    await p.tap('#wz-an button.wz-an1'); await p.wait_for_timeout(400)
    ok('我知道了 closes (touch)', not await p.evaluate("!!document.getElementById('wz-an')"))
    # history on a phone scrolls inside the panel
    await p.evaluate('wqzChangelog()'); await p.wait_for_function("()=>document.querySelectorAll('#wz-an .wz-anl>li').length>0")
    await p.wait_for_timeout(400)
    g2 = await p.evaluate("()=>{const b=document.querySelector('#wz-an .wz-anb'),r=document.querySelector('#wz-an .wz-anp').getBoundingClientRect();return {sc:b.scrollHeight>b.clientHeight,b:r.bottom,h:innerHeight}}")
    ok('phone history fits and scrolls inside', g2['b'] <= g2['h'], g2)
    await p.screenshot(path='/tmp/ann_phone_log.png')
    await p.tap('#wz-an .wz-anbd', position={'x': 20, 'y': 20}); await p.wait_for_timeout(400)
    ok('backdrop tap closes', not await p.evaluate("!!document.getElementById('wz-an')"))
    ok('no console errors (phone)', not errs, errs[:3]); await ctx.close()
    # reduced motion: still shown after the (static) boot, closes instantly
    errs = []
    ctx, p = await ctxp(b, errs, viewport={'width': 1280, 'height': 800}, reduced_motion='reduce')
    await p.goto(BASE + '/'); await p.wait_for_function(OPEN, timeout=12000)
    tr = await p.evaluate("getComputedStyle(document.querySelector('#wz-an .wz-anp')).transitionDuration")
    ok('reduced motion: no transition', set(x.strip() for x in tr.split(',')) == {'0s'}, tr)
    await p.screenshot(path='/tmp/ann_desktop.png')
    await p.click('#wz-an button.wz-an1')
    ok('reduced motion: closes immediately', not await p.evaluate("!!document.getElementById('wz-an')"))
    ok('no console errors (reduced)', not errs, errs[:3]); await ctx.close()
    # standalone /p/home (not in the shell): no popup, footer chip opens the dialog in the page itself
    errs = []
    ctx, p = await ctxp(b, errs, viewport={'width': 1280, 'height': 800})
    await p.goto(BASE + '/p/home'); await p.wait_for_function("()=>!document.querySelector('#boot')", timeout=10000); await p.wait_for_timeout(2500)
    ok('standalone page: no popup', not await p.evaluate("!!document.getElementById('wz-an')"))
    await p.click('footer [data-changelog]'); await p.wait_for_function("()=>document.querySelectorAll('#wz-an .wz-anl>li').length>0", timeout=5000)
    ok('standalone /p/home: 更新日志 opens history', True)
    await p.keyboard.press('Escape'); await p.wait_for_timeout(300)
    ok('standalone: focus back on chip', await p.evaluate("document.activeElement&&document.activeElement.hasAttribute('data-changelog')"))
    ok('no console errors (standalone)', not errs, errs[:3]); await ctx.close()
async def main():
    ann, entries = await newest()
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path='/usr/bin/chromium')
        if PART in ('shell', 'all'): await shell(b, ann, entries)
        if PART in ('more', 'all'): await more(b, ann, entries)
        await b.close()
    f = [n for n, c in R if not c]
    print(f'{len(R) - len(f)}/{len(R)} passed' + (' — FAILED: ' + '; '.join(f) if f else ''))
    sys.exit(1 if f else 0)
asyncio.run(main())
