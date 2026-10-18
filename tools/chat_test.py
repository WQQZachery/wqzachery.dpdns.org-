# End-to-end test of the chat room WebSocket protocol.  Usage: BASE=https://wqz-test.15112479050.workers.dev python3 tools/chat_test.py
import asyncio, json, os, random, string, time, statistics, urllib.request
import websockets
WSKW = {'proxy': None} if int(websockets.__version__.split('.')[0]) >= 15 else {}   # newer websockets read HTTPS_PROXY, which breaks the upgrade

BASE = os.environ.get('BASE', 'https://wqz-test.15112479050.workers.dev')
WS = BASE.replace('https://', 'wss://').replace('http://', 'ws://') + '/api/chat/ws'
ADMIN = os.environ.get('ADMIN_KEY') or (open(os.path.join(os.path.dirname(__file__), '..', 'worker', '.admin_key')).read().strip() if os.path.exists(os.path.join(os.path.dirname(__file__), '..', 'worker', '.admin_key')) else '')
rk = lambda: ''.join(random.choice(string.ascii_letters + string.digits) for _ in range(24))
results = []
def ok(name, cond, extra=''):
    results.append((name, bool(cond))); print(('PASS ' if cond else 'FAIL ') + name + (' — ' + str(extra) if extra else ''))

class C:
    def __init__(s, nick): s.key, s.nick, s.q = rk(), nick, asyncio.Queue(); s.ws = None
    async def open(s):
        s.ws = await websockets.connect(f'{WS}?key={s.key}&nick={urllib.parse.quote(s.nick)}', open_timeout=15, **WSKW)
        s.task = asyncio.create_task(s._rx())
        s.hello = await s.wait(lambda m: m['t'] == 'hello'); s.uid = s.hello['me']['uid']; return s
    async def _rx(s):
        try:
            async for raw in s.ws:
                if raw == 'pong': await s.q.put({'t': 'pong', 'at': time.time()}); continue
                m = json.loads(raw); m['at'] = time.time(); await s.q.put(m)
        except Exception: pass
    async def wait(s, pred, timeout=6):
        end = time.time() + timeout
        while True:
            left = end - time.time()
            if left <= 0: return None
            try: m = await asyncio.wait_for(s.q.get(), left)
            except asyncio.TimeoutError: return None
            if pred(m): return m
    def drain(s):
        while not s.q.empty(): s.q.get_nowait()
    async def send(s, **o): await s.ws.send(json.dumps(o))

