"""Detailed Telegram-style doodle patterns (v4).
Icons are drawn in a 100x100 box. Black thin outlines on transparent background, seamless tile.
python gen_v4.py -> out/v4/*.svg
"""
import math, random, os, re
from collections import Counter

# ---------- primitives ----------
def P(d, fill=False, extra=""):
    return ("F:" if fill else "") + f'<path d="{d}"{extra}/>'
def C(cx, cy, r, fill=False):
    return ("F:" if fill else "") + f'<circle cx="{cx}" cy="{cy}" r="{r}"/>'
def E(cx, cy, rx, ry, rot=0, fill=False):
    return ("F:" if fill else "") + f'<ellipse cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}" transform="rotate({rot} {cx} {cy})"/>'
def R(x, y, w, h, rx=0):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}"/>'
def DASH(d):
    return f'<path d="{d}" stroke-dasharray="3 6"/>'

HEART = "M24 40 C10 30 4 22 8 15 C12 8 20 9 24 15 C28 9 36 8 40 15 C44 22 38 30 24 40 Z"
SPARK = "M24 5 Q26 22 43 24 Q26 26 24 43 Q22 26 5 24 Q22 22 24 5 Z"
def _place(d, cx, cy, w, src_c=(24, 24), src_w=38, rot=0, fill=False):
    s = w / src_w
    return ("F:" if fill else "") + (f'<path transform="translate({cx} {cy}) rotate({rot}) scale({s:.3f}) '
                                     f'translate({-src_c[0]} {-src_c[1]})" data-k="{s:.3f}" d="{d}"/>')
def heart(cx, cy, w, fill=False, rot=0): return _place(HEART, cx, cy, w, (24, 25), 36, rot, fill)
def spark(cx, cy, w, fill=False): return _place(SPARK, cx, cy, w, (24, 24), 38, 0, fill)
def star(cx, cy, ro, ri=None, n=5, rot=-90):
    ri = ri or ro * 0.45; pts = []
    for i in range(n * 2):
        r = ro if i % 2 == 0 else ri; a = math.radians(rot) + i * math.pi / n
        pts.append(f"{cx + r*math.cos(a):.1f},{cy + r*math.sin(a):.1f}")
    return f'<polygon points="{" ".join(pts)}"/>'
def paw(cx, cy, s=1.0, rot=0):
    out = []
    def pt(x, y):
        a = math.radians(rot); x, y = x * s, y * s
        return cx + x*math.cos(a) - y*math.sin(a), cy + x*math.sin(a) + y*math.cos(a)
    x, y = pt(0, 4); out.append(E(round(x,1), round(y,1), 7*s, 6*s, rot))
    for tx, ty in [(-8, -5), (-3, -10), (3, -10), (8, -5)]:
        x, y = pt(tx, ty); out.append(C(round(x,1), round(y,1), 2.8*s))
    return out
def cat_head(cx, cy, s=1.0):
    """generic cute cat head centred at cx,cy, ~40*s wide"""
    def T(d): return f'<path transform="translate({cx} {cy}) scale({s})" data-k="{s}" d="{d}"/>'
    def TF(d): return "F:" + T(d)
    return [T("M-20 4 C-21 -6 -19 -12 -17 -20 L-8 -13 Q0 -15 8 -13 L17 -20 C19 -12 21 -6 20 4 C20 14 11 19 0 19 C-11 19 -20 14 -20 4 Z"),
            T("M-15 -14 L-10 -10 M15 -14 L10 -10"),
            TF("M-8 0 m-2.5 0 a2.5 3.2 0 1 0 5 0 a2.5 3.2 0 1 0 -5 0"), TF("M8 0 m-2.5 0 a2.5 3.2 0 1 0 5 0 a2.5 3.2 0 1 0 -5 0"),
            T("M-2 6 H2 L0 8 Z"), T("M0 8 Q-2 11 -5 10 M0 8 Q2 11 5 10"),
            T("M-11 7 L-23 5 M-11 10 L-22 12 M11 7 L23 5 M11 10 L22 12")]

