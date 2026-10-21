#!/usr/bin/env python3
"""Browser test for the chat room 「聊天分析」 panel (Chromium, Playwright). Needs the mock API behind lproxy:
  MPORT=8768 python3 tools/mock_api.py &  PORT=8766 UP=http://127.0.0.1:8768 python3 tools/lproxy.py &
  python3 tools/analyze_ui_test.py [base]
The chat WebSocket is replaced by an in-page fake (history with message ids 1..7, see mock_api.py for what each id returns), so nothing
reaches a real chat room or AI. Covers: message menu → analysis, loading / success / error states, retry, cap error without retry,
reply-generation failure, copy button, keyboard + Esc, stale result after closing, tap targets ≥ 44 px, no horizontal overflow at
360 / 390 / 412 px (Android Edge + iPhone UAs) and inside the /chat shell. Screenshots → work/shots/ana_*.png (not committed)."""
import asyncio, sys, json, os, urllib.request
from playwright.async_api import async_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8766'
MOCK = os.environ.get('MOCK', 'http://127.0.0.1:8768')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'work', 'shots') + '/'
os.makedirs(OUT, exist_ok=True)
EDGE = 'Mozilla/5.0 (Linux; Android 14; 23127PN0CC) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36 EdgA/129.0.0.0'
IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
FAKE_WS = r"""
try{localStorage.setItem('wqzAnnSeen','*');localStorage.setItem('chatAnaTip','1')}catch(e){}
(()=>{const now=Date.now();
const H=[{id:1,uid:'bbbbbbbbbbbbbbbb',nick:'好奇的熊猫',text:'请问网盘怎么上传文件？',ts:now-600000},
 {id:2,uid:'cccccccccccccccc',nick:'酷酷的狐狸',text:'这个慢一点分析（加载状态）',ts:now-500000},
 {id:3,uid:'bbbbbbbbbbbbbbbb',nick:'好奇的熊猫',text:'这条会分析失败',ts:now-400000},
 {id:4,uid:'cccccccccccccccc',nick:'酷酷的狐狸',text:'这条会遇到次数上限',ts:now-300000},
 {id:5,uid:'bbbbbbbbbbbbbbbb',nick:'好奇的熊猫',text:'这条的回复建议会生成失败',ts:now-200000},
 {id:7,uid:'cccccccccccccccc',nick:'酷酷的狐狸',text:'超长消息'.repeat(60)+'https://example.com/'+'a'.repeat(150),ts:now-100000},
 {id:8,uid:'aaaaaaaaaaaaaaaa',nick:'我自己',text:'我发的一条',ts:now-50000}];
class FWS{constructor(u){this.url=u;this.readyState=0;FWS.last=this;setTimeout(()=>{this.readyState=1;this.onopen&&this.onopen({});
  this.onmessage&&this.onmessage({data:JSON.stringify({t:'hello',me:{uid:'aaaaaaaaaaaaaaaa',nick:'我自己'},history:H,dms:[],n:3,users:[{uid:'aaaaaaaaaaaaaaaa',nick:'我自己'}]})})},50)}
  send(d){if(d==='ping')return;let m;try{m=JSON.parse(d)}catch(e){return}if(m.t==='msg'){FWS.sent=(FWS.sent||[]).concat(m)}}
  close(){this.readyState=3}}
FWS.CONNECTING=0;FWS.OPEN=1;FWS.CLOSING=2;FWS.CLOSED=3;window.WebSocket=FWS;window.__FWS=FWS})();
"""
res = []
def ok(n, c, extra=''):
    res.append((n, bool(c))); print(('PASS ' if c else 'FAIL ') + n + (' — ' + str(extra) if extra and not c else ''), flush=True)
def mock(path, data=None):
    r = urllib.request.Request(MOCK + path, data=data, method='POST' if data is not None else 'GET'); return json.loads(urllib.request.urlopen(r, timeout=5).read())
