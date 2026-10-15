# local test server: pages from site/, everything under /api proxied to the live worker. Run: python3 tools/lproxy.py (port 8766)
import http.server, urllib.request, os
SITE=os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','site')
import os
UP=os.environ.get('UP','https://wqzachery.15112479050.workers.dev')
MAP={'/':'app.html','/drive':'app.html','/ai':'app.html','/p/home':'index.html','/p/drive':'drive.html','/p/ai':'ai.html','/admin':'admin.html'}
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def _proxy(self):
        n=int(self.headers.get('content-length') or 0); body=self.rfile.read(n) if n else None
        hd={k:v for k,v in self.headers.items() if k.lower() in ('content-type','x-admin-key','range','x-target','user-agent')}
        req=urllib.request.Request(UP+self.path,data=body,headers=hd,method=self.command)
        try: r=urllib.request.urlopen(req,timeout=60); code=r.status
        except urllib.error.HTTPError as e: r=e; code=e.code
        data=r.read(); self.send_response(code)
        for k,v in r.headers.items():
            if k.lower() in ('content-type','content-range','accept-ranges','content-disposition'): self.send_header(k,v)
        self.send_header('content-length',str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        p=self.path.split('?')[0]
        if p.startswith('/api/'): return self._proxy()
        f=MAP.get(p.rstrip('/') or '/')
        if not f: self.send_response(404); self.end_headers(); return
        b=open(os.path.join(SITE,f),'rb').read(); self.send_response(200); self.send_header('content-type','text/html; charset=utf-8'); self.send_header('content-length',str(len(b))); self.end_headers(); self.wfile.write(b)
    do_POST=do_PUT=do_DELETE=do_HEAD=lambda self: self._proxy()
http.server.ThreadingHTTPServer(('127.0.0.1',8766),H).serve_forever()
