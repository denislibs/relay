"""Optimize raw doodle SVGs the Telegram way.
1) bake every transform into coordinates, shapes -> paths
2) merge the whole pattern into 3 <path>s: outlines, fills, dashes (all with the same stroke width)
3) round to 1 decimal, run svgo (relative coords, shortest commands)
4) gzip -> .tgv-like file (Telegram's TGV is a gzipped SVG subset)
python optimize.py out/v5/raw out/v5
"""
import sys, os, re, gzip, glob, subprocess
from svgelements import SVG, Shape, Path

NUM = re.compile(r"-?\d+\.\d+")
def rnd(d, p=1):
    return NUM.sub(lambda m: (f"{float(m.group()):.{p}f}".rstrip("0").rstrip(".") or "0"), d)

def optimize(src, dst_dir, stroke=2.6, precision=1):
    svg = SVG.parse(src, reify=True)
    W, H = int(svg.width), int(svg.height)
    strokes, fills, dashes = [], [], []
    for e in svg.elements():
        if not isinstance(e, Shape): continue
        p = Path(e); p.reify()
        d = rnd(p.d(), precision)
        if not d: continue
        filled = e.fill is not None and e.fill.value is not None and str(e.fill) not in ("none",) and e.stroke is None or \
                 (e.fill is not None and e.fill.value is not None and (e.stroke is None or e.stroke.value is None))
        if filled: fills.append(d)
        elif e.values.get("stroke-dasharray"): dashes.append(d)
        else: strokes.append(d)
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">',
           f'<path fill="none" stroke="#000" stroke-width="{stroke}" stroke-linecap="round" stroke-linejoin="round" d="{"".join(strokes)}"/>']
    if dashes:
        out.append(f'<path fill="none" stroke="#000" stroke-width="{stroke}" stroke-linecap="round" stroke-dasharray="4 7" d="{"".join(dashes)}"/>')
    if fills:
        out.append(f'<path d="{"".join(fills)}"/>')
    out.append("</svg>")
    name = os.path.splitext(os.path.basename(src))[0]
    flat = os.path.join(dst_dir, name + ".svg")
    open(flat, "w").write("".join(out))
    subprocess.run(["svgo", "-q", "--config", os.path.join(os.path.dirname(os.path.abspath(__file__)), "svgo.config.js"), flat, "-o", flat], check=True)
    data = open(flat, "rb").read()
    with gzip.open(os.path.join(dst_dir, name + ".tgv"), "wb", compresslevel=9) as f: f.write(data)
    return os.path.getsize(src), len(data), os.path.getsize(os.path.join(dst_dir, name + ".tgv")), len(strokes) + len(fills) + len(dashes)

if __name__ == "__main__":
    # python optimize.py SRC DST [name=stroke ...] — своя толщина линий для отдельных узоров (тату — жирнее)
    src_dir, dst_dir = sys.argv[1], sys.argv[2]
    strokes = dict((k, float(v)) for k, v in (a.split("=") for a in sys.argv[3:]))
    os.makedirs(dst_dir, exist_ok=True)
    for f in sorted(glob.glob(os.path.join(src_dir, "*.svg"))):
        name = os.path.splitext(os.path.basename(f))[0]
        raw, opt, gz, n = optimize(f, dst_dir, **({"stroke": strokes[name]} if name in strokes else {}))
        print(f"{os.path.basename(f):22} raw {raw/1024:6.1f}KB -> svg {opt/1024:5.1f}KB -> tgv(gzip) {gz/1024:5.1f}KB  ({n} shapes -> 3 paths)")
