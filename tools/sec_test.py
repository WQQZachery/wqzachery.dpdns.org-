#!/usr/bin/env python3
"""Security / limits regression tests for the Worker.
Usage:
  python3 tools/sec_test.py <base> neg      # no storage needed: limits at init, 403s, AI whitelist/concurrency, reports, headers
  python3 tools/sec_test.py <base> quota N  # expects the deploy to run with UP_DAY_FILES=N (init N+1 times → last one 429)
  python3 tools/sec_test.py <base> full     # needs working HF storage: legal upload/list/download/sha, renamed-exe sniff at finish,
                                            #   odd filename sanitized, then deletes everything it uploaded (needs admin key)
  python3 tools/sec_test.py <base> lockout  # 5 distinct wrong admin keys → locked (429) even with the right key. LOCKS THIS IP FOR 15 MIN.
Admin key: env ADMIN_KEY, else work/.test_admin_key for wqz-test, else worker/.admin_key. Never printed."""
import sys, os, json, hashlib, base64, time, threading, requests
B = sys.argv[1].rstrip('/'); MODE = sys.argv[2] if len(sys.argv) > 2 else 'neg'
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
def key():
    if os.environ.get('ADMIN_KEY'): return os.environ['ADMIN_KEY']
    f = os.path.join(ROOT, 'work', '.test_admin_key') if 'wqz-test' in B else os.path.join(ROOT, 'worker', '.admin_key')
    return open(f).read().strip() if os.path.exists(f) else ''
AK = key()
S = requests.Session(); S.headers['user-agent'] = 'Mozilla/5.0 sec-test'
ok = fail = 0
def check(name, cond, info=''):
    global ok, fail
    if cond: ok += 1; print('PASS', name)
    else: fail += 1; print('FAIL', name, str(info)[:300])
def init(name, size, data=None, head=None):
    oid = hashlib.sha256(data).hexdigest() if data is not None else hashlib.sha256(os.urandom(8)).hexdigest()
    b = {'name': name, 'size': size, 'oid': oid}
    if head is not None: b['head'] = base64.b64encode(head).decode()
    r = S.post(B + '/api/up/init', json=b); return r, oid
def j(r):
    try: return r.json()
    except Exception: return {}

