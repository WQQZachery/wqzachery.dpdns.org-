#!/usr/bin/env python3
"""Deterministic mock of the site API for browser tests (no real AI / storage calls). Port $MPORT (default 8768).
Run a second preview against it:  MPORT=8768 python3 tools/mock_api.py &  PORT=8767 UP=http://127.0.0.1:8768 python3 tools/lproxy.py &
AI (/api/chat) behaviour by the last user message: '#slow' long slow stream, '#cut' stream that breaks off (no done event),
'#failonce' HTTP 500 the first time that text is sent, '#err' SSE {error}, '#code' reply with a code block, else a short echo.
Drive: /api/files, /api/limits, /api/up/init|finish (basic mode, PUT to /s3/<n> here, 1.2 s each, CORS), /api/folders.
Files named *failonce* fail at /api/up/finish once (502); *bad* fail at init (502) every time.  GET /api/__stats → counters; POST /api/__reset."""
import http.server, json, os, threading, time, itertools
lock = threading.Lock()
ST = {}
def reset():
    ST.clear(); ST.update(chat=0, chat_by={}, put_now=0, put_max=0, puts=0, init=0, finish=0, folders_post=0, failed_once=set(),
                         files=[{'path': 'files/20261016-abc123-hello.txt', 'name': 'hello.txt', 'dir': '', 'size': 12, 'date': '2026-10-16T00:00:00Z'}],
                         folders=['照片'])
reset(); cnt = itertools.count(1)
class H(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'
    def log_message(self, *a): pass
    def cors(self):
        self.send_header('Access-Control-Allow-Origin', '*'); self.send_header('Access-Control-Allow-Methods', 'PUT,POST,GET,OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*'); self.send_header('Access-Control-Expose-Headers', 'ETag')
    def js(self, o, code=200):
        b = json.dumps(o, ensure_ascii=False).encode(); self.send_response(code); self.cors()
        self.send_header('content-type', 'application/json'); self.send_header('content-length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def body(self):
        n = int(self.headers.get('content-length') or 0); return self.rfile.read(n) if n else b''
    def do_OPTIONS(self): self.send_response(204); self.cors(); self.end_headers()
    def do_GET(self):
        p = self.path.split('?')[0]
        if p == '/api/__stats':
            with lock: return self.js({k: (list(v) if isinstance(v, set) else v) for k, v in ST.items() if k not in ('files',)})
        if p == '/api/models': return self.js({'models': [{'id': 'astra', 'cat': '推荐', 'name': 'GPT-6 Astra', 'tag': '默认', 'desc': '均衡好用，不限次数'}]})
        if p == '/api/limits': return self.js({'maxFile': 2 * 1024**3, 'dayBytes': 5 * 1024**3, 'dayFiles': 50, 'blocked': ['exe', 'sh'], 'reasons': []})
        if p == '/api/stats': return self.js({'days': 7, 'features': 4, 'files': len(ST['files'])})
        if p == '/api/files':
            with lock: return self.js({'files': ST['files'], 'folders': ST['folders'], 'used': sum(f['size'] for f in ST['files']), 'cap': '100 GB', 'admin': False})
        self.js({'error': 'not found'}, 404)
    def do_PUT(self):
        p = self.path.split('?')[0]
        if p.startswith('/s3/'):
            self.body()
            with lock: ST['put_now'] += 1; ST['puts'] += 1; ST['put_max'] = max(ST['put_max'], ST['put_now'])
            time.sleep(1.2)
            with lock: ST['put_now'] -= 1
            self.send_response(200); self.cors(); self.send_header('ETag', '"e%d"' % next(cnt)); self.send_header('content-length', '0'); self.end_headers(); return
        self.js({'error': 'nope'}, 404)
    def do_POST(self):
        p = self.path.split('?')[0]; raw = self.body()
        try: b = json.loads(raw or b'{}')
        except Exception: b = {}
        if p == '/api/__reset': reset(); return self.js({'ok': True})
        if p == '/api/up/init':
            with lock: ST['init'] += 1
            name = b.get('name', 'f')
            if 'bad' in name: return self.js({'error': '存储暂时不可用，请稍后再试'}, 502)
            d = b.get('dir') or ''; path = 'files/' + (d + '/' if d else '') + '20261017-%06d-' % next(cnt) + name
            return self.js({'mode': 'basic', 'href': 'http://127.0.0.1:%s/s3/%d' % (os.environ.get('MPORT', '8768'), next(cnt)), 'header': {}, 'path': path})
        if p == '/api/up/finish':
            with lock:
                ST['finish'] += 1; path = b.get('path', '')
                if 'failonce' in path and path not in ST['failed_once']: ST['failed_once'].add(path); return self.js({'error': '网络失败：保存失败，请重试'}, 502)
                nm = path.split('/')[-1].split('-', 2)[-1]; rel = path[6:]; d = rel.rsplit('/', 1)[0] if '/' in rel else ''
                ST['files'].insert(0, {'path': path, 'name': nm, 'dir': d, 'size': b.get('size', 0), 'date': '2026-10-17T00:00:00Z'})
            return self.js({'ok': True, 'path': path, 'name': nm, 'size': b.get('size', 0)})
        if p == '/api/folders':
            with lock:
                ST['folders_post'] += 1; d = str(b.get('path', '')).strip('/')
                if d.split('/')[-1] == 'boom': return self.js({'error': '创建失败，请稍后再试'}, 502)
                if any(c in d for c in '\\:*?"<>|#%'): return self.js({'error': '文件夹名无效', 'code': 'name'}, 400)
                if d in ST['folders']: return self.js({'error': '这里已经有同名文件夹', 'code': 'exists'}, 409)
                time.sleep(0.4); ST['folders'].append(d)
            return self.js({'ok': True, 'path': d})
        if p == '/api/chat':
            msgs = b.get('messages') or []; q = msgs[-1]['content'] if msgs else ''
            with lock:
                ST['chat'] += 1; ST['chat_by'][q] = ST['chat_by'].get(q, 0) + 1; first = ST['chat_by'][q] == 1
            if '#failonce' in q and first: return self.js({'error': '模拟：服务器出错了'}, 500)
            self.send_response(200); self.send_header('content-type', 'text/event-stream; charset=utf-8'); self.end_headers()
            def ev(o): self.wfile.write(('data: ' + json.dumps(o, ensure_ascii=False) + '\n\n').encode()); self.wfile.flush()
            try:
                if '#err' in q: ev({'error': 'AI 暂时不可用，请稍后再试'}); return
                if '#code' in q: parts = ['这是示例代码：\n', '```python\n', 'print("hi")\n', '```\n', '完毕。']
                elif '#slow' in q: parts = ['第%d段内容。' % i for i in range(40)]
                elif '#cut' in q: parts = ['这是一段', '会被中断的', '回答']
                else: parts = ['收到：', q[:40], '。']
                for x in parts:
                    ev({'t': x}); time.sleep(0.25 if '#slow' in q else 0.05)
                if '#cut' in q: return
                ev({'done': True, 'model': 'GPT-6 Astra'})
            except Exception: pass
            return
        self.js({'error': 'not found'}, 404)
http.server.ThreadingHTTPServer(('127.0.0.1', int(os.environ.get('MPORT', '8768'))), H).serve_forever()
