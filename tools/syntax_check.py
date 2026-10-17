#!/usr/bin/env python3
"""node --check every inline <script> in site/*.html and worker/worker.js (imports stripped). Exit 1 on any error."""
import re, subprocess, glob, os, sys, tempfile
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
bad = 0; n = 0
def chk(code, label, mod=False):
    global bad, n
    n += 1
    with tempfile.NamedTemporaryFile('w', suffix='.mjs' if mod else '.js', delete=False) as f: f.write(code); fn = f.name
    r = subprocess.run(['node', '--check', fn], capture_output=True, text=True); os.unlink(fn)
    if r.returncode: bad += 1; print('FAIL', label, r.stderr.strip()[:600])
for p in sorted(glob.glob(os.path.join(root, 'site', '*.html'))):
    s = open(p, encoding='utf-8').read()
    for i, m in enumerate(re.finditer(r'<script(?![^>]*\bsrc=)(?![^>]*type="application/ld\+json")[^>]*>(.*?)</script>', s, re.S)):
        chk(m.group(1), f'{os.path.basename(p)}#script{i}')
for p in ['site/shared.js']: chk(open(os.path.join(root, p)).read(), p)
w = open(os.path.join(root, 'worker/worker.js')).read()
w = re.sub(r'^import .*$', '', w, flags=re.M)  # imported names are only used at runtime; node --check does not resolve them
chk(w, 'worker.js', True)
print(f'{n} scripts checked, {bad} failed'); sys.exit(1 if bad else 0)