# ---------- detailed icons (100x100) ----------
ICONS = {
"cat_sitting": cat_head(50, 36, 1.05) + [
    P("M36 53 C27 64 27 82 31 92 H69 C73 82 73 64 64 53"), P("M41 92 V84 M59 92 V84"), P("M45 62 L50 67 L55 62"),
    P("M69 90 C85 90 91 78 85 66 C82 61 77 63 79 68")],
"cat_astronaut": [C(50, 44, 31), P("M30 30 A23 23 0 0 1 44 20"), P("M25 68 Q50 84 75 68 L77 77 Q50 93 23 77 Z"),
    P("M33 80 V86 M67 80 V86"), C(50, 82, 3), P("M78 20 L88 8"), C(89, 7, 3)] + cat_head(50, 48, 0.75),
"letter_hearts": [R(12, 44, 62, 42, 4), P("M20 54 V20 H66 V54"), P("M28 29 H58 M28 36 H58 M28 43 H46"),
    P("M12 48 L43 68 L74 48"), P("M12 86 L36 64 M74 86 L50 64"), heart(84, 26, 14), heart(90, 46, 9, True), heart(78, 60, 7)],
"chat_pair": [P("M10 14 H54 A6 6 0 0 1 60 20 V42 A6 6 0 0 1 54 48 H26 L14 58 V48 H10 A6 6 0 0 1 4 42 V20 A6 6 0 0 1 10 14 Z"),
    C(19, 31, 3, True), C(32, 31, 3, True), C(45, 31, 3, True),
    P("M66 34 H88 A6 6 0 0 1 94 40 V64 A6 6 0 0 1 88 70 H84 V82 L72 70 H46 A6 6 0 0 1 40 64 V54"), heart(67, 54, 17, True),
    P("M74 80 L77 85 L86 74 M80 82 L82 84 L90 74")],
"phone_chat": [R(28, 8, 44, 84, 9), P("M44 14 H56"), P("M45 86 H55"), R(34, 24, 22, 10, 5), R(44, 40, 22, 10, 5), R(34, 56, 16, 10, 5),
    C(74, 14, 9), heart(74, 14.5, 10, True), P("M14 30 Q8 40 14 50 M8 26 Q0 40 8 54")],
"mailbox": [P("M18 48 A14 14 0 0 1 46 48 V74 H18 Z"), P("M32 34 H68 A14 14 0 0 1 82 48 V74 H46"), P("M30 74 V96 M38 74 V96"),
    P("M70 48 V24 H84 V32 H70"), R(22, 50, 20, 13, 1), P("M22 50 L32 57 L42 50"), heart(60, 56, 10)],
"plane_trail": [P("M48 30 L94 12 L78 58 L64 42 Z"), P("M64 42 L94 12"), P("M64 42 L62 56 L71 48"),
    DASH("M44 34 C26 40 16 30 24 22 C32 14 42 28 28 46 C18 60 10 66 4 74")],
"constellation_cat": [P("M14 66 L22 30 L40 46 L60 46 L78 30 L86 66 L50 86 Z"), P("M38 62 L44 64 M62 62 L56 64")] +
    [spark(x, y, w, True) for x, y, w in [(14, 66, 10), (22, 30, 12), (40, 46, 8), (60, 46, 8), (78, 30, 12), (86, 66, 10), (50, 86, 9)]],
"constellation_heart": [P("M50 84 L18 52 L22 26 L40 18 L50 32 L60 18 L78 26 L82 52 Z")] +
    [spark(x, y, w, True) for x, y, w in [(50, 84, 11), (18, 52, 8), (22, 26, 10), (40, 18, 8), (50, 32, 9), (60, 18, 8), (78, 26, 10), (82, 52, 8)]],
"kitten_yarn": [P("M6 88 C6 70 16 60 32 60 C46 60 54 70 54 88 Z"), P("M14 64 L16 49 L25 57 M46 64 L44 49 L37 57"),
    P("M20 72 Q23 69 26 72 M36 72 Q39 69 42 72"), P("M29 77 H33 L31 79 Z"), P("M14 88 V82 M44 88 V82"),
    C(74, 66, 18), P("M58 60 Q72 70 88 54"), P("M57 70 Q76 76 91 64"), P("M62 80 Q76 74 88 78"), P("M66 49 Q70 66 62 82"),
    P("M54 84 Q60 94 70 86")],
"coffee": [P("M20 40 H70 V58 A22 22 0 0 1 48 80 H42 A22 22 0 0 1 20 58 Z"), P("M70 46 H77 A8 8 0 0 1 77 62 H69"),
    P("M10 84 H84 Q80 93 70 93 H24 Q14 93 10 84 Z"), E(45, 40, 25, 5), heart(45, 40.5, 11),
    P("M36 30 C31 24 41 20 36 11 M52 30 C47 24 57 20 52 11")],
"cupcake": [P("M24 56 L32 92 H68 L76 56 Z"), P("M37 56 L41 92 M50 56 V92 M63 56 L59 92"),
    P("M20 56 C13 50 19 41 28 44 C26 34 38 28 46 34 C50 24 65 26 64 36 C75 34 83 46 75 52 C81 56 77 61 70 58 H27 C20 61 17 58 20 56 Z"),
    C(54, 22, 6), P("M56 16 Q60 7 67 7"), P("M33 48 L37 46 M48 44 L50 48 M60 46 L64 48 M42 52 L44 50")],
"gift": [R(16, 44, 68, 46, 3), R(10, 32, 80, 12, 3), P("M50 32 V90"), P("M50 32 C40 12 22 16 30 30 C34 34 44 33 50 32 Z"),
    P("M50 32 C60 12 78 16 70 30 C66 34 56 33 50 32 Z"), P("M44 32 L38 42 M56 32 L62 42"), spark(88, 14, 12), C(10, 18, 3)],
"balloons": [P("M30 50 C18 48 12 36 14 26 A16 16 0 0 1 46 26 C48 36 42 48 30 50 Z"),
    P("M64 42 C54 40 50 30 52 22 A13 13 0 0 1 78 22 C80 30 74 40 64 42 Z"), _place(HEART, 56, 60, 30),
    P("M28 50 L30 54 L32 50 M62 42 L64 46 L66 42"), P("M30 54 Q36 74 46 92 M64 46 Q58 70 48 92 M56 75 Q52 84 47 92"),
    P("M20 28 A10 10 0 0 1 26 18"), P("M57 20 A8 8 0 0 1 62 14")],
"sleepy_cat": [E(50, 80, 42, 12), P("M14 84 L10 92 M86 84 L90 92"), P("M18 76 C16 58 32 48 50 50 C66 52 76 58 78 68"),
    P("M60 54 L62 40 L70 48 Q75 47 79 50 L84 42 L86 56 C89 64 83 72 74 72 C66 72 60 66 60 58"),
    P("M68 60 Q71 62 74 60 M78 60 Q80 62 82 59"), P("M18 76 Q30 86 56 78"), P("M84 22 H93 L84 31 H93 M72 12 H79 L72 19 H79")],
"stamp_cat": [P("M12 12 " + " ".join(f"Q{14+i*8} 8 {16+i*8} 12" for i in range(9)) + " V88 " +
                " ".join(f"Q{86-i*8} 92 {84-i*8} 88" for i in range(9)) + " Z"),
    R(20, 20, 60, 60, 2)] + cat_head(50, 48, 0.9) + [P("M58 70 Q66 66 74 70 Q82 74 90 70 M60 78 Q68 74 76 78 Q84 82 92 78")],
"lock_heart": [R(18, 44, 52, 44, 8), P("M28 44 V30 A16 16 0 0 1 60 30 V44"), heart(44, 64, 18), P("M44 72 V80"),
    C(82, 30, 8), P("M82 38 V70 M82 54 H90 M82 62 H88")],
"shield_cat": [P("M50 14 L18 26 V50 C18 70 32 84 50 92 C68 84 82 70 82 50 V26 Z"), P("M22 26 L18 8 L34 20 M78 26 L82 8 L66 20"),
    P("M34 52 L46 64 L68 40"), P("M40 26 L50 22 L60 26")],
"incognito_cat": cat_head(50, 56, 1.1) + [P("M14 40 H86"), P("M26 40 L30 16 Q50 22 70 16 L74 40"), P("M29 33 Q50 38 71 33"),
    C(37, 56, 9), C(63, 56, 9), P("M46 55 Q50 52 54 55")],
"rocket_cat": [P("M50 4 C66 18 70 42 62 70 H38 C30 42 34 18 50 4 Z"), C(50, 34, 11), P("M43 30 L44 24 L48 28 M57 30 L56 24 L52 28"),
    C(46, 35, 1.6, True), C(54, 35, 1.6, True), P("M49 39 H51"), P("M37 58 H63"), P("M38 54 L22 74 L38 70 M62 54 L78 74 L62 70"),
    P("M42 72 Q50 98 58 72"), P("M46 72 Q50 86 54 72")],
"planet_cat": [C(50, 54, 22), E(50, 56, 42, 10, -15), P("M33 40 L33 24 L44 33 M67 40 L67 24 L56 33"),
    P("M41 54 Q44 57 47 54 M53 54 Q56 57 59 54"), P("M48 60 Q50 62 52 60"), spark(14, 18, 12), C(88, 22, 3)],
"ufo_cat": [E(50, 60, 42, 13), P("M24 54 A26 24 0 0 1 76 54"), P("M38 44 L39 34 L45 40 M62 44 L61 34 L55 40"),
    C(45, 47, 1.8, True), C(55, 47, 1.8, True), C(22, 62, 2.5, True), C(36, 66, 2.5, True), C(50, 68, 2.5, True), C(64, 66, 2.5, True),
    C(78, 62, 2.5, True), P("M34 74 L24 94 M66 74 L76 94"), DASH("M40 76 L36 96 M60 76 L64 96")],
"moon_face": [P("M58 10 A40 40 0 1 0 90 64 A32 32 0 1 1 58 10 Z"), P("M30 50 Q34 54 38 50"), P("M32 64 Q38 68 44 64"),
    C(28, 58, 2.5), P("M76 0 V22 M88 0 V40"), star(76, 26, 6), star(88, 44, 5)],
"fish": [P("M8 50 C24 26 56 26 70 50 C56 74 24 74 8 50 Z"), P("M70 50 L92 33 Q85 50 92 67 Z"), C(24, 46, 3, True),
    P("M34 37 Q41 50 34 63"), P("M45 42 Q49 46 45 50 M54 42 Q58 46 54 50 M45 52 Q49 56 45 60 M54 52 Q58 56 54 60"),
    P("M38 32 Q48 21 58 32"), C(86, 18, 3.5), C(77, 9, 2.2)],
"paw_trail": paw(22, 78, 1.0, -30) + paw(44, 54, 1.1, -30) + paw(70, 30, 1.2, -30) + [heart(88, 70, 10)],
"sticker_pack": [P("M16 22 H64 V62 L48 78 H16 Z"), P("M64 62 H52 A4 4 0 0 0 48 66 V78"), C(32, 40, 2.5, True), C(48, 40, 2.5, True),
    P("M28 50 Q40 60 52 50"), P("M70 30 H84 A4 4 0 0 1 88 34 V80 A4 4 0 0 1 84 84 H32 A4 4 0 0 1 28 80 V82"), star(76, 48, 7)],
"headphones_cat": [P("M16 58 V48 A34 34 0 0 1 84 48 V58"), P("M26 30 L22 10 L40 20 M74 30 L78 10 L60 20"),
    R(10, 52, 18, 28, 8), R(72, 52, 18, 28, 8), P("M44 66 V44 L62 40 V60"), E(40, 66, 5, 4, -20), E(58, 60, 5, 4, -20)],
"icecream": [P("M30 50 L50 96 L70 50"), P("M36 62 L54 80 M46 52 L62 68 M64 62 L46 80 M54 52 L38 68"),
    P("M26 50 C20 46 22 36 30 36 C30 26 44 22 50 30 C56 22 70 26 70 36 C78 36 80 46 74 50 Z"),
    P("M34 50 V56 A3 3 0 0 0 40 56 V50 M58 50 V58 A3 3 0 0 0 64 58 V50"), C(50, 22, 6), P("M52 16 Q56 8 62 8")],
"boba": [P("M26 34 H74 L68 92 H32 Z"), P("M22 34 H78"), P("M24 34 C24 18 76 18 76 34"), P("M56 22 L66 2"),
    C(40, 46, 2.5, True), C(60, 46, 2.5, True), P("M46 52 Q50 56 54 52"), E(36, 52, 4, 2), E(64, 52, 4, 2),
    C(40, 82, 4), C(50, 84, 4), C(60, 82, 4), C(45, 75, 4), C(55, 75, 4)],
"pigeon_post": [P("M10 40 C10 24 28 16 40 26 L56 18 L50 30 C54 44 40 54 26 52 C16 51 10 46 10 40 Z"),
    P("M22 38 Q34 28 42 40 Q32 48 22 38 Z"), C(36, 28, 2, True), P("M46 40 L58 56"), R(52, 54, 34, 24, 3), P("M52 57 L69 69 L86 57"),
    heart(69, 72, 8, True), DASH("M90 30 Q96 44 88 52")],
"sun_face": [C(50, 50, 20), C(42, 47, 2.5, True), C(58, 47, 2.5, True), P("M43 56 Q50 62 57 56"), E(36, 54, 3, 2), E(64, 54, 3, 2)] +
    [P(f"M{50+28*math.cos(a):.1f} {50+28*math.sin(a):.1f} Q{50+36*math.cos(a+0.2):.1f} {50+36*math.sin(a+0.2):.1f} "
       f"{50+42*math.cos(a):.1f} {50+42*math.sin(a):.1f}") for a in [i*math.pi/4 for i in range(8)]],
"cloud_face": [P("M22 66 H74 A14 14 0 0 0 76 38 A20 20 0 0 0 38 34 A16 16 0 0 0 22 66 Z"), C(40, 52, 2.5, True), C(58, 52, 2.5, True),
    P("M45 58 Q49 62 53 58"), heart(30, 82, 9, True), heart(52, 88, 7, True), heart(72, 80, 9, True)],
"butterfly": [P("M50 46 C40 20 14 14 12 30 C10 44 30 52 50 50 C70 52 90 44 88 30 C86 14 60 20 50 46 Z"),
    P("M50 50 C36 56 26 72 34 80 C40 86 48 70 50 56 C52 70 60 86 66 80 C74 72 64 56 50 50 Z"),
    C(28, 32, 5), C(72, 32, 5), P("M50 40 V74"), P("M50 40 Q44 26 38 22 M50 40 Q56 26 62 22")],
"ring_box": [P("M14 60 H86 V88 A4 4 0 0 1 82 92 H18 A4 4 0 0 1 14 88 Z"), P("M14 60 L22 40 H78 L86 60"), C(50, 50, 12),
    P("M42 34 L50 24 L58 34 L50 40 Z"), spark(78, 18, 12), spark(22, 22, 8)],
"cat_box": [P("M14 52 H86 V90 H14 Z"), P("M14 52 L4 40 M86 52 L96 40"), P("M50 52 V90"), P("M24 62 H40 M60 62 H76")] +
    [P("M24 52 C22 40 24 32 28 26 L28 14 L38 22 Q50 20 62 22 L72 14 L72 26 C76 32 78 40 76 52"),
     C(40, 38, 3, True), C(60, 38, 3, True), P("M48 44 H52 L50 46 Z"), P("M30 52 Q34 46 38 52 M62 52 Q66 46 70 52")],
"envelope_wings": [R(28, 38, 44, 32, 3), P("M28 41 L50 56 L72 41"), heart(50, 62, 8, True),
    P("M28 48 C14 46 6 34 8 20 C14 30 22 34 28 40"), P("M24 44 C14 44 8 40 6 34"),
    P("M72 48 C86 46 94 34 92 20 C86 30 78 34 72 40"), P("M76 44 C86 44 92 40 94 34"), DASH("M8 82 Q30 72 50 82 T92 82")],
}

