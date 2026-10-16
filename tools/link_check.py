#!/usr/bin/env python3
"""Crawl every page's links (href/src in HTML, URLs in llms.txt / sitemap) and report anything that is not 2xx/3xx.
Usage: python3 tools/link_check.py [base]   (default https://wqz-test.15112479050.workers.dev)
Internal links are resolved against <base>; links to https://wqzachery.dpdns.org/... are also re-checked against <base>.
Exit code 1 when a link is broken. Placeholders built at runtime (mailto via JS, /api/files/raw/<path>) are not in the HTML."""
import sys, re, html, urllib.parse, concurrent.futures, requests
B = (sys.argv[1] if len(sys.argv) > 1 else 'https://wqz-test.15112479050.workers.dev').rstrip('/')
PAGES = ['/', '/p/home', '/p/drive', '/p/ai', '/p/chat', '/privacy', '/admin', '/llms.txt', '/sitemap.xml', '/robots.txt']
UA = {'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 link-check'}
links = {}
for pg in PAGES:
    r = requests.get(B + pg, headers=UA, timeout=20)
    links.setdefault(B + pg, set()).add('(page)')
    if r.status_code >= 400: print('PAGE', r.status_code, pg)
    t = r.text
    found = re.findall(r'(?:href|src)="([^"]+)"', t) + re.findall(r'<loc>([^<]+)</loc>', t) + re.findall(r'\((https?://[^)\s]+)\)', t) + re.findall(r'^(?:Sitemap|- [^:]+:)\s*(https?://\S+)', t, re.M)
    for u in found:
        u = html.unescape(u).strip()
        if u.startswith(('mailto:', 'javascript:', 'data:', '#', 'tel:')) or '${' in u or '__V__' in u: continue
        u = urllib.parse.urljoin(B + pg, u).split('#')[0]
        u = u.replace('https://wqzachery.dpdns.org', B)
        links.setdefault(u, set()).add(pg)
def check(u):
    try:
        r = requests.head(u, headers=UA, timeout=20, allow_redirects=True)
        if r.status_code in (403, 405, 404, 400, 501) or r.status_code >= 500:   # many sites reject HEAD: retry with GET
            r = requests.get(u, headers=UA, timeout=20, allow_redirects=True, stream=True); r.close()
        return u, r.status_code
    except Exception as e:
        return u, 'ERR ' + type(e).__name__
bad = 0
with concurrent.futures.ThreadPoolExecutor(12) as ex:
    for u, code in sorted(ex.map(check, links), key=lambda x: str(x[1])):
        okc = isinstance(code, int) and code < 400
        if not okc: bad += 1
        print(('OK  ' if okc else 'BAD ') + str(code), u, '' if okc else '← ' + ', '.join(sorted(links[u]))[:120])
print(f'\n{len(links)} links, {bad} broken'); sys.exit(1 if bad else 0)
