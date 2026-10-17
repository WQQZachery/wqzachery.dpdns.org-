#!/usr/bin/env python3
"""Push files to GitHub as ONE commit on main (Git Data API) — one commit = one Workers Build.
Usage: python3 tools/push_github.py "<msg>" src:dst [src:dst ...]   (run with github credentials). Skips unchanged files; no commit if nothing changed."""
import sys, json, base64, hashlib, subprocess
OWNER, REPO, BR = 'WQQZachery', 'wqzachery.dpdns.org-', 'main'
API = f'https://api.github.com/repos/{OWNER}/{REPO}'
def gh(method, path, body=None):
    cmd = ['curl', '-s', '-X', method, API + path, '-H', 'Accept: application/vnd.github+json']
    inp = None
    if body is not None: cmd += ['--data-binary', '@-']; inp = json.dumps(body).encode()
    return json.loads(subprocess.run(cmd, input=inp, capture_output=True).stdout or b'{}')
msg, pairs = sys.argv[1], [a.split(':', 1) for a in sys.argv[2:]]
head = gh('GET', f'/git/ref/heads/{BR}')['object']['sha']
base_tree = gh('GET', f'/git/commits/{head}')['tree']['sha']
remote = {t['path']: t['sha'] for t in gh('GET', f'/git/trees/{base_tree}?recursive=1')['tree'] if t['type'] == 'blob'}
tree = []
for src, dst in pairs:
    data = open(src, 'rb').read()
    if dst.endswith('.admin_key'): sys.exit('refusing to push admin key')
    local = hashlib.sha1(b'blob %d\0' % len(data) + data).hexdigest()
    if remote.get(dst) == local: continue
    b = gh('POST', '/git/blobs', {'content': base64.b64encode(data).decode(), 'encoding': 'base64'})
    tree.append({'path': dst, 'mode': '100755' if dst.endswith('.sh') else '100644', 'type': 'blob', 'sha': b['sha']}); print('changed', dst)
if not tree: print('no changes, nothing committed'); sys.exit(0)
t = gh('POST', '/git/trees', {'base_tree': base_tree, 'tree': tree})
c = gh('POST', '/git/commits', {'message': msg, 'tree': t['sha'], 'parents': [head]})
r = gh('PATCH', f'/git/refs/heads/{BR}', {'sha': c['sha']})
print('commit', c.get('sha'), 'ok' if r.get('object') else r)