if MODE == 'neg':
    r, _ = init('big.bin', 2 * 1024**3 + 1); check('init >2GB rejected 413', r.status_code == 413 and j(r).get('code') == 'big' and '文件太大' in j(r).get('error', ''), r.text)
    for n in ['setup.exe', 'a.APK', 'x.msi', 'run.sh', 'b.bat', 'c.ps1', 'd.dmg', 'e.deb', 'f.jar', 'g.exe. ', 'h.exe\u202e']:
        r, _ = init(n, 1000); check(f'init blocked ext {n!r} 415', r.status_code == 415 and j(r).get('code') == 'type', r.text)
    for label, head in [('MZ', b'MZ\x90\x00' + b'\0' * 60), ('ELF', b'\x7fELF\x02\x01\x01' + b'\0' * 57), ('Mach-O', bytes.fromhex('cffaedfe') + b'\0' * 60), ('shebang', b'#!/bin/sh\necho hi\n'),
                        ('APK zip', b'PK\x03\x04' + b'\0' * 26 + b'AndroidManifest.xml'), ('JAR zip', b'PK\x03\x04' + b'\0' * 26 + b'META-INF/MANIFEST.MF')]:
        r, _ = init('photo.jpg', 5000, head=head); check(f'init renamed {label} (head sniff) 415', r.status_code == 415 and j(r).get('code') == 'type', r.text)
    r = S.post(B + '/api/up/finish', json={'path': 'files/20261016-abcdef-x.txt', 'oid': 'a' * 64, 'size': 10}); check('finish without init 400', r.status_code == 400, r.text)
    r = S.put(B + '/api/up/part', data=b'x' * 10, headers={'x-target': 'https://hf-hub-lfs-us-east-1.s3.us-east-1.amazonaws.com/x?partNumber=1', 'x-up': 'files/20261016-abcdef-x.txt'}); check('relay without upload session 400', r.status_code == 400, r.text)
    for name, method, path, body in [('delete file', 'DELETE', '/api/files/dl/files/x.txt', None), ('move', 'POST', '/api/move', {'paths': ['files/x.txt'], 'to': 'a'}),
                                     ('rename', 'POST', '/api/rename', {'type': 'file', 'path': 'files/x.txt', 'name': 'y'}), ('rmdir', 'DELETE', '/api/folders?path=a', None),
                                     ('report resolve', 'POST', '/api/admin/reports', {'path': 'files/x.txt', 'action': 'delete'}), ('report list', 'GET', '/api/admin/reports', None),
                                     ('admin stats', 'GET', '/api/admin/stats', None), ('admin chat', 'GET', '/api/admin/chat', None), ('chat msg delete', 'DELETE', '/api/chat/msg?id=1', None),
                                     ('search proxy', 'GET', '/api/search?q=test', None)]:
        r = S.request(method, B + path, json=body); check(f'non-admin {name} 403', r.status_code == 403, f'{r.status_code} {r.text}')
    for p in ['/api/search/raw?u=https://example.com', '/api/admin/models']:
        r = S.get(B + p, headers={'x-admin-key': AK} if AK else {}); check(f'debug endpoint gone {p}', r.status_code == 404, r.status_code)
    r = S.get(B + '/admin'); check('X-Robots-Tag on /admin', 'noindex' in r.headers.get('x-robots-tag', ''), r.headers)
    r = S.get(B + '/api/admin/check'); check('X-Robots-Tag on /api/admin/*', 'noindex' in r.headers.get('x-robots-tag', '') and r.status_code == 403, r.headers)
    if AK:
        r = S.get(B + '/api/admin/check', headers={'x-admin-key': AK}); check('admin key accepted', r.status_code == 200, r.status_code)
        r = S.get(B + '/api/admin/reports', headers={'x-admin-key': AK}); check('admin reports list', r.status_code == 200 and 'open' in j(r), r.text)
    # reports
    r = S.post(B + '/api/report', json={'path': 'files/x.txt', 'reason': 'bogus'}); check('report bad reason 400', r.status_code == 400, r.text)
    r = S.post(B + '/api/report', json={'path': '../etc/passwd', 'reason': '其他'}); check('report bad path 400', r.status_code == 400, r.text)
    r = S.post(B + '/api/report', json={'path': 'files/sec-test-nonexistent.txt', 'reason': '其他', 'note': 'sec_test'}); check('report accepted', r.status_code == 200 and j(r).get('ok'), r.text)
    if AK:
        r = S.get(B + '/api/admin/reports', headers={'x-admin-key': AK}); check('report visible to admin', any(x['path'] == 'files/sec-test-nonexistent.txt' for x in j(r).get('open', [])), r.text)
        r = S.post(B + '/api/admin/reports', headers={'x-admin-key': AK}, json={'path': 'files/sec-test-nonexistent.txt', 'action': 'ignore'}); check('admin ignore report', r.status_code == 200, r.text)
    # AI whitelist + concurrency + streaming
    m = lambda **k: {'sid': 'sec-test', 'messages': [{'role': 'user', 'content': '只回复一个字：好'}], **k}
    r = S.post(B + '/api/chat', json=m(model='gpt-9-ultra')); check('AI unknown model 400', r.status_code == 400, r.text)
    r = S.post(B + '/api/chat', json=m(effort='insane')); check('AI bad effort 400', r.status_code == 400, r.text)
    r = S.post(B + '/api/chat', json={'messages': [{'role': 'user', 'content': 'x' * 5000}], 'sid': 'sec-test'}, stream=True)
    first = requests.Session(); first.headers['user-agent'] = 'Mozilla/5.0 sec-test'
    res = {}
    def stream():
        rr = first.post(B + '/api/chat', json={'sid': 'sec-test', 'messages': [{'role': 'user', 'content': '请写一篇大约 400 字的短文，介绍长城的历史。'}]}, stream=True); res['code'] = rr.status_code; txt = ''
        for line in rr.iter_lines(decode_unicode=True):
            if line and line.startswith('data:'): txt += line + '\n'
        res['body'] = txt
    r.close()
    time.sleep(1.5)
    th = threading.Thread(target=stream); th.start(); time.sleep(1.2)
    r2 = S.post(B + '/api/chat', json=m()); busy = r2.status_code == 429 and j(r2).get('code') == 'busy'
    th.join(120)
    check('AI streams (SSE t + done)', res.get('code') == 200 and '"t"' in res.get('body', '') and '"done"' in res.get('body', ''), res)
    check('AI 2nd concurrent request → 429 busy', busy, f'{r2.status_code} {r2.text}')
    time.sleep(1)
    r3 = S.post(B + '/api/chat', json=m(), stream=True); check('AI slot released after stream', r3.status_code == 200, r3.status_code); r3.close()
    # error hygiene
    r = S.get(B + '/api/files/raw/files/does-not-exist-%s.txt' % time.time()); check('missing file → clean 404 json', r.status_code in (404, 502) and 'error' in j(r) and 'http' not in r.text.lower(), r.text)
    r = S.get(B + '/api/nope'); check('unknown api 404', r.status_code == 404, r.status_code)

elif MODE == 'quota':
    N = int(sys.argv[3]); codes = []
    for i in range(N + 1):
        r, _ = init(f'q{i}.txt', 100); codes.append((r.status_code, j(r).get('code')))
    check(f'quota: request {N + 1} rejected 429 code=quota', codes[-1] == (429, 'quota'), codes)
    check('quota: earlier requests not quota-rejected', all(c[1] != 'quota' for c in codes[:-1]), codes)
    r, _ = init('big.bin', 6 * 1024**3); check('quota/size: 6GB rejected (size first)', r.status_code == 413, r.text)

