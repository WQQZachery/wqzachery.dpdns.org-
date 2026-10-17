# Bottom tab-bar lens drag/release test (Chromium, Android Edge UA, 402x874 @3x, real touch via CDP Input.dispatchTouchEvent).
# Usage: python3 tools/lens_drag_test.py [base]   (default http://127.0.0.1:8766 = tools/lproxy.py)
# Cases: every tab -> every other tab, slow and fast; release between tabs; fast move then hold (stale velocity);
#        short flick (advances one tab); touchcancel mid-drag (= release at last position, no revert).
# Asserts: final selected tab (state.target, aria-selected, URL) and final lens x (lens centre == tab centre within 1.5 px).
import asyncio, sys, time
from playwright.async_api import async_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8766'
GROUP = sys.argv[2] if len(sys.argv) > 2 else 'all'   # pairs | extra | all (all takes ~2 min)
UA = 'Mozilla/5.0 (Linux; Android 14; 23127PN0CC) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36 EdgA/129.0.0.0'
PATHS = ['/', '/drive', '/ai', '/chat']
GEOM = """(()=>{const b=document.getElementById('bar').getBoundingClientRect();const it=[...document.querySelectorAll('#row .it')].map(e=>{const r=e.getBoundingClientRect();return r.left+r.width/2});
 const l=document.getElementById('lens').getBoundingClientRect();return {y:b.top+b.height/2,left:b.left,w:b.width,it,lens:l.left+l.width/2,
 sel:[...document.querySelectorAll('#row .it')].findIndex(e=>e.getAttribute('aria-selected')==='true'),path:location.pathname,st:window.__st(),
 on:[...document.querySelectorAll('.pane')].findIndex(p=>p.classList.contains('on'))}})()"""

async def touch(cdp, typ, x=0, y=0, ts=None):
    # ts = event timestamp (s since epoch). CDP round-trips are ~50 ms each, so a scripted "fast" drag is only fast if the
    # events carry a virtual clock; the page reads e.timeStamp for flick velocity.
    pts = [] if typ in ('touchEnd', 'touchCancel') else [{'x': x, 'y': y, 'id': 1, 'radiusX': 8, 'radiusY': 8, 'force': 1}]
    a = {'type': typ, 'touchPoints': pts}
    if ts is not None: a['timestamp'] = ts
    await cdp.send('Input.dispatchTouchEvent', a)

async def settle(p, t=4.0):
    end = time.time() + t
    while time.time() < end:
        st = await p.evaluate('window.__st()')
        if not st['moving'] and not st['dragging']: break
        await asyncio.sleep(.05)
    await asyncio.sleep(.35)
    return await p.evaluate(GEOM)

async def drag(p, cdp, frm, to, dur, hold=0.0, end='touchEnd', stop_at=None):
    g = await p.evaluate(GEOM); y = g['y']
    iw = (g['it'][1] - g['it'][0])
    x0 = g['it'][frm]; x1 = g['it'][0] + to * iw          # 'to' may be fractional (between tabs)
    steps = max(4, int(dur / .016))
    t0 = time.time(); vt = 0.0
    await touch(cdp, 'touchStart', x0, y, t0); await asyncio.sleep(.03); vt += .03
    for i in range(1, steps + 1):
        f = i / steps
        if stop_at is not None and f > stop_at: break
        vt += dur / steps
        await touch(cdp, 'touchMove', x0 + (x1 - x0) * f, y, t0 + vt); await asyncio.sleep(dur / steps)
    if hold: await asyncio.sleep(hold); vt += hold
    await touch(cdp, end, ts=t0 + vt + .008)
    return await settle(p)

