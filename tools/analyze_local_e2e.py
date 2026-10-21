#!/usr/bin/env python3
"""End-to-end check of 「聊天分析」 against the local disposable environment (real Worker in workerd, real SQLite Durable Object, fake AI):
  CHAT_ANA_IP_DAILY=5 CHAT_ANA_DAILY=7 bash tools/local_env.sh start && python3 tools/analyze_local_e2e.py; bash tools/local_env.sh stop
Messages are created through the real chat WebSocket; the analysis endpoint reads them from the DO by id. Never point this at production."""
import asyncio, json, os, random, string, sys, time, urllib.request, urllib.parse
import websockets
BASE = os.environ.get('BASE', 'http://127.0.0.1:8787')
assert '127.0.0.1' in BASE or 'localhost' in BASE, 'local only'
WS = BASE.replace('http://', 'ws://') + '/api/chat/ws'
WSKW = {'proxy': None} if int(websockets.__version__.split('.')[0]) >= 15 else {}
rk = lambda: ''.join(random.choice(string.ascii_letters + string.digits) for _ in range(24))
res = []
def ok(n, c, extra=''):
    res.append(bool(c)); print(('PASS ' if c else 'FAIL ') + n + (' — ' + str(extra)[:300] if extra and not c else ''), flush=True)
def ana(body, ip=None):
    h = {'content-type': 'application/json'}
    if ip: h['cf-connecting-ip'] = ip
    r = urllib.request.Request(BASE + '/api/chat/analyze', data=json.dumps(body).encode(), headers=h, method='POST')
    try: x = urllib.request.urlopen(r, timeout=30); return x.status, json.loads(x.read())
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b'{}')
class C:
    def __init__(s, nick): s.key, s.nick = rk(), nick
    async def open(s):
        s.ws = await websockets.connect(f'{WS}?key={s.key}&nick={urllib.parse.quote(s.nick)}', **WSKW)
        while True:
            m = json.loads(await s.ws.recv())
            if m['t'] == 'hello': s.uid = m['me']['uid']; return s
    async def say(s, text, to=None):
        cid = rk()[:8]; o = {'t': 'msg', 'text': text, 'cid': cid}
        if to: o['to'] = to
        await s.ws.send(json.dumps(o))
        while True:
            m = json.loads(await asyncio.wait_for(s.ws.recv(), 5))
            if m.get('t') == 'msg' and m.get('cid') == cid: await asyncio.sleep(1.1); return m['m']['id']
            if m.get('t') == 'err' and m.get('cid') == cid: raise RuntimeError(m['msg'])
async def main():
    a, b, c = await C('测试甲').open(), await C('测试乙').open(), await C('测试丙').open()
    first = await a.say('第一条普通消息')
    pii = await a.say('我的手机 13812345678，邮箱 me@example.com')
    q = await b.say('请问网盘怎么上传文件？')
    dm = await b.say('私信：这是只有甲乙能看的', to=a.uid)
    # each marker message is followed by 3 fillers, so it never shows up in another message's context (≤ 3 earlier messages)
    fill = lambda n: [a, b, c][n % 3].say(f'填充消息 {n} ' + rk()[:4])
    ids = {}
    for i, mk in enumerate(['__CLEF_BAD__ 测试格式异常', '__CLEF_FAIL__ 测试调用失败', '__GEN_FAIL__ 测试建议失败', '__CLEF_SLOW__ 测试超时']):
        for k in range(3): await fill(i * 3 + k)
        ids[i] = await c.say(mk)
    bad, fail, genf, slow = ids[0], ids[1], ids[2], ids[3]
    s, j = ana({'id': q, 'key': a.key})
    ok('real DO: normal analysis → 200 with intent / tone / 3 replies', s == 200 and j.get('ok') and j['intent']['label'] and len(j['replies']) == 3 and j['suggest'] == 'ok', (s, j))
    ok('real DO: reply text came through the site chat wrapper (fake AI)', s == 200 and j['replies'][0]['text'] == 'fake reply one', j)
    ok('real DO: response names no model', 'clef' not in json.dumps(j).lower() and 'gpt-oss' not in json.dumps(j).lower())
    s, j = ana({'id': dm, 'key': c.key}); ok('real DO: DM by outsider → 404', s == 404 and j.get('code') == 'not_found', (s, j))
    s, j = ana({'id': dm}); ok('real DO: DM without key → 404', s == 404, (s, j))
    s, j = ana({'id': dm, 'key': a.key}); ok('real DO: DM by participant → 200', s == 200 and j.get('ok'), (s, j))
    s, j = ana({'id': 987654}); ok('real DO: unknown id → 404', s == 404, (s, j))
    s, j = ana({}); ok('real DO: no id → 400 empty', s == 400 and j.get('code') == 'empty', (s, j))
    s, j = ana({'id': bad}); ok('real DO: malformed Clef output → 502 clef_bad_format', s == 502 and j.get('code') == 'clef_bad_format', (s, j))
    s, j = ana({'id': fail}); ok('real DO: Clef throws → 503 clef_failed', s == 503 and j.get('code') == 'clef_failed', (s, j))
    s, j = ana({'id': genf}); ok('real DO: generation failed → 200, suggest failed, 建议生成失败', s == 200 and j['suggest'] == 'failed' and j.get('suggestError') == '建议生成失败', (s, j))
    t0 = time.time(); s, j = ana({'id': slow}); dt = time.time() - t0
    ok('real DO: Clef slower than 10 s → 504 clef_timeout after ~10 s', s == 504 and j.get('code') == 'clef_timeout' and 9 <= dt <= 12, (s, j, round(dt, 1)))
    # caps: CHAT_ANA_IP_DAILY=5 → 3 successes so far (normal, DM, gen-failed); failures were refunded
    s1, j1 = ana({'id': first}); s2, j2 = ana({'id': pii}); s3, j3 = ana({'id': first})
    ok('real DO: per-IP cap 5 → 4th and 5th ok, 6th 429 ip_cap (failed calls refunded)', s1 == 200 and s2 == 200 and j2.get('left') == 0 and s3 == 429 and j3.get('code') == 'ip_cap', (s1, s2, j2.get('left'), s3, j3))
    s4, j4 = ana({'id': first}, ip='198.51.100.77')
    if s4 == 200:
        s5, _ = ana({'id': first}, ip='198.51.100.77'); s6, j6 = ana({'id': first}, ip='198.51.100.78')
        ok('real DO: site cap 7 → another IP gets 2, then 429 site_cap', s5 == 200 and s6 == 429 and j6.get('code') == 'site_cap', (s4, s5, s6, j6))
    else: print('SKIP site cap via another IP (local runtime overrides cf-connecting-ip):', s4, j4)
    for x in (a, b, c): await x.ws.close()
    print(f'{sum(res)} passed, {len(res) - sum(res)} failed'); sys.exit(0 if all(res) else 1)
asyncio.run(main())
