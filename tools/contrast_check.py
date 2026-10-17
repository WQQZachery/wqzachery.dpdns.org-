#!/usr/bin/env python3
"""WCAG contrast of real rendered text: for every visible element with its own text (and every input placeholder) on each page,
take the computed colour (× opacity of the element and its ancestors) and the effective background (alpha-blend every ancestor
background-color down to the page's #000; glass = its rgba tint over black), compute the ratio and compare with 4.5:1
(normal) / 3:1 (large: >=24 px, or >=18.66 px bold). Text drawn with background-clip:text / transparent colour is skipped.
States checked as rendered on load (home also after scrolling the statement fully lit is NOT required: unlit = --dim is checked).
  python3 tools/contrast_check.py [base] [--all]   (--all also lists passes)"""
import asyncio, sys, json
from playwright.async_api import async_playwright
BASE = next((a for a in sys.argv[1:] if a.startswith('http')), 'http://127.0.0.1:8767')
ALL = '--all' in sys.argv
PAGES = ['/p/home', '/p/drive', '/p/ai', '/p/chat', '/privacy', '/admin']
JS = r"""()=>{
const P=s=>{const m=s.match(/rgba?\(([^)]+)\)/);if(!m)return null;const a=m[1].split(/[ ,\/]+/).filter(Boolean).map(Number);return[a[0],a[1],a[2],a.length>3?a[3]:1]};
const blend=(top,bot)=>{const a=top[3];return[top[0]*a+bot[0]*(1-a),top[1]*a+bot[1]*(1-a),top[2]*a+bot[2]*(1-a),1]};
const L=c=>{const f=v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)};return .2126*f(c[0])+.7152*f(c[1])+.0722*f(c[2])};
const ratio=(a,b)=>{const x=L(a),y=L(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)};
function bgOf(el){const stack=[];let op=1,grad=null;for(let n=el;n&&n.nodeType===1;n=n.parentElement){const cs=getComputedStyle(n);const c=P(cs.backgroundColor);if(c&&c[3]>0)stack.push(c);
   if(!grad&&!stack.length&&/gradient/.test(cs.backgroundImage)&&!/radial/.test(cs.backgroundImage)&&n.getBoundingClientRect().width<=el.getBoundingClientRect().width+40){grad=(cs.backgroundImage.match(/rgba?\([^)]+\)/g)||[]).map(P)}op*=+cs.opacity}
  let b=[0,0,0,1];for(let i=stack.length-1;i>=0;i--)b=blend(stack[i],b);return{b,op,grad:grad&&grad.length?grad.map(g=>blend(g,b)):null}}
const out=[];const seen=new Set();
function vis(el){const r=el.getBoundingClientRect();if(r.width<1||r.height<1)return false;const cs=getComputedStyle(el);if(cs.visibility==='hidden'||cs.display==='none')return false;
  for(let n=el;n;n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||+s.opacity===0)return false;if(n.hidden)return false;if(s.clipPath==='inset(50%)'||(s.position==='absolute'&&s.clip==='rect(0px, 0px, 0px, 0px)'))return false}return true}
function rec(el,text,cs,kind){const fg=P(kind==='placeholder'?getComputedStyle(el,'::placeholder').color:cs.color);if(!fg||fg[3]===0)return;
  if(cs.webkitBackgroundClip==='text'||cs.backgroundClip==='text')return;
  const {b:b0,op,grad}=bgOf(el);let b=b0;if(grad){let w=1e9;for(const g of grad){const rr=ratio(blend([fg[0],fg[1],fg[2],fg[3]],g),g);if(rr<w){w=rr;b=g}}}
  const f=blend([fg[0],fg[1],fg[2],fg[3]*(kind==='placeholder'?1:op)],b);
  const px=parseFloat(cs.fontSize),bold=+cs.fontWeight>=700,large=px>=24||(px>=18.66&&bold);
  const r=ratio(f,b),need=large?3:4.5;const key=[kind,cs.color,b.map(Math.round).join(','),large,el.tagName,(el.className||'').toString().slice(0,30)].join('|');
  if(seen.has(key))return;seen.add(key);
  out.push({kind,sel:el.tagName.toLowerCase()+(el.id?'#'+el.id:'')+(el.className&&typeof el.className==='string'?'.'+el.className.trim().split(/\s+/).slice(0,2).join('.'):''),
    text:text.slice(0,28),fg:(kind==='placeholder'?getComputedStyle(el,'::placeholder').color:cs.color)+(op<1&&kind!=='placeholder'?' ×op '+op.toFixed(2):'')+(grad?' (gradient bg)':''),bg:'rgb('+b.slice(0,3).map(Math.round).join(',')+')',px,large,ratio:Math.round(r*100)/100,need,ok:r>=need,ah:!!el.closest('[aria-hidden=true]')})}
for(const el of document.body.querySelectorAll('*')){if(['SCRIPT','STYLE','SVG','PATH','NOSCRIPT','TEMPLATE'].includes(el.tagName.toUpperCase()))continue;
  if((el.tagName==='INPUT'||el.tagName==='TEXTAREA')&&el.placeholder&&vis(el))rec(el,el.placeholder,getComputedStyle(el),'placeholder');
  const own=[...el.childNodes].filter(n=>n.nodeType===3&&n.textContent.trim()).map(n=>n.textContent.trim()).join(' ');
  if(!own||!vis(el))continue;rec(el,own,getComputedStyle(el),'text')}
return out}"""
async def main():
    fails = 0
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path='/usr/bin/chromium')
        ctx = await b.new_context(viewport={'width': 1280, 'height': 900}, reduced_motion='reduce')
        await ctx.add_init_script("try{localStorage.getItem('wqzAnnSeen')||localStorage.setItem('wqzAnnSeen','*')}catch(e){}")   # no update popup during tests (tools/ann_test.py covers it)
        await ctx.add_init_script("try{localStorage.setItem('wqzBootSeen',String(Date.now()))}catch(e){}")
        p = await ctx.new_page()
        for path in PAGES:
            await p.goto(BASE + path); await p.wait_for_timeout(1800)
            rows = []
            for y in range(0, 6):   # scroll through long pages so reveal-on-scroll text is measured too
                rows += await p.evaluate(JS); await p.evaluate('scrollBy(0,innerHeight*.9)'); await p.wait_for_timeout(250)
            uniq = {}
            for r in rows: uniq.setdefault((r['kind'], r['sel'], r['fg'], r['bg']), r)
            bad = [r for r in uniq.values() if not r['ok']]; fails += len(bad)
            print(f'== {path}: {len(uniq)} text styles, {len(bad)} below threshold')
            for r in sorted(uniq.values(), key=lambda r: r['ratio']):
                if not r['ok'] or ALL:
                    print(('  FAIL ' if not r['ok'] else '  ok   ') + f"{r['ratio']:>5}:1 need {r['need']} {r['kind']:<11} {r['sel'][:40]:<40} fg {r['fg']} bg {r['bg']} {r['px']}px{' large' if r['large'] else ''}{' aria-hidden' if r['ah'] else ''} «{r['text']}»")
        await b.close()
    fails += static_pairs()
    print('TOTAL below threshold:', fails); sys.exit(1 if fails else 0)