GEOM = r"""()=>{const p=document.querySelector('#pan'),s=document.querySelector('#sheet');
 const vis=e=>{const r=e.getBoundingClientRect(),st=getComputedStyle(e);return r.width>0&&r.height>0&&st.visibility!=='hidden'&&st.display!=='none'};
 const small=[...p.querySelectorAll('button')].filter(vis).map(b=>{const r=b.getBoundingClientRect(),be=getComputedStyle(b,'::before');const hs=be.content!=='none'&&be.position==='absolute';
   return [Math.round(Math.max(r.width,hs?parseFloat(be.width)||0:0)),Math.round(Math.max(r.height,hs?parseFloat(be.height)||0:0)),(b.getAttribute('aria-label')||b.textContent).trim().slice(0,16)]}).filter(([w,h])=>w<44||h<44);
 const pr=p.getBoundingClientRect();
 const over=[...p.querySelectorAll('*')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.right>pr.right+1||r.left<pr.left-1)}).map(e=>e.className||e.tagName).slice(0,5);
 return {docOver:document.documentElement.scrollWidth-innerWidth,panOverX:p.scrollWidth-p.clientWidth,panLeft:Math.round(pr.left),panRight:Math.round(innerWidth-pr.right),
   panBottom:Math.round(innerHeight-pr.bottom),small,over,open:s.classList.contains('on')}}"""

async def open_chat(b, w, h, ua, mob=True):
    ctx = await b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2 if mob else 1, is_mobile=mob, has_touch=mob, user_agent=ua, reduced_motion='reduce')
    await ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin=BASE)
    await ctx.add_init_script(FAKE_WS)
    p = await ctx.new_page()
    await p.goto(BASE + '/p/chat', wait_until='load')
    await p.wait_for_selector('.row[data-id="1"] .bub', timeout=8000)
    return ctx, p

async def tap(p, sel, mob):
    if mob: await p.tap(sel)
    else: await p.click(sel)

