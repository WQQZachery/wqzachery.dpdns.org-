#!/usr/bin/env python3
"""Browser test for the locked owner folder (files/wq) against the LOCAL disposable environment (tools/local_env.sh start).
  ADMIN_KEY=$(cat work/.local_admin_key) python3 tools/lock_e2e.py [http://127.0.0.1:8787] [http://127.0.0.1:8790]
Admin creates wq + uploads a file into it (via the page, unlocked); a fresh visitor sees a 🔒 folder, can't list/read/upload;
wrong password shows an error; right password unlocks (HttpOnly cookie), file shows with tag 我; 重新上锁 locks again;
admin page shows the owner's IP as 我. No page errors."""
import os, sys, re, json, tempfile, urllib.request, urllib.parse, urllib.error
from playwright.sync_api import sync_playwright
B = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8787').rstrip('/')
F = (sys.argv[2] if len(sys.argv) > 2 else 'http://127.0.0.1:8790').rstrip('/')
AK = os.environ.get('ADMIN_KEY') or open(os.path.join(os.path.dirname(__file__), '..', 'work', '.local_admin_key')).read().strip()
ok = bad = 0
def t(n, c, i=''):
    global ok, bad
    if c: ok += 1; print('PASS', n)
    else: bad += 1; print('FAIL', n, str(i)[:300])
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
def req(path, method='GET', body=None, h={}):
    r = urllib.request.Request(B + path, data=json.dumps(body).encode() if body is not None else None, method=method, headers={'content-type': 'application/json', **h})
    try: res = op.open(r, timeout=30); return res.status, res.read()
    except urllib.error.HTTPError as e: return e.code, e.read()
S3 = re.compile(r'^https://hf-hub-lfs-[a-z0-9-]+\.s3[a-z0-9.-]*\.amazonaws\.com')
def s3_route(route):
    r = route.request; u = S3.sub(F + '/s3', r.url)
    if r.method == 'OPTIONS': return route.fulfill(status=200, headers={'access-control-allow-origin': '*', 'access-control-allow-methods': 'PUT', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'ETag'})
    try:
        rq = urllib.request.Request(u, data=r.post_data_buffer, method=r.method, headers={k: v for k, v in r.headers.items() if k.lower() in ('content-type',)})
        res = op.open(rq, timeout=60); body = res.read(); code = res.status; hd = dict(res.headers)
    except urllib.error.HTTPError as e: body = e.read(); code = e.code; hd = dict(e.headers)
    route.fulfill(status=code, body=body, headers={'etag': hd.get('etag') or hd.get('ETag') or '', 'access-control-allow-origin': '*', 'access-control-expose-headers': 'ETag'})
tmp = tempfile.mkdtemp(); mine = os.path.join(tmp, '我的私人照片.txt'); open(mine, 'wb').write('私人内容\n'.encode() * 20)
A = {'x-admin-key': AK}
st, _ = req('/api/folders', 'POST', {'path': 'wq'}, A)
t('admin can create wq', st in (200, 409), st)
with sync_playwright() as p:
    br = p.chromium.launch(executable_path=os.environ.get('CHROME', '/usr/bin/chromium'), args=['--no-sandbox'])
    errs = []
    def newpg(ctx):
        pg = ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e))); pg.route(S3, s3_route); return pg
    # --- owner: unlock in the page, upload into wq
    oc = br.new_context(viewport={'width': 390, 'height': 844}); pg = newpg(oc)
    pg.add_init_script("sessionStorage.setItem('cwd','wq')")
    pg.goto(B + '/p/drive'); pg.wait_for_selector('#ulf', timeout=15000)
    t('locked folder shows password form', pg.is_visible('#ulk') and '已上锁' in pg.inner_text('#list'))
    t('relock button hidden while locked', not pg.is_visible('#relockb'))
    pg.fill('#ulk', 'wrong-password'); pg.click('#uls'); pg.wait_for_timeout(1500)
    t('wrong password → error shown, still locked', '密码不对' in pg.inner_text('#ulm') and pg.is_visible('#ulf'), pg.inner_text('#list'))
    pg.fill('#ulk', AK); pg.click('#uls'); pg.wait_for_function("!document.querySelector('#ulf')", timeout=10000)
    ck = [c for c in oc.cookies() if c['name'] == 'wqu']
    t('unlock cookie is HttpOnly + Strict', ck and ck[0]['httpOnly'] and ck[0]['sameSite'] == 'Strict', ck)
    t('relock button visible in wq', pg.is_visible('#relockb'))
    pg.set_input_files('input[type=file]', [mine]); pg.wait_for_function("document.body.innerText.includes('我的私人照片.txt')", timeout=30000); pg.wait_for_timeout(2500)
    st, body = req('/api/files', h=A); fs_ = json.loads(body)['files']; mf = [f for f in fs_ if f['name'] == '我的私人照片.txt']
    t('upload landed in files/wq/', mf and mf[0]['path'].startswith('files/wq/'), [f['path'] for f in fs_])
    pg.reload(); pg.wait_for_timeout(2500)
    t('owner sees file with tag 我', '我的私人照片.txt' in pg.inner_text('#list') and pg.locator('#list .tag.me').count() >= 1)
    # --- stranger: fresh context
    sc = br.new_context(viewport={'width': 1280, 'height': 800}); sp = newpg(sc)
    sp.goto(B + '/p/drive'); sp.wait_for_timeout(2500)
    lst = sp.inner_text('#list')
    t('visitor root: wq shown as locked folder, private file not listed', 'wq' in lst and '已上锁' in lst and '我的私人照片' not in lst, lst[:300])
    sp.click('#list li.fd[data-d="wq"]'); sp.wait_for_selector('#ulf', timeout=5000)
    t('visitor opening wq gets password form', sp.is_visible('#ulk'))
    path = mf[0]['path'] if mf else 'files/wq/x'
    r = sp.request.get(B + '/api/files/raw/' + urllib.parse.quote(path, safe=''))
    t('visitor direct raw link → 403', r.status == 403, r.status)
    sp.click('[data-back]'); sp.wait_for_timeout(500)
    t('返回上一级 goes back to root', sp.locator('#list li.fd[data-d="wq"]').count() == 1)
    # --- owner relocks
    pg.click('#relockb'); pg.wait_for_selector('#ulf', timeout=5000)
    t('重新上锁 → password form again', pg.is_visible('#ulk'))
    r = pg.request.get(B + '/api/files/raw/' + urllib.parse.quote(path, safe=''))
    t('after relock raw → 403', r.status == 403, r.status)
    # --- admin page shows 我
    st, body = req('/api/admin/stats', h=A); s = json.loads(body)
    t('admin stats: owner upload shown as 我', any(u.get('ip') == '我' for u in s.get('uploads', [])), s.get('uploads'))
    t('no page errors', not errs, errs)
    br.close()
print(f'{ok} passed, {bad} failed'); sys.exit(1 if bad else 0)