SMALL = {  # secondary small drawings (still real drawings, not dust)
"s_heart": [heart(24, 25, 36)], "s_star": [star(24, 24, 18)], "s_spark": [spark(24, 24, 38)],
"s_paw": paw(24, 26, 1.7), "s_planet": [C(24, 24, 10), E(24, 25, 21, 5, -20)], "s_note": [P("M18 36 V12 L36 8 V32"), E(14, 36, 4.5, 3.5, -20), E(32, 32, 4.5, 3.5, -20)],
"s_bubble": [P("M10 10 H38 A4 4 0 0 1 42 14 V28 A4 4 0 0 1 38 32 H22 L13 39 V32 H10 A4 4 0 0 1 6 28 V14 A4 4 0 0 1 10 10 Z")],
"s_moon": [P("M29 6 A18 18 0 1 0 42 31 A14 14 0 1 1 29 6 Z")], "s_flower": [C(24, 24, 4)] + [C(round(24+10*math.cos(a), 1), round(24+10*math.sin(a), 1), 5.5) for a in [i*2*math.pi/5 for i in range(5)]],
"s_fish": [P("M5 24 C13 12 29 12 35 24 C29 36 13 36 5 24 Z"), P("M35 24 L44 16 L44 32 Z")],
"s_burst": [star(24, 24, 18, 11, n=8)], "s_env": [R(6, 12, 36, 24, 3), P("M6 15 L24 27 L42 15")],
}
TINY = {"t_spark": [spark(24, 24, 38)], "t_star": [star(24, 24, 18)], "t_ring": [C(24, 24, 9)]}
SMALL_BOX, BIG_BOX = 48, 100


