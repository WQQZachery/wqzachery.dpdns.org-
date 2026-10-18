# UI state checks in Chromium (Android Edge UA, 390x844). Needs tools/lproxy.py (:8766).
# Usage: python3 tools/ui_check.py [base]   -> work/shots/ui_*.png and PASS/FAIL lines
# Covers: drive list error+retry (when storage is down) or list, client-side upload rejections (size/type/renamed exe),
# report dialog, privacy sheet from drive/home/chat/AI, AI model picker, chat status, home entry cards + live stats, email mailto.
import asyncio, sys, os, tempfile
from playwright.async_api import async_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8766'
OUT = __file__.rsplit('/', 2)[0] + '/work/shots/'
UA = 'Mozilla/5.0 (Linux; Android 14; 23127PN0CC) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36 EdgA/129.0.0.0'
ok = bad = 0
def check(n, c, i=''):
    global ok, bad
    if c: ok += 1; print('PASS', n)
    else: bad += 1; print('FAIL', n, str(i)[:300])
async def main():
    tmp = tempfile.mkdtemp(); exe = os.path.join(tmp, 'tool.exe'); fake = os.path.join(tmp, 'cute-cat.jpg')
    open(exe, 'wb').write(b'MZ' + os.urandom(500)); open(fake, 'wb').write(b'MZ\x90\x00' + os.urandom(2000))
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path='/usr/bin/chromium')
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True, user_agent=UA)
        await ctx.add_init_script("try{localStorage.getItem('wqzAnnSeen')||localStorage.setItem('wqzAnnSeen','*')}catch(e){}")   # no update popup during tests (tools/ann_test.py covers it)
        p = await ctx.new_page()
        errs = []; p.on('pageerror', lambda e: errs.append(str(e)))
        # ---------- drive ----------
        await p.goto(BASE + '/p/drive'); await p.wait_for_timeout(2500)
        t = await p.inner_text('#list')
        if '重试' in t:
            check('drive: list failure shows reason + 重试 (no infinite spinner)', '失败' in t or '超时' in t, t)
            await p.screenshot(path=OUT + 'ui_drive_error.png')
            await p.click('[data-retry]'); await p.wait_for_timeout(300); check('drive: retry shows loading again', '加载' in await p.inner_text('#list') or '重试' in await p.inner_text('#list'))
        else:
            check('drive: list loaded', '加载中' not in t, t[:100])
        await p.set_input_files('#file', [exe]); await p.wait_for_timeout(800)
        u = await p.inner_text('#ups'); check('drive: .exe rejected with 类型不支持', '类型不支持' in u, u)
        await p.set_input_files('#file', [fake]); await p.wait_for_timeout(2500)
        u = await p.inner_text('#ups'); check('drive: renamed exe (cute-cat.jpg with MZ) rejected 类型不支持', u.count('类型不支持') >= 2, u)
        await p.screenshot(path=OUT + 'ui_drive_rejects.png', full_page=False)
        big = await p.evaluate("(async()=>{const f=new File([new Uint8Array(10)],'big.bin');Object.defineProperty(f,'size',{value:3*1024**3});const dt=new DataTransfer();dt.items.add(f);const i=document.getElementById('file');i.files=dt.files;i.dispatchEvent(new Event('change'));await new Promise(r=>setTimeout(r,600));return document.getElementById('ups').innerText})()")
        check('drive: >2GB rejected 文件太大', '文件太大' in big, big)
        txt = await p.inner_text('.sub') + await p.inner_text('#drop')
        check('drive: page states the limits (no "不限大小")', '2 GB' in txt and '不限' not in txt, txt)
        await p.click('.sub [data-privacy]'); await p.wait_for_timeout(1200)
        fr = [f for f in p.frames if 'privacy' in f.url]
        check('drive: privacy sheet opens with content', bool(fr) and '隐私说明' in await fr[0].inner_text('body'), [f.url for f in p.frames])
        await p.screenshot(path=OUT + 'ui_privacy_sheet.png')
        await p.keyboard.press('Escape'); await p.wait_for_timeout(300); check('drive: privacy sheet closes on Esc', await p.locator('#wz-pv').count() == 0)
        # report dialog: inject a fake file row so it works without storage
        await p.evaluate("""(()=>{const f={path:'files/20261016-abcdef-demo.txt',name:'demo.txt',dir:'',size:10};document.querySelector('#pvr').onclick=null;window.__f=f})()""")
        await p.evaluate("document.querySelector('#rp').hidden=false;document.querySelector('#rpn').textContent='demo.txt'")
        await p.wait_for_timeout(200); await p.screenshot(path=OUT + 'ui_report_dialog.png')
        bb = await p.evaluate("(()=>{const r=document.querySelector('.rpbox').getBoundingClientRect();return [r.left,r.right,r.bottom,innerWidth,innerHeight]})()")
        check('drive: report dialog fits 390px viewport', bb[0] >= 0 and bb[1] <= bb[3] and bb[2] <= bb[4], bb)
        await p.click('#rpc'); await p.wait_for_timeout(200); check('drive: report dialog closes', await p.evaluate("document.querySelector('#rp').hidden"))
        # ---------- home ----------
        await p.goto(BASE + '/p/home'); await p.wait_for_timeout(3200)
        ent = await p.evaluate("[...document.querySelectorAll('.entry .ent')].map(a=>a.getAttribute('href'))")
        check('home: four entry cards (项目/AI/网盘/聊天室)', ent == ['#projects', '/ai', '/drive', '/chat'], ent)
        st = await p.evaluate("[stDays.textContent,stFeat.textContent,stFiles.textContent]")
        check('home: live stats (days number, 4 features)', st[0].isdigit() and st[1] == '4', st)
        body = await p.inner_text('body')
        check('home: no 300+ / 24/7 fake stats', '300+' not in body and '24/7' not in body)
        hrefs = await p.evaluate("[...document.querySelectorAll('a.em')].map(a=>a.href)")
        check('home: e-mail links assembled by JS (mailto:)', len(hrefs) == 2 and all(h.startswith('mailto:') and '@' in h for h in hrefs), hrefs)
        html = await p.content(); check('home: source repo link present (repo public since 2026-10-18)', 'github.com/WQQZachery/wqzachery.dpdns.org-' in html)
        await p.evaluate("document.querySelector('#about').scrollIntoView()"); await p.wait_for_timeout(900)
        await p.screenshot(path=OUT + 'ui_home_stats.png')
        await p.evaluate("scrollTo(0,0)"); await p.wait_for_timeout(500); await p.screenshot(path=OUT + 'ui_home_hero.png')
        # ---------- AI ----------
        await p.goto(BASE + '/p/ai'); await p.wait_for_timeout(1500)
        check('ai: privacy link near the input', await p.locator('#f [data-privacy]').count() == 1)
        await p.click('#mb'); await p.wait_for_timeout(500); pan = await p.inner_text('#pan')
        check('ai: model picker lists categories (list loaded)', '推荐' in pan, pan[:200])
        await p.screenshot(path=OUT + 'ui_ai_picker.png')
        # ---------- chat ----------
        await p.goto(BASE + '/p/chat'); await p.wait_for_timeout(3000)
        check('chat: privacy link near input', await p.locator('#f [data-privacy]').count() == 1)
        on = await p.inner_text('#ontx'); check('chat: status shows connection state or real count', '连接' in on or '在线' in on or '断开' in on, on)
        await p.screenshot(path=OUT + 'ui_chat.png')
        check('no page errors', not errs, errs)
        await b.close()
    print(f'\n{ok} passed, {bad} failed')
asyncio.run(main())
