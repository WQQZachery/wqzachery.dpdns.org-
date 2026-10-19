#!/usr/bin/env python3
"""AI page Markdown rendering: elements, HTML safety, streaming (no jumps / lost newlines / broken code blocks), code copy.
Runs against the MOCK API (tools/mock_api.py behind tools/lproxy.py):
  python3 tools/md_test.py [http://127.0.0.1:8767]"""
import asyncio, sys
from playwright.async_api import async_playwright
BASE = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8767').rstrip('/')
ok = bad = 0
def check(n, c, i=''):
    global ok, bad
    if c: ok += 1; print('PASS', n)
    else: bad += 1; print('FAIL', n, i)

# Each case: markdown → JS predicate over a <div> holding the rendered HTML (variable d)
CASES = [
    ('headings h1-h3', '# A\n## B\n### C', "d.querySelector('h1')&&d.querySelector('h2')&&d.querySelector('h3')"),
    ('paragraphs', 'one\n\ntwo', "d.querySelectorAll('p').length===2"),
    ('single newline kept', 'line1\nline2', "d.querySelector('p br')!==null"),
    ('bold + italic', '**b** and *i* and _j_', "d.querySelector('strong')&&d.querySelectorAll('em').length===2"),
    ('strikethrough', '~~gone~~', "d.querySelector('del')!==null"),
    ('unordered list + nesting', '- a\n- b\n  - c', "d.querySelectorAll('ul').length===2&&d.querySelectorAll('li').length===3"),
    ('ordered list keeps start', '3. x\n4. y', "d.querySelector('ol')&&d.querySelector('ol').getAttribute('start')==='3'"),
    ('task list checkbox disabled', '- [x] done\n- [ ] todo', "d.querySelectorAll('input[type=checkbox][disabled]').length===2"),
    ('blockquote', '> quoted', "d.querySelector('blockquote p')!==null"),
    ('link opens safely', '[x](https://example.com)', "(a=>a&&a.target==='_blank'&&/noopener/.test(a.rel)&&a.href==='https://example.com/')(d.querySelector('a'))"),
    ('bare URL autolinks', 'see https://example.com/a', "d.querySelector('a[href=\"https://example.com/a\"]')!==null"),
    ('table wrapped for scroll', '| a | b |\n|:-|-:|\n| 1 | 2 |', "d.querySelector('.tw>table th')&&d.querySelector('td[align=right]')"),
    ('inline code escaped', 'use `<b>x</b>`', "d.querySelector('p code').textContent==='<b>x</b>'&&!d.querySelector('b')"),
    ('fenced code: lang label + copy + content intact', '```python\nif a < b:\n\n    print("x")\n```',
     "d.querySelector('.cb .cl').textContent==='python'&&d.querySelector('.cb [data-act=copycode]')&&d.querySelector('.cb code').textContent==='if a < b:\\n\\n    print(\"x\")'"),
    ('fenced code: no lang', '```\nplain\n```', "d.querySelector('.cb code').textContent==='plain'&&!d.querySelector('.cl')"),
    ('several languages', '```js\n1\n```\n\n```go\n2\n```\n\n```c++\n3\n```', "[...d.querySelectorAll('.cl')].map(x=>x.textContent).join()==='js,go,c++'"),
    ('unclosed fence (mid-stream) still a code block', 'text\n\n```js\nconst a = 1;', "d.querySelector('.cb code').textContent==='const a = 1;'"),
    # safety
    ('raw <script> shown as text', '<script>window.__x=1</script>', "!d.querySelector('script')&&d.textContent.includes('<script>')"),
    ('inline html escaped', 'hi <img src=x onerror=alert(1)> <b onclick=x>t</b>', "!d.querySelector('img,b,[onerror],[onclick]')"),
    ('javascript: link dropped', '[x](javascript:alert(1))', "!d.querySelector('a')&&d.textContent.includes('x')"),
    ('data: link dropped', '[x](data:text/html,<script>1</script>)', "!d.querySelector('a')"),
    ('image → link, no remote load', '![pic](https://example.com/a.png)', "!d.querySelector('img')&&d.querySelector('a').textContent.includes('图片')"),
    ('image with js: url → text', '![pic](javascript:1)', "!d.querySelector('img,a')"),
    ('attribute injection in title', '[x](https://e.com "a\\" onmouseover=\\"1")', "!d.querySelector('[onmouseover]')"),
    ('html in table cell escaped', '| a |\n|-|\n| <iframe src=x></iframe> |', "!d.querySelector('iframe')"),
    ('svg/style tags escaped', '<svg onload=alert(1)><style>body{}</style>', "!d.querySelector('svg,style')"),
]

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path='/usr/bin/chromium')
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
        await ctx.add_init_script("try{localStorage.setItem('wqzAnnSeen','*');if(!sessionStorage.getItem('mdt')){sessionStorage.setItem('mdt','1');localStorage.removeItem('astra.v2')}}catch(e){}")
        await ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin=BASE)
        p = await ctx.new_page(); errs = []; p.on('pageerror', lambda e: errs.append(str(e)))
        await p.goto(BASE + '/p/ai'); await p.wait_for_function('window.__astra')
        check('marked loaded', await p.evaluate('!!(window.marked&&marked.Marked)'))
        for name, src, pred in CASES:
            r = await p.evaluate("([s,pred])=>{const d=document.createElement('div');d.innerHTML=__astra.md(s);window.__x=0;let a;try{a=!!(new Function('d','a','return '+pred))(d)}catch(e){a='ERR '+e}return [a,d.innerHTML]}", [src, pred])
            check('md: ' + name, r[0] is True, r[1][:300])
        check('no script ran', await p.evaluate('!window.__x'))

        # ---- streaming: record the bubble while the mock streams a long Markdown reply in 7-char pieces
        await p.evaluate("""window.__snap=[];new MutationObserver(()=>{const w=document.querySelector('.msg.a:last-of-type');if(w&&w.classList.contains('md'))__snap.push({h:w.getBoundingClientRect().height,pre:[...w.querySelectorAll('pre')].length,cls:w.className})}).observe(document.getElementById('inner'),{childList:true,subtree:true,characterData:true})""")
        await p.fill('#in', '#md 演示'); await p.click('#send')
        await p.wait_for_function("!document.querySelector('#send.stop')", timeout=20000)
        snaps = await p.evaluate('__snap')
        hs = [s['h'] for s in snaps]
        shrink = max([hs[i - 1] - hs[i] for i in range(1, len(hs))] or [0])
        check('stream: rendered as Markdown while streaming', any('typing' in s['cls'] for s in snaps), str(len(snaps)))
        check('stream: bubble never shrinks by more than one line (no jump)', shrink <= 26, 'max shrink %.1fpx' % shrink)
        check('stream: repaint throttled (≤ ~16/s)', len(snaps) < 200, str(len(snaps)))
        w = p.locator('.msg.a').last
        info = await w.evaluate("""w=>({h1:!!w.querySelector('h1'),br:!!w.querySelector('p br'),ul:w.querySelectorAll('ul li').length,ol:w.querySelectorAll('ol li').length,
            bq:!!w.querySelector('blockquote'),tbl:w.querySelectorAll('.tw td').length,a:(w.querySelector('a[href^="https://example.com"]')||{}).target,
            code:[...w.querySelectorAll('.cb code')].map(c=>c.textContent),langs:[...w.querySelectorAll('.cl')].map(c=>c.textContent),
            script:!!w.querySelector('script'),txt:w.textContent.includes('<script>alert(1)</script>'),ws:getComputedStyle(w).whiteSpace,
            pre:getComputedStyle(w.querySelector('pre')).whiteSpace,typing:w.classList.contains('typing'),last:w.textContent.trim().endsWith('结束。')})""")
        check('final: all elements present', info['h1'] and info['ul'] == 3 and info['ol'] == 2 and info['bq'] and info['tbl'] == 4 and info['a'] == '_blank', str(info))
        check('final: single newline kept', info['br'], str(info))
        check('final: code blocks intact (blank line kept, < not escaped twice)', info['code'] == ['const a = 1;\n\nconsole.log(a < 2);', 'print("你好")'], str(info['code']))
        check('final: language labels', info['langs'] == ['js', 'python'], str(info['langs']))
        check('final: raw <script> shown as text, not run', not info['script'] and info['txt'], str(info))
        check('final: normal white-space in Markdown, pre keeps whitespace', info['ws'] == 'normal' and info['pre'] == 'pre', str(info))
        check('final: cursor gone, ends with last text', not info['typing'] and info['last'], str(info))
        # copy code button copies the code only
        await w.locator('[data-act=copycode]').first.click(); await p.wait_for_timeout(200)
        clip = await p.evaluate('navigator.clipboard.readText()')
        check('copy code: exact code', clip == 'const a = 1;\n\nconsole.log(a < 2);', repr(clip))
        await p.locator('.acts [data-act=copy]').last.click(); await p.wait_for_timeout(200)
        clip = await p.evaluate('navigator.clipboard.readText()')
        check('copy reply: original Markdown', clip.startswith('# 标题一') and '```js' in clip, clip[:60])
        # reload: history re-renders the same Markdown
        await p.reload(); await p.wait_for_function('window.__astra'); await p.wait_for_timeout(300)
        n = await p.evaluate("[document.querySelectorAll('.msg.a.md h1').length,document.querySelectorAll('.msg.a.md .cb').length]")
        check('history reload renders Markdown', n == [1, 2], str(n))
        # mobile: wide table / long code scroll inside the bubble, page has no horizontal overflow
        await p.evaluate("""()=>{const c=__astra.cv;c.msgs.push({role:'user',content:'宽',ts:Date.now()},{role:'assistant',content:'| '+Array.from({length:12},(_, i)=>'很长的列名'+i).join(' | ')+' |\\n|'+'-|'.repeat(12)+'\\n| '+Array(12).fill('数据').join(' | ')+' |\\n\\n```\\n'+'x'.repeat(400)+'\\n```',ts:Date.now()});__astra.persist()}""")
        await p.reload(); await p.wait_for_function('window.__astra'); await p.wait_for_timeout(300)
        ov = await p.evaluate("[document.documentElement.scrollWidth-innerWidth,[...document.querySelectorAll('.msg.a')].every(m=>m.getBoundingClientRect().right<=innerWidth+1)]")
        check('mobile: no horizontal overflow with wide table + long code', ov[0] <= 0 and ov[1], str(ov))
        check('no page errors', not errs, str(errs))
        await b.close()
    print(f'{ok} passed, {bad} failed'); sys.exit(1 if bad else 0)
asyncio.run(main())