def render(parts, box, x, y, size, rot, sw):
    s = size / box; c = box / 2
    out = [f'<g transform="translate({x:.1f} {y:.1f}) rotate({rot:.0f}) scale({s:.3f}) translate({-c} {-c})" stroke-width="{sw/s:.2f}">']
    for p in parts:
        if p.startswith("F:"):
            p = re.sub(r' data-k="[^"]*"', '', p[2:]).replace("/>", ' fill="#000" stroke="none"/>', 1)
        else:
            m = re.search(r' data-k="([^"]*)"', p)
            if m: p = p.replace(m.group(0), f' stroke-width="{sw/(s*float(m.group(1))):.2f}"')
        out.append(p)
    return "".join(out) + "</g>"


def generate(big_names, small_names, W=1200, H=1200, seed=1, sw=1.8, tiers=((118, 145), (86, 106)), small_rng=(36, 48),
             tiny_count=40, same_gap=380):
    rnd = random.Random(seed); placed = []; items = []
    def td(x, y, px, py):
        dx = abs(x-px); dx = min(dx, W-dx); dy = abs(y-py); dy = min(dy, H-dy); return math.hypot(dx, dy)
    def free(x, y, r, gap, name=None):
        for px, py, pr, pn in placed:
            d = td(x, y, px, py)
            if d < r + pr + gap or (name and pn == name and d < same_gap): return False
        return True
    def fill_tier(names, rng, gap, box, lib, fail_max, limit=None):
        bag = []; fails = 0; n = 0
        while fails < fail_max and (limit is None or n < limit):
            if not bag: bag = names[:]; rnd.shuffle(bag)
            nm = bag[-1]; size = rnd.uniform(*rng); x, y = rnd.uniform(0, W), rnd.uniform(0, H)
            if free(x, y, size*0.46, gap, nm):
                placed.append((x, y, size*0.46, nm)); items.append((lib[nm], box, x, y, size, rnd.uniform(-28, 28))); bag.pop(); fails = 0; n += 1
            else:
                fails += 1
                if fails % 120 == 0: rnd.shuffle(bag)
    # big + medium detailed drawings
    fill_tier(big_names, tiers[0], 18, BIG_BOX, ICONS, 1500, limit=len(big_names))
    fill_tier(big_names, tiers[1], 15, BIG_BOX, ICONS, 3000)
    # small secondary drawings
    fill_tier(small_names, small_rng, 13, SMALL_BOX, SMALL, 3000)
    # a few tiny sparkles, only in real gaps
    fill_tier(list(TINY), (13, 19), 14, SMALL_BOX, TINY, 2000, limit=tiny_count)
    body = []
    for parts, box, x, y, size, rot in items:
        reach = size * 0.75
        for dx in (-W, 0, W):
            for dy in (-H, 0, H):
                nx, ny = x+dx, y+dy
                if -reach < nx < W+reach and -reach < ny < H+reach:
                    body.append(render(parts, box, nx, ny, size, rot, sw))
    c = Counter(p[3] for p in placed if p[3] in ICONS)
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">'
           f'<g fill="none" stroke="#000" stroke-linecap="round" stroke-linejoin="round">' + "".join(body) + "</g></svg>")
    return svg, sum(c.values()), len(c), max(c.values()) if c else 0


