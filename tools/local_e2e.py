#!/usr/bin/env python3
"""End-to-end browser test against the LOCAL disposable environment (tools/local_env.sh start): the real Worker in workerd,
real SQLite DO, fake HF/S3/CDN on :8790, fake Workers AI. Destructive admin actions are fine here.
  ADMIN_KEY=$(cat work/.local_admin_key) python3 tools/local_e2e.py [http://127.0.0.1:8787] [http://127.0.0.1:8790]
Covers: drive page uploads (small = basic, 9 MiB = multipart, parallel) through the real UI with presigned S3 PUTs routed to the
fake, listing, preview/download bytes, a renamed .exe rejected, report; admin page with the real key: lists, rename, new folder,
move, delete, report list; AI page: send + streamed answer + Astra notice text; chat page: two visitors exchange a message;
no HF token seen on S3/CDN; no page errors."""
import os, sys, json, hashlib, re, tempfile, urllib.request, urllib.parse, urllib.error
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
def get(u, h={}): return json.loads(op.open(urllib.request.Request(u, headers=h), timeout=30).read() or b'null')
FORCE_RELAY = {'on': False}
S3 = re.compile(r'^https://hf-hub-lfs-[a-z0-9-]+\.s3[a-z0-9.-]*\.amazonaws\.com')
def s3_route(route):   # the browser PUTs to presigned S3 URLs: hand them to the fake S3
    r = route.request; u = S3.sub(F + '/s3', r.url)
    if FORCE_RELAY['on']: return route.abort('connectionrefused')   # S3 unreachable (as from some networks) → page falls back to /api/up/part
    if r.method == 'OPTIONS': return route.fulfill(status=200, headers={'access-control-allow-origin': '*', 'access-control-allow-methods': 'PUT', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'ETag'})
    try:
        req = urllib.request.Request(u, data=r.post_data_buffer, method=r.method, headers={k: v for k, v in r.headers.items() if k.lower() in ('content-type', 'authorization')})
        res = op.open(req, timeout=60); body = res.read(); code = res.status; hd = dict(res.headers)
    except urllib.error.HTTPError as e: body = e.read(); code = e.code; hd = dict(e.headers)
    route.fulfill(status=code, body=body, headers={'etag': hd.get('etag') or hd.get('ETag') or '', 'access-control-allow-origin': '*', 'access-control-expose-headers': 'ETag'})

tmp = tempfile.mkdtemp()
small = os.path.join(tmp, 'e2e 小文件.txt'); open(small, 'wb').write('本地端到端测试\n'.encode() * 50)
big = os.path.join(tmp, 'e2e-9MB.bin'); open(big, 'wb').write(os.urandom(9 * 1048576 + 123))
exe = os.path.join(tmp, 'holiday.jpg'); open(exe, 'wb').write(b'MZ\x90\x00' + os.urandom(5000))
sha = lambda p: hashlib.sha256(open(p, 'rb').read()).hexdigest()

