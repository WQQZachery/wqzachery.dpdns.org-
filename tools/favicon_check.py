#!/usr/bin/env python3
"""Every page declares the same brand icons and they load (200 + right type). Also catches stray text before <body> content.
  python3 tools/favicon_check.py [base]"""
import asyncio, sys, re, os
from playwright.async_api import async_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8767'
PAGES = ['/', '/p/home', '/p/drive', '/p/ai', '/p/chat', '/privacy', '/admin']
WANT = {'/favicon.svg': 'image/svg+xml', '/favicon.ico': 'image/x-icon', '/apple-touch-icon.png': 'image/png'}
ok = bad = 0
def check(n, c, i=''):
    global ok, bad
    if c: ok += 1; print('PASS', n)
    else: bad += 1; print('FAIL', n, str(i)[:300])
async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path='/usr/bin/chromium'); ctx = await b.new_context(); p = await ctx.new_page()
        for path in PAGES:
            await p.goto(BASE + path); await p.wait_for_timeout(200)
            hrefs = await p.evaluate("[...document.querySelectorAll('head link[rel~=icon],head link[rel=apple-touch-icon]')].map(l=>new URL(l.href).pathname).sort()")
            check(f'{path}: icons in <head> = svg + ico + apple', hrefs == sorted(WANT), hrefs)
            stray = await p.evaluate("[...document.body.childNodes].filter(n=>(n.nodeType===3&&n.textContent.trim())||(n.nodeType===1&&/^(rect|text|path|svg:.*)$/i.test(n.tagName)&&n.parentNode===document.body)).map(n=>(n.tagName||'#text')+':'+n.textContent.trim().slice(0,40))")
            check(f'{path}: no stray text nodes in <body>', not stray, stray)
        for u, ct in WANT.items():
            r = await p.request.get(BASE + u)
            check(f'{u}: 200 {ct}', r.status == 200 and r.headers.get('content-type', '').startswith(ct) and len(await r.body()) > 100, (r.status, r.headers.get('content-type')))
        await b.close()
    s = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'site', '404.html'), encoding='utf-8').read()
    check('404.html declares the same icons', all(x in s for x in WANT), [x for x in WANT if x not in s])
    print(f'{ok} passed, {bad} failed'); sys.exit(1 if bad else 0)
asyncio.run(main())