elif MODE == 'full':
    assert AK, 'admin key needed for cleanup'
    A = {'x-admin-key': AK}; made = []
    def upload(name, data, head=True):
        oid = hashlib.sha256(data).hexdigest()
        b = {'name': name, 'size': len(data), 'oid': oid}
        if head: b['head'] = base64.b64encode(data[:4096]).decode()
        pl = S.post(B + '/api/up/init', json=b); plj = j(pl)
        if pl.status_code != 200: return pl, plj
        made.append(plj['path'])
        fin = {'path': plj['path'], 'oid': oid, 'size': len(data), 'verify': plj.get('verify')}
        if plj['mode'] == 'basic':
            requests.put(plj['href'], data=data, headers=plj.get('header') or {}, timeout=600).raise_for_status()
        elif plj['mode'] == 'multipart':
            ch = plj['chunk']; parts = []
            for i, u in enumerate(plj['parts']):
                rr = requests.put(u, data=data[i * ch:(i + 1) * ch], timeout=600); rr.raise_for_status(); parts.append({'partNumber': i + 1, 'etag': rr.headers['ETag']})
            fin['parts'] = parts; fin['complete'] = plj['complete']
        r = S.post(B + '/api/up/finish', json=fin); return r, j(r)
    txt = ('sec_test 合法文本 %s\n' % time.ctime()).encode()
    r, jj = upload('sec-test 合法.txt', txt); check('legal txt upload ok', r.status_code == 200 and jj.get('ok'), jj)
    big = os.urandom(20 * 1048576)
    r2, jj2 = upload('sec-test-20MB.bin', big); check('legal 20MB upload ok (mode multipart/basic)', r2.status_code == 200 and jj2.get('ok'), jj2)
    lst = S.get(B + '/api/files').json(); paths = {f['path'] for f in lst['files']}
    for jx, data in [(jj, txt), (jj2, big)]:
        if not jx.get('path'): continue
        check('listed ' + jx['path'], jx['path'] in paths)
        d = S.get(B + '/api/files/raw/' + requests.utils.quote(jx['path'], safe='') + '?dl=1', timeout=600)
        check('download sha256 match ' + jx['name'], d.status_code == 200 and hashlib.sha256(d.content).digest() == hashlib.sha256(data).digest(), d.status_code)
        check('download is attachment + nosniff', 'attachment' in d.headers.get('content-disposition', '') and d.headers.get('x-content-type-options') == 'nosniff', d.headers)
    exe = b'MZ\x90\x00\x03' + os.urandom(3000)
    r3, jj3 = upload('holiday-photo.jpg', exe, head=False); check('renamed exe (no head sent) rejected at finish 415', r3.status_code == 415 and jj3.get('code') == 'type', jj3)
    r4, jj4 = upload('  ..\\..//evil\u202egnp<script>:*?.txt.  ' + 'a' * 300, b'hello odd name\n')
    nm = jj4.get('name', '')
    check('odd/overlong filename sanitized', r4.status_code == 200 and '/' not in nm and '\\' not in nm and '<' not in nm and '\u202e' not in nm and len(nm) <= 150 and not nm.startswith('.'), jj4)
    print('  sanitized name:', repr(nm), 'path:', jj4.get('path'))
    r = S.post(B + '/api/report', json={'path': jj.get('path', 'files/x'), 'reason': '其他', 'note': 'sec_test full'}); check('report a real file', r.status_code == 200, r.text)
    # cleanup (deleting also clears ups/report rows)
    lst = S.get(B + '/api/files').json(); have = {f['path'] for f in lst['files']}
    for p in made:
        if p in have:
            r = S.delete(B + '/api/files/dl/' + requests.utils.quote(p, safe=''), headers=A); check('cleanup delete ' + p, r.status_code == 200, r.text)
    rep = S.get(B + '/api/admin/reports', headers=A).json()
    check('report rows cleared with the file', not any(x['path'] in made for x in rep.get('open', [])), rep)

elif MODE == 'lockout':
    for i in range(5):
        r = S.get(B + '/api/admin/check', headers={'x-admin-key': 'wrong-%d-%s' % (i, time.time())}); print('  wrong key', i + 1, r.status_code)
    r = S.get(B + '/api/admin/check', headers={'x-admin-key': AK or 'x'}); check('locked after 5 distinct wrong keys (429) even with the right key', r.status_code == 429 and j(r).get('code') == 'locked', f'{r.status_code} {r.text}')
    r = S.get(B + '/api/files'); check('public API still works for a locked IP (no key sent)', r.status_code in (200, 502), r.status_code)
print(f'\n{ok} passed, {fail} failed'); sys.exit(1 if fail else 0)