with sync_playwright() as p:
    exe_path = os.environ.get('CHROME', '/usr/bin/chromium')
    br = p.chromium.launch(**({'executable_path': exe_path} if os.path.exists(exe_path) else {}), args=['--no-sandbox'])
    cx = br.new_context(viewport={'width': 390, 'height': 844}); cx.route(S3, s3_route)
    errs = []
    pg = cx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
    # ---------- drive: upload through the real UI ----------
    pg.goto(B + '/p/drive'); pg.wait_for_timeout(1200)
    pg.set_input_files('input[type=file]', [small, big])
    pg.wait_for_function("()=>document.querySelectorAll('.up.ok').length>=2 || [...document.querySelectorAll('.up')].some(x=>/失败|错误/.test(x.textContent))", timeout=90000)
    rows = pg.eval_on_selector_all('.up', 'els=>els.map(e=>e.className+" | "+e.textContent.slice(0,80))')
    t('drive UI: small (basic) + 9 MiB (multipart) both upload', sum('ok' in r.split('|')[0] for r in rows) >= 2, rows)
    lst = get(B + '/api/files'); names = {f['name']: f for f in lst['files']}
    t('both listed by /api/files', 'e2e 小文件.txt' in names and 'e2e-9MB.bin' in names, list(names))
    for n, src in [('e2e 小文件.txt', small), ('e2e-9MB.bin', big)]:
        f = names.get(n)
        if not f: continue
        d = op.open(B + '/api/files/raw/' + urllib.parse.quote(f['path'], safe='') + '?dl=1', timeout=60).read()
        t('download bytes match ' + n, hashlib.sha256(d).hexdigest() == sha(src))
    # relay fallback with a Chinese file name (S3 blocked → /api/up/part)
    FORCE_RELAY['on'] = True
    rel = os.path.join(tmp, '中转 测试.txt'); open(rel, 'wb').write('经由本站中转\n'.encode() * 100)
    pg2 = cx.new_page(); pg2.on('pageerror', lambda e: errs.append(str(e))); pg2.goto(B + '/p/drive'); pg2.wait_for_timeout(1200)
    pg2.set_input_files('input[type=file]', [rel])
    pg2.wait_for_function("()=>document.querySelector('.up.ok')||[...document.querySelectorAll('.up')].some(x=>/失败/.test(x.textContent))", timeout=60000)
    rows2 = pg2.eval_on_selector_all('.up', 'els=>els.map(e=>e.className+" | "+e.textContent.slice(0,90))')
    t('relay fallback works for a Chinese file name', any('ok' in r.split('|')[0] for r in rows2), rows2)
    f2 = [f for f in get(B + '/api/files')['files'] if f['name'] == '中转 测试.txt']
    t('relayed file stored with correct bytes', f2 and hashlib.sha256(op.open(B + '/api/files/raw/' + urllib.parse.quote(f2[0]['path'], safe='') + '?dl=1').read()).hexdigest() == sha(rel))
    FORCE_RELAY['on'] = False; pg2.close()
    pg.set_input_files('input[type=file]', [exe]); pg.wait_for_timeout(4000)
    t('renamed exe rejected in the UI', any('类型不支持' in r for r in pg.eval_on_selector_all('.up', 'els=>els.map(e=>e.textContent)')))
    t('renamed exe not stored', 'holiday.jpg' not in {f['name'] for f in get(B + '/api/files')['files']})
    # ---------- admin page with the real key ----------
    ad = cx.new_page(); ad.on('pageerror', lambda e: errs.append('admin: ' + str(e)))
    ad.goto(B + '/admin'); ad.fill('#k', AK); ad.click('#go'); ad.wait_for_timeout(2000)
    t('admin login with real key', ad.evaluate("getComputedStyle(document.querySelector('#app')).display!=='none'"))
    t('admin file list shows uploads', 'e2e-9MB.bin' in ad.content())
    A = {'x-admin-key': AK, 'content-type': 'application/json'}
    def api(m, path, body=None):
        req = urllib.request.Request(B + path, data=json.dumps(body).encode() if body is not None else None, method=m, headers=A)
        try: r = op.open(req, timeout=60); return r.status, json.loads(r.read() or b'{}')
        except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b'{}')
    c, j = api('POST', '/api/folders', {'path': 'e2e-dir'}); t('mkdir', c == 200, j)
    c, j = api('POST', '/api/move', {'paths': [names['e2e-9MB.bin']['path']], 'to': 'e2e-dir'}); t('move into folder', c == 200 and j.get('moved') == 1, j)
    moved = [f for f in get(B + '/api/files')['files'] if f['name'] == 'e2e-9MB.bin']
    t('moved file now in folder', moved and moved[0]['dir'] == 'e2e-dir', moved)
    c, j = api('POST', '/api/rename', {'type': 'file', 'path': moved[0]['path'], 'name': 'e2e-renamed.bin'}); t('rename file', c == 200, j)
    c, j = api('POST', '/api/rename', {'type': 'folder', 'path': 'e2e-dir', 'name': 'e2e-dir2'}); t('rename folder', c == 200, j)
    c, j = api('POST', '/api/report', {'path': names['e2e 小文件.txt']['path'], 'reason': '其他', 'note': 'e2e'}); t('report file', c == 200, j)
    ad.click('#re'); ad.wait_for_timeout(1500)
    rpt = ad.inner_text('#rpt') if ad.query_selector('#rpt') else ''
    t('admin sees report', '说明：e2e' in rpt, (rpt[:200], ad.inner_text('#err') if ad.query_selector('#err') else ''))
    c, j = api('POST', '/api/admin/reports', {'path': names['e2e 小文件.txt']['path'], 'action': 'delete'}); t('delete reported file', c == 200, j)
    c, j = api('DELETE', '/api/folders?path=e2e-dir2'); t('delete folder with file', c == 200, j)
    for f in get(B + '/api/files')['files']:
        if f['name'] == '中转 测试.txt': api('DELETE', '/api/files/dl/' + urllib.parse.quote(f['path'], safe=''))
    left = get(B + '/api/files'); t('drive empty after cleanup', not left['files'] and not left['folders'], left)
    # ---------- AI page ----------
    ai = cx.new_page(); ai.on('pageerror', lambda e: errs.append('ai: ' + str(e)))
    ai.goto(B + '/p/ai'); ai.wait_for_timeout(1000)
    t('AI page shows the Astra disclosure', '非 OpenAI 产品' in ai.content())
    ai.fill('#in', '你好'); ai.click('#send')
    ai.wait_for_function("()=>[...document.querySelectorAll('.msg.a')].some(m=>m.textContent.includes('好')&&!m.classList.contains('wait'))", timeout=20000)
    t('AI answer streamed into the page', True)
    # ---------- chat page: two visitors ----------
    c1 = cx.new_page(); c2 = br.new_context().new_page()
    for x in (c1, c2): x.on('pageerror', lambda e: errs.append('chat: ' + str(e))); x.goto(B + '/p/chat')
    c1.wait_for_timeout(2500)
    box = c1.query_selector('textarea, input[type=text]'); box.fill('e2e 你好'); box.press('Enter')
    try: c2.wait_for_function("()=>document.body.innerText.includes('e2e 你好')", timeout=10000); seen = True
    except Exception: seen = False
    t('chat: message reaches the other visitor', seen)
    t('no page JS errors', not errs, errs)
    br.close()
v = get(F + '/__violations'); t('HF token never sent to S3/CDN; HF API always authenticated', v == [], v)
print(f'{ok} passed, {bad} failed'); sys.exit(1 if bad else 0)
