#!/usr/bin/env python3
"""Push files to GitHub as ONE commit on a branch (Git Data API) — one commit = one Workers Build when the branch is main.

Usage:
  GITHUB_TOKEN=... python3 tools/push_github.py [--branch BR] [--create-from BASE] "<msg>" src:dst [src:dst ...]

  --branch BR        target branch (default: main = PRODUCTION, pushing there deploys the live site)
  --create-from BASE create BR from BASE first when BR does not exist yet (e.g. --branch fix-x --create-from main)

Auth: the token is read ONLY from the environment, GITHUB_TOKEN (or GH_TOKEN). Use a fine-grained token limited to this
repository with "Contents: read and write"; nothing else is needed. The token is sent as an explicit Authorization header,
never printed, never written to disk. Set it for one command only, e.g. `GITHUB_TOKEN="$(cat ~/.gh_token)" python3 ...`.
GITHUB_API overrides the API base (used by tools/push_github_test.py with a local mock server).

Every API call is checked: any non-2xx answer, network error, malformed JSON or a lost race on the branch (someone pushed
in between → GitHub answers 422 "not a fast forward") stops the script with a non-zero exit code and NO success message.
Exit codes: 0 ok / nothing to do, 1 API or network error, 2 usage / missing token, 3 branch moved (SHA conflict)."""
import sys, os, json, base64, hashlib, urllib.request, urllib.error

OWNER, REPO = 'WQQZachery', 'wqzachery.dpdns.org-'
API = os.environ.get('GITHUB_API', 'https://api.github.com').rstrip('/') + f'/repos/{OWNER}/{REPO}'
TIMEOUT = 60


class GhError(Exception):
    def __init__(self, msg, code=1):
        super().__init__(msg); self.code = code


def token():
    t = (os.environ.get('GITHUB_TOKEN') or os.environ.get('GH_TOKEN') or '').strip()
    if not t: raise GhError('missing token: set GITHUB_TOKEN (fine-grained, this repo only, Contents: read and write)', 2)
    return t


def gh(tok, method, path, body=None, ok=(200, 201)):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method, headers={
        'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + tok, 'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'wqz-push-github', **({'Content-Type': 'application/json'} if data is not None else {})})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            status, raw = r.status, r.read()
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read()
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise GhError(f'network error on {method} {path}: {type(e).__name__}')
    try: j = json.loads(raw or b'{}')
    except ValueError: j = None
    if status not in ok or not isinstance(j, (dict, list)):
        msg = (j or {}).get('message', '') if isinstance(j, dict) else ''
        # only GitHub's short error message is shown — never headers or the request body
        if status == 422 and 'fast forward' in msg.lower(): raise GhError(f'branch moved while pushing ({msg}); pull and retry', 3)
        if status in (401, 403): raise GhError(f'{method} {path}: HTTP {status} – token missing permission or invalid ({msg[:120]})')
        raise GhError(f'{method} {path}: HTTP {status} {msg[:160]}')
    return j


def need(j, *keys):
    for k in keys:
        if not isinstance(j, dict) or k not in j: raise GhError('unexpected API response (missing %s)' % '.'.join(keys))
        j = j[k]
    return j


def main(argv):
    br, base_br, args = 'main', None, []
    it = iter(argv)
    for a in it:
        if a == '--branch': br = next(it, None)
        elif a == '--create-from': base_br = next(it, None)
        else: args.append(a)
    if not br or len(args) < 2 or any(':' not in a for a in args[1:]): raise GhError(__doc__.split('\n\n')[1], 2)
    msg, pairs = args[0], [a.split(':', 1) for a in args[1:]]
    for src, dst in pairs:
        if dst.endswith('.admin_key') or os.path.basename(src) == '.admin_key': raise GhError('refusing to push admin key', 2)
        if not os.path.isfile(src): raise GhError(f'no such file: {src}', 2)
    tok = token()
    try: head = need(gh(tok, 'GET', f'/git/ref/heads/{br}'), 'object', 'sha')
    except GhError as e:
        if not base_br or 'HTTP 404' not in str(e): raise
        head = need(gh(tok, 'GET', f'/git/ref/heads/{base_br}'), 'object', 'sha')
        gh(tok, 'POST', '/git/refs', {'ref': f'refs/heads/{br}', 'sha': head}); print('created branch', br)
    base_tree = need(gh(tok, 'GET', f'/git/commits/{head}'), 'tree', 'sha')
    tr = gh(tok, 'GET', f'/git/trees/{base_tree}?recursive=1')
    if tr.get('truncated'): raise GhError('tree listing truncated; cannot compare safely')
    remote = {t['path']: t['sha'] for t in need(tr, 'tree') if t.get('type') == 'blob'}
    tree = []
    for src, dst in pairs:
        data = open(src, 'rb').read()
        local = hashlib.sha1(b'blob %d\0' % len(data) + data).hexdigest()
        if remote.get(dst) == local: continue
        b = need(gh(tok, 'POST', '/git/blobs', {'content': base64.b64encode(data).decode(), 'encoding': 'base64'}), 'sha')
        tree.append({'path': dst, 'mode': '100755' if dst.endswith('.sh') else '100644', 'type': 'blob', 'sha': b}); print('changed', dst)
    if not tree: print('no changes, nothing committed'); return 0
    t = need(gh(tok, 'POST', '/git/trees', {'base_tree': base_tree, 'tree': tree}), 'sha')
    c = need(gh(tok, 'POST', '/git/commits', {'message': msg, 'tree': t, 'parents': [head]}), 'sha')
    r = gh(tok, 'PATCH', f'/git/refs/heads/{br}', {'sha': c, 'force': False})
    if need(r, 'object', 'sha') != c: raise GhError('branch update not confirmed by GitHub')
    print('commit', c, 'on', br, 'ok')
    return 0


if __name__ == '__main__':
    try: sys.exit(main(sys.argv[1:]))
    except GhError as e:
        print('error:', e, file=sys.stderr); sys.exit(e.code)