ALL_BIG = list(ICONS)
SPACE = ["cat_astronaut", "rocket_cat", "planet_cat", "ufo_cat", "moon_face", "constellation_cat", "constellation_heart", "sleepy_cat",
         "headphones_cat", "plane_trail", "sun_face", "cloud_face", "cat_sitting", "fish", "paw_trail", "kitten_yarn", "cat_box", "chat_pair"]
LOVE = ["letter_hearts", "chat_pair", "phone_chat", "mailbox", "plane_trail", "constellation_heart", "stamp_cat", "pigeon_post",
        "envelope_wings", "ring_box", "balloons", "lock_heart", "cloud_face", "coffee", "cupcake", "cat_sitting", "kitten_yarn", "butterfly",
        "sticker_pack", "gift"]
VARIANTS = {
    "v4_cute_mix": (ALL_BIG, list(SMALL)),
    "v4_space_cats": (SPACE, ["s_star", "s_spark", "s_planet", "s_moon", "s_burst", "s_paw", "s_fish", "s_heart"]),
    "v4_love_letters": (LOVE, ["s_heart", "s_env", "s_bubble", "s_spark", "s_flower", "s_note", "s_star", "s_paw"]),
}

if __name__ == "__main__":
    os.makedirs("out/v4", exist_ok=True)
    for i, (name, (big, small)) in enumerate(VARIANTS.items()):
        svg, total, uniq, mx = generate(big, small, seed=900 + i * 13)
        open(f"out/v4/{name}.svg", "w").write(svg)
        print(f"{name:18} big/medium={total} unique={uniq} max_repeat={mx} {len(svg)//1024}KB")