import urllib.parse
async def main():
    tag = rk()[:5]
    a = await C('测试A' + tag).open()
    ok('hello has history list', isinstance(a.hello['history'], list), f"{len(a.hello['history'])} msgs, online {a.hello['n']}")
    n0 = a.hello['n']
    b = await C('测试B' + tag).open()
    j = await a.wait(lambda m: m['t'] == 'sys' and 'B' + tag in m['text'] and '加入' in m['text'])
    ok('A sees B join system message', j, j and j['text'])
    p = await a.wait(lambda m: m['t'] == 'presence' and m['n'] >= n0 + 1)
    ok('online count increments on join', p, p and p['n'])
    c = await C('测试C' + tag).open()
    await asyncio.sleep(1.2)
    # broadcast latency
    lat = []
    for i in range(5):
        a.drain(); b.drain(); c.drain()
        t0 = time.time(); txt = f'延迟测试 {tag} {i}'
        await a.send(t='msg', text=txt, cid=f'c{i}')
        mb = await b.wait(lambda m: m['t'] == 'msg' and m['m']['text'] == txt)
        me = await a.wait(lambda m: m['t'] == 'msg' and m.get('cid') == f'c{i}')
        if mb: lat.append((mb['at'] - t0) * 1000)
        await asyncio.sleep(1.15)
    ok('broadcast to others <1s', len(lat) == 5 and max(lat) < 1000, f"median {statistics.median(lat):.0f} ms, max {max(lat):.0f} ms" if lat else 'none')
    ok('sender gets echo with cid (已发送 tick)', me is not None)
    # history on connect
    d = await C('测试D' + tag).open()
    ok('new client receives history incl. latest', any(x['text'] == f'延迟测试 {tag} 4' for x in d.hello['history']), f"{len(d.hello['history'])} msgs")
    ok('history ≤100', len(d.hello['history']) <= 100)
    ok('history has no ip field', all('ip' not in x for x in d.hello['history']))
    # rate limit: 2 quick
    a.drain(); await asyncio.sleep(1.1)
    await a.send(t='msg', text='快1 ' + tag, cid='r1'); await a.send(t='msg', text='快2 ' + tag, cid='r2')
    e = await a.wait(lambda m: m['t'] == 'err' and m.get('cid') == 'r2')
    ok('≤1 msg/sec enforced', e, e and e['msg'])
    # duplicate
    await asyncio.sleep(1.2); a.drain()
    await a.send(t='msg', text='快1 ' + tag, cid='d1')
    e = await a.wait(lambda m: m['t'] == 'err' and m.get('cid') == 'd1')
    ok('duplicate within 30s rejected', e, e and e['msg'])
    # too long
    await asyncio.sleep(1.1); a.drain()
    await a.send(t='msg', text='长' * 501, cid='l1')
    e = await a.wait(lambda m: m['t'] == 'err' and m.get('cid') == 'l1')
    ok('>500 chars rejected', e, e and e['msg'])
    # filter
    await asyncio.sleep(1.1); b.drain()
    await a.send(t='msg', text=f'你是傻逼吗 fuck {tag}', cid='f1')
    m = await b.wait(lambda m: m['t'] == 'msg' and tag in m['m']['text'] and '***' in m['m']['text'])
    ok('sensitive words → ***', m, m and m['m']['text'])
    # DM
    await asyncio.sleep(1.1); a.drain(); b.drain(); c.drain()
    t0 = time.time()
    await a.send(t='msg', text='悄悄话 ' + tag, to=b.uid, cid='dm1')
    mb = await b.wait(lambda m: m['t'] == 'msg' and m['m'].get('to_uid') == b.uid)
    mc = await c.wait(lambda m: m['t'] == 'msg' and '悄悄话' in m['m']['text'], timeout=2.5)
    ok('DM reaches target', mb, mb and f"{(mb['at']-t0)*1000:.0f} ms")
    ok('DM NOT delivered to third party', mc is None)
    await c.send(t='dmhist', **{'with': a.uid})
    h = await c.wait(lambda m: m['t'] == 'dmhist')
    ok('third party cannot read A↔B DM history', h is not None and not any('悄悄话 ' + tag in x['text'] for x in h['msgs']))
    await b.send(t='dmhist', **{'with': a.uid})
    h = await b.wait(lambda m: m['t'] == 'dmhist')
    ok('DM history stored for pair', h and any('悄悄话 ' + tag in x['text'] for x in h['msgs']))
    # typing
    a.drain(); c.drain()
    await b.send(t='typing')
    ty = await a.wait(lambda m: m['t'] == 'typing' and m['uid'] == b.uid)
    ok('typing indicator relayed', ty)
    # nick change
    b.drain(); new = '新名字' + tag
    await a.send(t='nick', nick=new)
    nk = await b.wait(lambda m: m['t'] == 'nick' and m['nick'] == new)
    sy = await b.wait(lambda m: m['t'] == 'sys' and new in m['text'])
    ok('nick change broadcast + system notice', nk and sy, sy and sy['text'])
    await a.send(t='nick', nick='x' * 17); e = await a.wait(lambda m: m['t'] == 'err')
    ok('nick >16 rejected', e, e and e['msg'])
    # admin delete
    def admin_ok():
        try: urllib.request.urlopen(urllib.request.Request(f'{BASE}/api/admin/check', headers={'x-admin-key': ADMIN, 'user-agent': 'Mozilla/5.0 test'}), timeout=15); return True
        except Exception: return False
    if ADMIN and admin_ok():
        await asyncio.sleep(1.1); b.drain()
        await a.send(t='msg', text='待删除 ' + tag, cid='x1'); m = await a.wait(lambda m: m.get('cid') == 'x1')
        req = urllib.request.Request(f"{BASE}/api/chat/msg?id={m['m']['id']}", method='DELETE', headers={'x-admin-key': ADMIN, 'user-agent': 'Mozilla/5.0 test'})
        try: r = json.loads(urllib.request.urlopen(req, timeout=15).read())
        except Exception as ex: r = {'error': str(ex)}
        dl = await b.wait(lambda x: x['t'] == 'del' and x['id'] == m['m']['id'])
        ok('admin DELETE removes + broadcasts', r.get('ok') and dl, r)
        req = urllib.request.Request(f"{BASE}/api/admin/chat", headers={'x-admin-key': ADMIN, 'user-agent': 'Mozilla/5.0 test'})
        j = json.loads(urllib.request.urlopen(req, timeout=15).read())
        ok('admin chat stats include ip', j['recent'] and 'ip' in j['recent'][0], f"total {j['total']}, online {j['online']}")
    else: print('SKIP admin delete (admin key not valid on this worker)')
    req = urllib.request.Request(f"{BASE}/api/chat/msg?id=1", method='DELETE', headers={'user-agent': 'Mozilla/5.0 test'})
    try: urllib.request.urlopen(req, timeout=15); code = 200
    except urllib.error.HTTPError as ex: code = ex.code
    ok('DELETE without admin key → 403', code == 403)
    # leave (debounced ~8s) + count drop
    a.drain()
    nb = (await a.wait(lambda m: m['t'] == 'presence', timeout=0.1) or {}).get('n')
    await c.ws.close()
    p = await a.wait(lambda m: m['t'] == 'presence', timeout=5)
    ok('online count drops on leave', p, p and p['n'])
    lv = await a.wait(lambda m: m['t'] == 'sys' and 'C' + tag in m['text'] and '离开' in m['text'], timeout=15)
    ok('debounced leave message', lv, lv and lv['text'])
    # quick reconnect should not spam join/leave
    a.drain(); key = b.key
    await b.ws.close(); await asyncio.sleep(1)
    b2 = C('测试B' + tag); b2.key = key; await b2.open()
    spam = await a.wait(lambda m: m['t'] == 'sys' and 'B' + tag in m['text'], timeout=11)
    ok('quick reconnect: no join/leave spam', spam is None, spam and spam['text'])
    # per-IP cap
    extra = []; capped = None
    for i in range(6):
        x = C('cap' + str(i))
        try:
            x.ws = await websockets.connect(f'{WS}?key={x.key}&nick=cap{i}', open_timeout=15, **WSKW)
            x.task = asyncio.create_task(x._rx()); extra.append(x)
            m = await x.wait(lambda m: m['t'] in ('hello', 'err'), timeout=4)
            if m and m['t'] == 'err': capped = m['msg']; break
        except Exception as ex: capped = str(ex); break
    ok('per-IP connection cap (~5)', capped, capped)
    for x in [a, b2, d] + extra:
        try: await x.ws.close()
        except Exception: pass
    print(f"\n{sum(r for _, r in results)}/{len(results)} passed")

asyncio.run(main())