async def main():
    res = []
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path='/usr/bin/chromium')
        ctx = await b.new_context(viewport={'width': 402, 'height': 874}, device_scale_factor=3, is_mobile=True, has_touch=True, user_agent=UA)
        await ctx.add_init_script("try{localStorage.getItem('wqzAnnSeen')||localStorage.setItem('wqzAnnSeen','*')}catch(e){}")   # no update popup during tests (tools/ann_test.py covers it)
        p = await ctx.new_page(); cdp = await ctx.new_cdp_session(p)

        await p.goto(BASE + '/drive', wait_until='load')
        await p.wait_for_function("!document.getElementById('bar').classList.contains('hide')", timeout=8000)
        async def start(i):   # jump to the start tab without a drag (same message the pages send), then wait for rest
            await p.evaluate("k=>postMessage({type:'go',tab:k},location.origin)", ['home', 'drive', 'ai', 'chat'][i])
            await settle(p)

        def check(name, g, want):
            iw = g['it'][1] - g['it'][0]
            ok = (g['st']['target'] == want and g['sel'] == want and g['path'] == PATHS[want] and g['on'] == want
                  and abs(g['lens'] - g['it'][want]) < 1.5 and not g['st']['dragging'])
            res.append((ok, name, want, g['st']['target'], g['sel'], round(g['lens'] - g['it'][want], 2)))
            print(('PASS ' if ok else 'FAIL ') + f"{name}: want {want} got target={g['st']['target']} sel={g['sel']} pane={g['on']} path={g['path']} lens_dx={g['lens'] - g['it'][want]:.2f}px")

        for s in (range(4) if GROUP in ('pairs', 'all') else []):
            for t in range(4):
                if s == t: continue
                for spd, dur in (('slow', .9), ('fast', .09)):
                    await start(s); g = await drag(p, cdp, s, t, dur)
                    check(f'{s}->{t} {spd}', g, t)
        if GROUP != 'pairs':
              # release between tabs (slow, lens stops there): nearest tab under the lens centre wins
            for frm, to, want in ((0, 1.4, 1), (0, 1.6, 2), (3, 1.55, 2), (3, 1.45, 1), (1, 0.45, 0), (2, 2.45, 2)):
                await start(frm); g = await drag(p, cdp, frm, to, .8, hold=.25); check(f'between {frm}->{to}', g, want)
            # fast move then hold still before lifting: old velocity must not throw the lens on
            for frm, to, want in ((0, 2.3, 2), (3, 0.7, 1)):
                await start(frm); g = await drag(p, cdp, frm, to, .08, hold=.35); check(f'fast+hold {frm}->{to}', g, want)
            # genuine short flick: lens a little past a tab, finger still moving -> advance at most one tab in that direction
            for frm, to, want in ((1, 1.35, 2), (2, 1.65, 1), (0, 0.4, 1), (3, 2.6, 2)):
                await start(frm); g = await drag(p, cdp, frm, to, .06); check(f'flick {frm}->{to}', g, want)
            # slow drag released while still creeping past a tab centre: no flick, stays on the tab under the lens
            for frm, to, want in ((1, 1.3, 1), (2, 1.7, 2)):
                await start(frm); g = await drag(p, cdp, frm, to, .9); check(f'slow creep {frm}->{to}', g, want)
            # touchcancel mid-drag (Android taking the gesture): settle where the lens is, never revert to the start tab
            for frm, to, stop, want in ((0, 3, .7, 2), (3, 0, .65, 1), (1, 3, 1, 3)):
                await start(frm); g = await drag(p, cdp, frm, to, .6, end='touchCancel', stop_at=stop); check(f'cancel {frm}->{to}@{stop}', g, want)
            # touchcancel before the finger moved: nothing changes
            await start(2); g = await drag(p, cdp, 2, 2.02, .1, end='touchCancel'); check('cancel no-move 2', g, 2)
            # plain tap still works
            for frm, to in ((0, 3), (2, 1)):
                await start(frm); g = await p.evaluate(GEOM)
                await touch(cdp, 'touchStart', g['it'][to], g['y']); await asyncio.sleep(.05); await touch(cdp, 'touchEnd')
                check(f'tap {frm}->{to}', await settle(p), to)
        await b.close()
    n = sum(r[0] for r in res)
    print(f'\n{n}/{len(res)} passed')
    sys.exit(0 if n == len(res) else 1)

asyncio.run(main())