def static_pairs():
    """colours only drawn with live data (chat bubbles need a socket; avatar colour comes from a hash of the user id)"""
    import colorsys, re as _re
    def L(c):
        f = lambda v: (v / 255) / 12.92 if v / 255 <= .03928 else ((v / 255 + .055) / 1.055) ** 2.4
        return .2126 * f(c[0]) + .7152 * f(c[1]) + .0722 * f(c[2])
    def r(a, b): x, y = L(a), L(b); return (max(x, y) + .05) / (min(x, y) + .05)
    hx = lambda s: tuple(int(s[i:i + 2], 16) for i in (1, 3, 5))
    hsl = lambda h, S, l: tuple(round(x * 255) for x in colorsys.hls_to_rgb(h / 360, l, S))
    src = open(__file__.rsplit('/', 2)[0] + '/site/chat.html', encoding='utf-8').read()
    g = _re.search(r'\.row\.mine \.bub\{background:linear-gradient\(135deg,(#[0-9a-f]{6}),(#[0-9a-f]{6})\)', src).groups()
    a = _re.search(r'hsl\(\$\{hue\(id\)\} (\d+)% (\d+)%\),hsl\(\$\{\(hue\(id\)\+40\)%360\} (\d+)% (\d+)%\)', src).groups()
    at = _re.search(r'\.row\.mine \.bub \.at\{color:(#[0-9a-f]{6})', src).group(1)
    W = (255, 255, 255); bad = 0
    rows = [('chat: own bubble text #fff on ' + g[0], min(r(W, hx(g[0])), r(W, hx(g[1])))),
            ('chat: @mention ' + at + ' on own bubble', min(r(hx(at), hx(g[0])), r(hx(at), hx(g[1])))),
            ('chat: avatar initial #fff, worst of 360 hues', min(min(r(W, hsl(h, int(a[0]) / 100, int(a[1]) / 100)), r(W, hsl((h + 40) % 360, int(a[2]) / 100, int(a[3]) / 100))) for h in range(360)))]
    print('== static pairs (live-data colours)')
    for n, v in rows:
        ok = v >= 4.5; bad += not ok; print(('  ok   ' if ok else '  FAIL ') + f'{v:5.2f}:1 need 4.5 {n}')
    return bad
asyncio.run(main())
