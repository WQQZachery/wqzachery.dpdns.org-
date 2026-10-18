#!/usr/bin/env python3
"""Admin page key handling (site/admin.html), with every /api/* call answered by a Playwright route stub (no real key, no server data).
  python3 tools/admin_auth_test.py [base]     base default http://127.0.0.1:8766 (tools/lproxy.py serving site/)
Checks: wrong key → error and nothing stored; right key → app shown, key NOT in localStorage/sessionStorage/DOM/URL;
reload → key forgotten (login again); 保持登录 → survives reload in this tab only; legacy localStorage key wiped;
退出 → key cleared + login shown; key revoked mid-session (403) → logged out with message; idle 30 min → logged out."""
import sys, json, os
from playwright.sync_api import sync_playwright
B = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8766').rstrip('/')
GOOD = 'test-admin-key-' + os.urandom(4).hex()
STATE = {'good': GOOD}
ok = bad = 0
def t(n, c, i=''):
    global ok, bad
    if c: ok += 1; print('PASS', n)
    else: bad += 1; print('FAIL', n, i)

EMPTY = {'/api/admin/check': {'ok': True}, '/api/admin/stats': {'days': [], 'total': {}, 'paths': [], 'geo': [], 'ua': [], 'ref': [], 'recent': []},
         '/api/files': {'files': [], 'folders': [], 'used': 0, 'cap': '', 'admin': True}, '/api/admin/sessions': {'sessions': [], 'total': 0},
         '/api/admin/chat': {'msgs': [], 'online': 0}, '/api/admin/reports': {'open': [], 'total': 0}}
def handler(route):
    req = route.request; path = req.url.split('://', 1)[1].split('/', 1)[1].split('?')[0]; path = '/' + path
    k = req.headers.get('x-admin-key', '')
    if k != STATE['good']: return route.fulfill(status=403, content_type='application/json', body=json.dumps({'error': '密钥错误'}))
    return route.fulfill(status=200, content_type='application/json', body=json.dumps(EMPTY.get(path, {})))

with sync_playwright() as p:
    exe = os.environ.get('CHROME', '/usr/bin/chromium')   # CI: falls back to Playwright's own Chromium when the system one is absent
    br = p.chromium.launch(**({'executable_path': exe} if os.path.exists(exe) else {}), args=['--no-sandbox'])
    cx = br.new_context(viewport={'width': 390, 'height': 844})
    pg = cx.new_page(); pg.route('**/api/**', handler)
    store = lambda: pg.evaluate("[localStorage.getItem('adminKey'), sessionStorage.getItem('adminKey')]")
    visible = lambda sel: pg.evaluate(f"getComputedStyle(document.querySelector('{sel}')).display!=='none'")
    # legacy key planted by an old build must be wiped on load
    pg.goto(B + '/admin'); pg.evaluate("localStorage.setItem('adminKey','old-leaked-key')"); pg.reload(); pg.wait_for_timeout(400)
    t('legacy localStorage key removed on load', store()[0] is None, store())
    t('legacy key not auto-used (login shown)', visible('#login'))
    pg.fill('#k', 'wrong'); pg.click('#go'); pg.wait_for_timeout(400)
    t('wrong key → error shown, still on login', '密钥错误' in pg.inner_text('#err') and visible('#login'))
    t('wrong key not stored', store() == [None, None], store())
    pg.fill('#k', GOOD); pg.click('#go'); pg.wait_for_timeout(600)
    t('right key → app shown', visible('#app') and not visible('#login'))
    t('key not in localStorage / sessionStorage (default)', store() == [None, None], store())
    t('key not left in the input / DOM / URL', GOOD not in pg.content() and pg.input_value('#k') == '' and GOOD not in pg.url)
    t('logout button exists and is ≥44px tall', pg.evaluate("document.querySelector('#out').getBoundingClientRect().height") >= 44 - 0.5, pg.evaluate("document.querySelector('#out').getBoundingClientRect().height"))
    pg.reload(); pg.wait_for_timeout(500)
    t('reload forgets the key (memory only) → login again', visible('#login'))
    # remember in this tab
    pg.check('#rem'); pg.fill('#k', GOOD); pg.click('#go'); pg.wait_for_timeout(600)
    t('保持登录 → sessionStorage only', store()[0] is None and store()[1] == GOOD, store())
    pg.reload(); pg.wait_for_timeout(700)
    t('保持登录 survives reload in the same tab', visible('#app'))
    pg2 = cx.new_page(); pg2.route('**/api/**', handler); pg2.goto(B + '/admin'); pg2.wait_for_timeout(500)
    t('another tab does not get the key', pg2.evaluate("getComputedStyle(document.querySelector('#login')).display!=='none'") and pg2.evaluate("sessionStorage.getItem('adminKey')") is None)
    pg2.close()
    # logout
    pg.click('#out'); pg.wait_for_timeout(700)
    t('退出 → login shown, all storage cleared', visible('#login') and store() == [None, None], store())
    t('退出 → message shown', '已退出' in pg.inner_text('#err'))
    # key revoked server-side while logged in
    pg.check('#rem'); pg.fill('#k', GOOD); pg.click('#go'); pg.wait_for_timeout(600)
    STATE['good'] = 'rotated-' + GOOD
    pg.click('#re'); pg.wait_for_timeout(900)
    t('403 mid-session → logged out with message, key cleared', visible('#login') and '失效' in pg.inner_text('#err') and store() == [None, None], (pg.inner_text('#err'), store()))
    STATE['good'] = GOOD
    # idle expiry: fake clock, jump past 30 min without input so the 30 s timer fires
    pg3 = cx.new_page(); pg3.route('**/api/**', handler); pg3.clock.install(); pg3.goto(B + '/admin')
    pg3.fill('#k', GOOD); pg3.click('#go'); pg3.wait_for_timeout(600)
    pg3.clock.fast_forward('20:00'); pg3.wait_for_timeout(300)
    t('20 min idle → still logged in', pg3.evaluate("getComputedStyle(document.querySelector('#app')).display!=='none'"))
    pg3.clock.fast_forward('11:00'); pg3.wait_for_timeout(1200); pg = pg3
    t('idle 30 min → logged out with message', visible('#login') and '长时间未操作' in pg.inner_text('#err'), pg.inner_text('#err'))
    br.close()
print(f'{ok} passed, {bad} failed'); sys.exit(1 if bad else 0)
