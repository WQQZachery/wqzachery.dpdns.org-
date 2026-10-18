#!/usr/bin/env python3
"""Tests for tools/push_github.py against a local mock GitHub API (no network, no real token).
  python3 tools/push_github_test.py
Covers: missing token, explicit Authorization header, token never printed, 401/403, API 500 mid-way, network error,
SHA conflict (422 not a fast forward), malformed JSON, happy path, no-op, admin key refusal, branch creation."""
import os, sys, json, subprocess, threading, tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, 'tools', 'push_github.py')
TOKEN = 'test-token-DO-NOT-PRINT-123'
MODE = {'v': 'ok'}; SEEN = []


class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def reply(self, code, obj, raw=None):
        b = raw if raw is not None else json.dumps(obj).encode()
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)

    def handle_any(self):
        n = int(self.headers.get('Content-Length') or 0); body = json.loads(self.rfile.read(n) or b'null') if n else None
        SEEN.append((self.command, self.path, self.headers.get('Authorization')))
        m, p = MODE['v'], self.path.split('/repos/', 1)[-1]
        if self.headers.get('Authorization') != 'Bearer ' + TOKEN: return self.reply(401, {'message': 'Bad credentials'})
        if m == 'forbidden': return self.reply(403, {'message': 'Resource not accessible by personal access token'})
        if m == 'garbage' and self.command == 'GET': return self.reply(200, None, raw=b'<html>oops')
        if self.command == 'GET' and '/git/ref/heads/' in p:
            if m == 'nobranch' and p.endswith('/heads/fix-x'): return self.reply(404, {'message': 'Not Found'})
            return self.reply(200, {'object': {'sha': 'c0ffee'}})
        if self.command == 'POST' and p.endswith('/git/refs'): return self.reply(201, {'ref': body['ref'], 'object': {'sha': body['sha']}})
        if self.command == 'GET' and '/git/commits/' in p: return self.reply(200, {'tree': {'sha': 'tree0'}})
        if self.command == 'GET' and '/git/trees/' in p: return self.reply(200, {'tree': [{'path': 'same.txt', 'type': 'blob', 'sha': SAME_SHA}], 'truncated': False})
        if self.command == 'POST' and p.endswith('/git/blobs'):
            if m == 'err500': return self.reply(500, {'message': 'Server Error'})
            return self.reply(201, {'sha': 'blob1'})
        if self.command == 'POST' and p.endswith('/git/trees'): return self.reply(201, {'sha': 'tree1'})
        if self.command == 'POST' and p.endswith('/git/commits'): return self.reply(201, {'sha': 'commit1'})
        if self.command == 'PATCH':
            if m == 'conflict': return self.reply(422, {'message': 'Update is not a fast forward'})
            return self.reply(200, {'object': {'sha': body['sha']}})
        return self.reply(404, {'message': 'Not Found'})
    do_GET = do_POST = do_PATCH = handle_any


import hashlib
SAME = b'unchanged\n'; SAME_SHA = hashlib.sha1(b'blob %d\0' % len(SAME) + SAME).hexdigest()
srv = ThreadingHTTPServer(('127.0.0.1', 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f'http://127.0.0.1:{srv.server_port}'
tmp = tempfile.mkdtemp(); NEW = os.path.join(tmp, 'new.txt'); SAMEF = os.path.join(tmp, 'same.txt'); KEY = os.path.join(tmp, '.admin_key')
open(NEW, 'w').write('new content\n'); open(SAMEF, 'wb').write(SAME); open(KEY, 'w').write('x')

ok = bad = 0
def t(name, cond, info=''):
    global ok, bad
    if cond: ok += 1; print('PASS', name)
    else: bad += 1; print('FAIL', name, info)

def run(mode, args, token=TOKEN, api=BASE):
    MODE['v'] = mode; SEEN.clear()
    env = {k: v for k, v in os.environ.items() if k not in ('GITHUB_TOKEN', 'GH_TOKEN')}
    env['GITHUB_API'] = api; env['NO_PROXY'] = env['no_proxy'] = '127.0.0.1,localhost'
    if token: env['GITHUB_TOKEN'] = token
    r = subprocess.run([sys.executable, SCRIPT, *args], capture_output=True, text=True, env=env, timeout=60)
    return r.returncode, r.stdout + r.stderr

files = ['msg', f'{NEW}:site/new.txt', f'{SAMEF}:same.txt']
c, out = run('ok', files, token=None); t('missing token → exit 2, no request sent', c == 2 and 'GITHUB_TOKEN' in out and not SEEN, (c, out))
c, out = run('ok', files); t('happy path → exit 0 + commit line', c == 0 and 'commit commit1 on main ok' in out, (c, out))
t('every request carries explicit Bearer token', SEEN and all(a == 'Bearer ' + TOKEN for _, _, a in SEEN), SEEN)
t('token never printed', TOKEN not in out)
t('unchanged file skipped', 'changed same.txt' not in out and 'changed site/new.txt' in out, out)
c, out = run('ok', ['msg', f'{SAMEF}:same.txt']); t('nothing changed → exit 0, no commit', c == 0 and 'nothing committed' in out and not any(m == 'PATCH' for m, _, _ in SEEN), (c, out))
c, out = run('ok', files, token='wrong-token'); t('401 bad token → exit 1, no success', c == 1 and 'HTTP 401' in out and ' ok' not in out and 'wrong-token' not in out, (c, out))
c, out = run('forbidden', files); t('403 no permission → exit 1', c == 1 and 'HTTP 403' in out and 'permission' in out, (c, out))
c, out = run('err500', files); t('API 500 mid-way → exit 1, branch not touched', c == 1 and 'HTTP 500' in out and not any(m == 'PATCH' for m, _, _ in SEEN) and 'commit' not in out.split('error:')[0], (c, out))
c, out = run('conflict', files); t('SHA conflict (not fast forward) → exit 3', c == 3 and 'branch moved' in out and ' ok' not in out, (c, out))
c, out = run('garbage', files); t('malformed JSON → exit 1', c == 1 and 'error:' in out, (c, out))
c, out = run('ok', files, api='http://127.0.0.1:9'); t('network error → exit 1', c == 1 and 'network error' in out, (c, out))
c, out = run('ok', ['msg', f'{KEY}:worker/.admin_key']); t('refuses to push admin key (exit 2, no request)', c == 2 and 'admin key' in out and not SEEN, (c, out))
c, out = run('nobranch', ['--branch', 'fix-x', '--create-from', 'main', *files]); t('creates missing branch from base, commits there', c == 0 and 'created branch fix-x' in out and 'on fix-x ok' in out, (c, out))
c, out = run('nobranch', ['--branch', 'fix-x', *files]); t('missing branch without --create-from → exit 1', c == 1 and 'HTTP 404' in out, (c, out))
c, out = run('ok', ['msg']); t('usage error → exit 2', c == 2, (c, out))
srv.shutdown()
print(f'{ok} passed, {bad} failed'); sys.exit(1 if bad else 0)
