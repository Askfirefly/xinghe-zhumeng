#!/usr/bin/env python3
"""assets/*.jpg → WebP(q90) → src/tex_*.b64（单文件内联管线，对齐星河追梦 pbr-inline）"""
import base64, io, os, sys
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAP = {
    '2k_mercury.jpg':         ('tex_mercury', 90),
    '2k_venus_atmosphere.jpg':('tex_venusatm', 90),
    '2k_earth_daymap.jpg':    ('tex_earthday', 92),
    '2k_earth_nightmap.jpg':  ('tex_earthnight', 90),
    '2k_earth_clouds.jpg':    ('tex_earthclouds', 88),
    '2k_mars.jpg':            ('tex_mars', 90),
    '2k_moon.jpg':            ('tex_moon', 90),
}
total_in = total_out = 0
for src, (name, q) in MAP.items():
    p = os.path.join(ROOT, 'assets', src)
    if not os.path.exists(p):
        print('MISS', src); continue
    im = Image.open(p).convert('RGB')
    buf = io.BytesIO()
    im.save(buf, 'WEBP', quality=q, method=6)
    b = buf.getvalue()
    out = os.path.join(ROOT, 'src', name + '.b64')
    with open(out, 'w') as f:
        f.write(base64.b64encode(b).decode())
    total_in += os.path.getsize(p); total_out += len(b)
    print(f'{src:28s} {os.path.getsize(p)/1024:7.0f}K -> {name}.b64 {len(b)/1024:6.0f}K (webp q{q})')
print(f'total: {total_in/1024/1024:.2f} MB -> {total_out/1024/1024:.2f} MB')