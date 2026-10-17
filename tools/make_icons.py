#!/usr/bin/env python3
"""Brand icon (black rounded square + green Z, same mark as the boot animation) -> site/favicon.svg, site/favicon.ico, site/apple-touch-icon.png.
The worker embeds them (run this, then tools/embed_icons.py)."""
import os, io
from PIL import Image, ImageDraw
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SVG = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='#000'/><path d='M18 20h28L18 44h28' stroke='#76b900' stroke-width='6' fill='none' stroke-linejoin='miter'/></svg>"
open(os.path.join(root, 'site/favicon.svg'), 'w').write(SVG)
def draw(n, radius=True):
    S = n * 8; im = Image.new('RGBA', (S, S), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    k = S / 64
    if radius: d.rounded_rectangle([0, 0, S - 1, S - 1], radius=14 * k, fill=(0, 0, 0, 255))
    else: d.rectangle([0, 0, S, S], fill=(0, 0, 0, 255))
    pts = [(18 * k, 20 * k), (46 * k, 20 * k), (18 * k, 44 * k), (46 * k, 44 * k)]
    d.line(pts, fill=(0x76, 0xb9, 0x00, 255), width=round(6 * k), joint='curve')
    return im.resize((n, n), Image.LANCZOS)
draw(48).save(os.path.join(root, 'site/favicon.ico'), sizes=[(16, 16), (32, 32), (48, 48)])
draw(180, radius=False).convert('RGB').save(os.path.join(root, 'site/apple-touch-icon.png'), optimize=True)   # iOS rounds the corners itself
for f in ('favicon.svg', 'favicon.ico', 'apple-touch-icon.png'): print(f, os.path.getsize(os.path.join(root, 'site', f)))
