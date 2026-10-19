"""Dense doodle patterns (v6): the same drawings and themes as v5, packed tightly like Telegram's.
What changed against v5:
  - five size tiers (hero → big → medium → small → tiny fillers) instead of two near-equal ones;
  - collisions by a toroidal occupancy grid of each drawing's real (rotated) bounding box, not by circles;
  - gaps of ~8–12 px, and the leftover space filled with rings, dots and spirals.
python gen_v6.py -> out/v6/raw/*.svg, then: python optimize.py out/v6/raw out/v6
"""
import math, os, random, re
from collections import Counter
from svgelements import SVG
from gen_v5 import T, GENERIC  # themes (also fills ICONS / SMALL with the v5 drawings)
from gen_v4 import ICONS, SMALL, TINY, P, C, render, SMALL_BOX, BIG_BOX

W = H = 1200
CELL = 4                       # occupancy grid resolution, px
GW, GH = W // CELL, H // CELL

# extra fillers: Telegram-like spirals, rings and dots (own shapes)
def spiral(cx, cy, r, turns=1.6, steps=28):
    pts = []
    for i in range(steps + 1):
        t = i / steps; a = t * turns * 2 * math.pi; rr = r * (0.18 + 0.82 * t)
        pts.append(f"{cx + rr * math.cos(a):.1f} {cy + rr * math.sin(a):.1f}")
    return P("M" + " L".join(pts))
TINY.update({
    "t_spiral": [spiral(24, 24, 16)],
    "t_ring2": [C(24, 24, 7)],
    "t_dot": [C(24, 24, 4.5, fill=True)],
})

_bbox_cache = {}
def bbox(lib_name, parts, box):
    """Bounding box of a drawing in its own box coordinates (svgelements does the geometry)."""
    if lib_name in _bbox_cache: return _bbox_cache[lib_name]
    body = "".join(re.sub(r' data-k="[^"]*"', "", p[2:] if p.startswith("F:") else p) for p in parts)
    svg = SVG.parse(__import__("io").StringIO(f'<svg xmlns="http://www.w3.org/2000/svg" width="{box}" height="{box}">{body}</svg>'), reify=True)
    xs, ys = [], []
    for e in svg.elements():
        try: b = e.bbox()
        except Exception: b = None
        if b and all(map(math.isfinite, b)): xs += [b[0], b[2]]; ys += [b[1], b[3]]
    r = (min(xs), min(ys), max(xs), max(ys)) if xs else (0, 0, box, box)
    _bbox_cache[lib_name] = r
    return r

def generate_dense(big_names, small_names, seed=1, sw=1.8, same_gap=430, rot_max=20):
    rnd = random.Random(seed)
    grid = bytearray(GW * GH)
    items, placed = [], []

    def footprint(name, parts, box, x, y, size, rot, gap):
        """Grid cells covered by the rotated bbox (inflated by gap), with toroidal wrap."""
        x0, y0, x1, y1 = bbox(name, parts, box)
        s = size / box; c = box / 2
        hw = (x1 - x0) * s / 2 + gap; hh = (y1 - y0) * s / 2 + gap
        ox = ((x0 + x1) / 2 - c) * s; oy = ((y0 + y1) / 2 - c) * s
        a = math.radians(rot); ca, sa = math.cos(a), math.sin(a)
        cx = x + ox * ca - oy * sa; cy = y + ox * sa + oy * ca
        ext = abs(hw * ca) + abs(hh * sa), abs(hw * sa) + abs(hh * ca)
        cells = []
        for gy in range(int((cy - ext[1]) // CELL), int((cy + ext[1]) // CELL) + 1):
            for gx in range(int((cx - ext[0]) // CELL), int((cx + ext[0]) // CELL) + 1):
                px, py = gx * CELL + CELL / 2 - cx, gy * CELL + CELL / 2 - cy
                u = px * ca + py * sa; v = -px * sa + py * ca
                if abs(u) <= hw and abs(v) <= hh: cells.append((gy % GH) * GW + (gx % GW))
        return cells

    def same_too_close(name, x, y, same_gap):
        for px, py, pn in placed:
            if pn != name: continue
            dx = abs(x - px); dx = min(dx, W - dx); dy = abs(y - py); dy = min(dy, H - dy)
            if math.hypot(dx, dy) < same_gap: return True
        return False

    def tier(names, lib, box, size_rng, gap, fail_max, limit=None, spread=True, same_gap=same_gap):
        bag, fails, n = [], 0, 0
        while fails < fail_max and (limit is None or n < limit):
            if not bag: bag = names[:]; rnd.shuffle(bag)
            nm = bag[-1]; parts = lib[nm]
            size = rnd.uniform(*size_rng); rot = rnd.uniform(-rot_max, rot_max)
            x, y = rnd.uniform(0, W), rnd.uniform(0, H)
            if spread and same_too_close(nm, x, y, same_gap): fails += 1; continue
            cells = footprint(nm, parts, box, x, y, size, rot, gap)
            if any(grid[i] for i in cells):
                fails += 1
                if fails % 150 == 0: rnd.shuffle(bag)
                continue
            # occupy the drawing itself (without the gap) so neighbours may come up to the gap of the next one
            for i in footprint(nm, parts, box, x, y, size, rot, gap * 0.5): grid[i] = 1
            items.append((parts, box, x, y, size, rot)); placed.append((x, y, nm)); bag.pop(); fails = 0; n += 1

    tier(big_names, ICONS, BIG_BOX, (205, 245), 8, 900, limit=7)           # heroes, a handful per tile
    tier(big_names, ICONS, BIG_BOX, (140, 180), 7, 2500)                   # big
    tier(big_names, ICONS, BIG_BOX, (100, 128), 6, 3000)                   # medium
    tier(big_names, ICONS, BIG_BOX, (62, 85), 6, 3500, same_gap=260)       # the same drawings, smaller, in the gaps (like Telegram)
    tier(small_names, SMALL, SMALL_BOX, (44, 60), 6, 3500, spread=False)   # small secondary drawings
    # last: sparse fillers — a wide gap keeps them from clustering into confetti
    tier(["t_spark", "t_star", "t_ring", "t_ring2", "t_spiral", "t_dot"], TINY, SMALL_BOX, (14, 22), 13, 2500, spread=False)

    body = []
    for parts, box, x, y, size, rot in items:
        reach = size * 0.8
        for dx in (-W, 0, W):
            for dy in (-H, 0, H):
                nx, ny = x + dx, y + dy
                if -reach < nx < W + reach and -reach < ny < H + reach:
                    body.append(render(parts, box, nx, ny, size, rot, sw))
    cover = sum(grid) / len(grid)
    c = Counter(n for _, _, n in placed if n in ICONS)
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">'
           f'<g fill="none" stroke="#000" stroke-linecap="round" stroke-linejoin="round">' + "".join(body) + "</g></svg>")
    return svg, len(items), sum(c.values()), len(c), cover

if __name__ == "__main__":
    import sys
    only = set(sys.argv[1:])
    os.makedirs("out/v6/raw", exist_ok=True)
    for i, (name, (big, small)) in enumerate(T.items()):
        if only and name not in only: continue
        rnd = random.Random(i); extra = [k for k in GENERIC if k not in big]; rnd.shuffle(extra)
        big = big + extra[:max(0, 26 - len(big))]
        svg, total, drawings, uniq, cover = generate_dense(big, small, seed=2000 + i * 31)
        open(f"out/v6/raw/{name}.svg", "w").write(svg)
        print(f"{name:16} items={total} drawings={drawings} unique={uniq} covered={cover:.0%} raw={len(svg)//1024}KB")