async def main():
    mock('/api/__reset', b'{}')
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path='/usr/bin/chromium')
        # ---------- full flow on a 390 px Android Edge phone ----------
        ctx, p = await open_chat(b, 390, 844, EDGE)
        await tap(p, '.row[data-id="2"] .bub', True)
        await p.wait_for_selector('#pan[data-k=msg]', timeout=3000)
        ok('menu: tapping a message opens the message sheet with 聊天分析', await p.locator('#pan [data-a=ana]').inner_text() == '聊天分析')
        ok('menu: sheet says 模型推测，仅供参考', '模型推测，仅供参考' in await p.locator('#pan').inner_text())
        await p.screenshot(path=OUT + 'ana_390_menu.png')
        await tap(p, '#pan [data-a=ana]', True)
        await p.wait_for_selector('#pan[data-k=ana] .an-load', timeout=2000)
        ok('loading: 正在分析… + skeleton, aria-busy=true', (await p.locator('#anb').get_attribute('aria-busy')) == 'true' and await p.locator('.an-sk i').count() == 4)
        await p.screenshot(path=OUT + 'ana_390_loading.png')
        await p.wait_for_selector('#anb .an-sec', timeout=6000)
        txt = await p.locator('#pan').inner_text()
        ok('success: intent / tone / reason / replies sections', all(x in txt for x in ['意图', '语气', '分析依据', '回复建议']))
        ok('success: wording (较可能 / 有可能 / 不确定), no percentages', '较可能' in txt and '不确定' in txt and '%' not in txt)
        ok('success: uncertainty list shown', await p.locator('.an-un li').count() == 3)
        ok('success: 3 reply ideas with copy buttons', await p.locator('.an-rp').count() == 3 and await p.locator('[data-a=cp]').count() == 3)
        ok('success: note 模型推测，仅供参考 + remaining count', '模型推测，仅供参考' in txt and '今天还可以分析 17 次' in txt)
        ok('success: aria-busy cleared', (await p.locator('#anb').get_attribute('aria-busy')) == 'false')
        html = (await p.content()).lower()
        ok('success: no model name on the page', not any(x in html for x in ['clef', 'gpt-oss', 'llama']))
        g = await p.evaluate(GEOM)
        ok('success 390: no horizontal overflow (page + panel)', g['docOver'] <= 0 and g['panOverX'] <= 0 and not g['over'], g)
        ok('success 390: all panel buttons ≥ 44×44', not g['small'], g['small'])
        await p.screenshot(path=OUT + 'ana_390_success.png')
        await p.locator('#pan').evaluate('e=>e.scrollTop=e.scrollHeight'); await p.screenshot(path=OUT + 'ana_390_success_bottom.png')
        await tap(p, '[data-a=cp][data-i="1"]', True)
        await p.wait_for_timeout(200)
        ok('copy: button flips to 已复制 ✓', await p.locator('[data-a=cp][data-i="1"]').inner_text() == '已复制 ✓')
        ok('copy: clipboard holds the reply text', await p.evaluate('navigator.clipboard.readText()') == '可以，在这里。')
        st = mock('/api/__stats')
        ok('request: page sends id + chat key only (server reads text itself)', st.get('ana') == 1 and st.get('ana_keys') == 1, st)
        # ---------- error + retry ----------
        await p.keyboard.press('Escape'); await p.wait_for_timeout(100)
        ok('Esc closes the panel', not (await p.evaluate(GEOM))['open'])
        await tap(p, '.row[data-id="3"] .bub', True); await tap(p, '#pan [data-a=ana]', True)
        await p.wait_for_selector('#anb .wz-state.err', timeout=4000)
        ok('error: alert with message + 重试', '分析服务暂时不可用' in await p.locator('#anb').inner_text() and await p.locator('#anb [data-a=retry]').count() == 1 and await p.locator('#anb [role=alert]').count() == 1)
        await p.screenshot(path=OUT + 'ana_390_error.png')
        n0 = mock('/api/__stats')['ana']
        await tap(p, '#anb [data-a=retry]', True)
        await p.wait_for_selector('#anb .an-load', timeout=2000)
        ok('retry: back to loading', True)
        await p.wait_for_selector('#anb .wz-state.err', timeout=4000)
        ok('retry: sent a new request', mock('/api/__stats')['ana'] == n0 + 1)
        # ---------- cap error: no retry ----------
        await tap(p, '.an-x', True)
        await tap(p, '.row[data-id="4"] .bub', True); await tap(p, '#pan [data-a=ana]', True)
        await p.wait_for_selector('#anb .wz-state.err', timeout=4000)
        ok('429 cap: clear message, no retry button', '次数已用完' in await p.locator('#anb').inner_text() and await p.locator('#anb [data-a=retry]').count() == 0)
        await p.screenshot(path=OUT + 'ana_390_cap.png')
        # ---------- reply ideas failed ----------
        await tap(p, '.an-x', True)
        await tap(p, '.row[data-id="5"] .bub', True); await tap(p, '#pan [data-a=ana]', True)
        await p.wait_for_selector('#anb .an-sec', timeout=4000)
        t5 = await p.locator('#pan').inner_text()
        ok('suggest failed: classification shown + 建议生成失败 + 重新分析', '提问' in t5 and '建议生成失败' in t5 and await p.locator('#anb [data-a=retry]').count() == 1 and await p.locator('.an-rp').count() == 0)
        await p.screenshot(path=OUT + 'ana_390_suggest_failed.png')
        # ---------- stale result after closing ----------
        await tap(p, '.an-x', True)
        await tap(p, '.row[data-id="2"] .bub', True); await tap(p, '#pan [data-a=ana]', True)
        await p.wait_for_selector('#anb .an-load', timeout=2000)
        await tap(p, '.an-x', True); await p.wait_for_timeout(3000)
        ok('closing while loading: late result does not reopen the panel', not (await p.evaluate(GEOM))['open'])
        # ---------- pending own message ----------
        await p.evaluate("""()=>{const i=document.querySelector('#in');i.value='还没确认的消息';i.dispatchEvent(new Event('input'));document.querySelector('#send').click()}""")
        await p.wait_for_selector('.row.pend .bub', timeout=2000)
        await tap(p, '.row.pend .bub', True); await p.wait_for_timeout(150)
        ok('pending message: toast instead of analysis', '发送中' in await p.locator('#toast').inner_text() and not (await p.evaluate(GEOM))['open'])
        # ---------- links inside a message still open as links (no sheet) ----------
        await ctx.close()
        # ---------- long message, narrow phones, iPhone UA ----------
        for (w, h, ua, name) in [(360, 740, EDGE, 'edge360'), (390, 844, IOS, 'iphone390'), (412, 915, EDGE, 'edge412')]:
            ctx, p = await open_chat(b, w, h, ua)
            g0 = await p.evaluate('document.documentElement.scrollWidth-innerWidth')
            await tap(p, '.row[data-id="7"] .bub', True); await tap(p, '#pan [data-a=ana]', True)
            await p.wait_for_selector('#anb .an-sec', timeout=5000)
            g = await p.evaluate(GEOM)
            ok(f'{name}: long text, no horizontal overflow', g0 <= 0 and g['docOver'] <= 0 and g['panOverX'] <= 0 and not g['over'], g)
            ok(f'{name}: panel inside the screen with margins, buttons ≥ 44', g['panLeft'] >= 8 and g['panRight'] >= 8 and g['panBottom'] >= 0 and not g['small'], g)
            await p.screenshot(path=OUT + f'ana_{name}_long.png')
            await ctx.close()
        # ---------- inside the /chat shell (iframe, tab bar) ----------
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True, user_agent=EDGE, reduced_motion='reduce')
        await ctx.add_init_script(FAKE_WS); p = await ctx.new_page()
        await p.goto(BASE + '/chat', wait_until='load'); await p.wait_for_timeout(2500)
        fr = next((f for f in p.frames if f.url.endswith('/p/chat')), None)
        if fr:
            await fr.wait_for_selector('.row[data-id="1"] .bub', timeout=8000)
            await fr.tap('.row[data-id="1"] .bub'); await fr.tap('#pan [data-a=ana]')
            await fr.wait_for_selector('#anb .an-sec', timeout=5000)
            g = await fr.evaluate(GEOM)
            ok('shell /chat: panel fits above the tab bar, no overflow', g['docOver'] <= 0 and g['panOverX'] <= 0 and g['panBottom'] >= 90 and not g['small'], g)
            await p.screenshot(path=OUT + 'ana_shell_390.png')
        else: ok('shell /chat: chat iframe found', False)
        await ctx.close()
        # ---------- desktop: keyboard ----------
        ctx, p = await open_chat(b, 1280, 900, None, mob=False)
        await p.focus('.row[data-id="1"] .bub'); await p.keyboard.press('Enter')
        await p.wait_for_selector('#pan[data-k=msg]', timeout=2000)
        ok('keyboard: Enter on a focused message opens the menu, focus on 聊天分析', await p.evaluate("document.activeElement&&document.activeElement.dataset.a") == 'ana')
        await p.keyboard.press('Enter'); await p.wait_for_selector('#anb .an-sec', timeout=5000)
        ok('keyboard: analysis opens with focus on close button', await p.evaluate("document.activeElement&&document.activeElement.classList.contains('an-x')"))
        await p.screenshot(path=OUT + 'ana_1280_success.png')
        ok('desktop: no overflow', (await p.evaluate(GEOM))['docOver'] <= 0)
        await ctx.close()
        await b.close()
    n = sum(1 for _, c in res if c); print(f'{n} passed, {len(res) - n} failed'); sys.exit(0 if n == len(res) else 1)
asyncio.run(main())
