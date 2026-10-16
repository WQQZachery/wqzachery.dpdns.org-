import asyncio,os,json
from playwright.async_api import async_playwright
JS="""()=>{const out={};const nm=e=>(e.getAttribute('aria-label')||e.getAttribute('title')||e.innerText||e.getAttribute('alt')||'').trim();
out.unnamedButtons=[...document.querySelectorAll('button,a[href],[role=button]')].filter(e=>e.offsetParent!==null&&!nm(e)&&!e.querySelector('img[alt]:not([alt=""])')).map(e=>e.outerHTML.slice(0,90));
out.imgNoAlt=[...document.querySelectorAll('img')].filter(i=>!i.hasAttribute('alt')).length;
out.inputsNoLabel=[...document.querySelectorAll('input:not([type=hidden]),textarea,select')].filter(i=>!i.getAttribute('aria-label')&&!i.placeholder&&!(i.id&&document.querySelector('label[for="'+i.id+'"]'))&&!i.closest('label')).map(e=>e.outerHTML.slice(0,80));
out.overflowX=document.documentElement.scrollWidth-innerWidth;
out.smallTargets=[...document.querySelectorAll('button,a[href]')].filter(e=>{const r=e.getBoundingClientRect();return e.offsetParent!==null&&r.width>0&&(r.width<24||r.height<24)}).map(e=>(nm(e)||e.outerHTML).slice(0,40)).slice(0,10);
out.lang=document.documentElement.lang;return out}"""
async def m():
  async with async_playwright() as p:
    b=await p.chromium.launch(executable_path='/usr/bin/chromium')
    for w in (320,402):
      c=await b.new_context(viewport={'width':w,'height':800},reduced_motion='reduce')
      for n in ['/','/p/home','/p/drive','/p/ai','/p/chat','/privacy','/admin']:
        pg=await c.new_page(); await pg.goto('http://127.0.0.1:8766'+n); await pg.wait_for_timeout(2000)
        print(w,n,json.dumps(await pg.evaluate(JS),ensure_ascii=False))
    await b.close()
asyncio.run(m())
