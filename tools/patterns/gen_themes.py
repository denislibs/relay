"""Themed doodle sets from themes.py, packed densely by gen_v6.
python gen_themes.py [id ...]      -> out/themes/raw/<id>.svg
python gen_themes.py --sheet [id]  -> out/themes/sheet_<id>.svg (every drawing of a theme on a grid, for review)
then: python optimize.py out/themes/raw out/themes $(python gen_themes.py --strokes)
"""
import os, sys
import themes
from themes import THEMES
from gen_v4 import ICONS, SMALL, render, BIG_BOX, SMALL_BOX
from gen_v6 import generate_dense

def sheet(theme_id, cell=150, cols=5):
    big, small, sw = THEMES[theme_id]
    names = [(n, ICONS[n], BIG_BOX) for n in big] + [(n, SMALL[n], SMALL_BOX) for n in small if n in SMALL]
    rows = (len(names) + cols - 1) // cols
    body = []
    for i, (n, parts, box) in enumerate(names):
        x, y = (i % cols) * cell + cell / 2, (i // cols) * cell + cell / 2 - 6
        body.append(render(parts, box, x, y, cell * 0.78 if box == BIG_BOX else cell * 0.4, 0, sw * 0.7))
        body.append(f'<text x="{x}" y="{(i // cols + 1) * cell - 4}" font-size="10" text-anchor="middle" fill="#666" stroke="none" font-family="sans-serif">{n}</text>')
    W, H = cols * cell, rows * cell
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}"><rect width="100%" height="100%" fill="#fff"/>'
            f'<g fill="none" stroke="#222" stroke-linecap="round" stroke-linejoin="round">' + "".join(body) + "</g></svg>")

if __name__ == "__main__":
    args = sys.argv[1:]
    if args[:1] == ["--strokes"]:
        print(" ".join(f"{k}={v[2]}" for k, v in THEMES.items())); sys.exit()
    os.makedirs("out/themes/raw", exist_ok=True)
    if args[:1] == ["--sheet"]:
        for t in (args[1:] or list(THEMES)):
            open(f"out/themes/sheet_{t}.svg", "w").write(sheet(t)); print("sheet", t)
        sys.exit()
    for i, (tid, (big, small, sw)) in enumerate(THEMES.items()):
        if args and tid not in args: continue
        svg, total, drawings, uniq, cover = generate_dense(big, small, seed=5000 + i * 37)
        open(f"out/themes/raw/{tid}.svg", "w").write(svg)
        print(f"{tid:16} items={total} drawings={drawings} unique={uniq} covered={cover:.0%} raw={len(svg)//1024}KB")
