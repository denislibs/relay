"""15 Telegram-style detailed doodle patterns (v5). python gen_v5.py -> out/v5/raw/*.svg"""
import os, random
from gen_v4 import *  # ICONS, SMALL, TINY, generate, helpers
from gen_v4 import _place

MOON = "M29 6 A18 18 0 1 0 42 31 A14 14 0 1 1 29 6 Z"
DROP = "M24 8 C16 20 14 28 24 38 C34 28 32 20 24 8 Z"
def drop(cx, cy, w, fill=False): return _place(DROP, cx, cy, w, (24, 24), 30, 0, fill)
def flower(cx, cy, r):
    import math
    return [C(cx, cy, round(r*0.55, 1))] + [C(round(cx + r*1.2*math.cos(a), 1), round(cy + r*1.2*math.sin(a), 1), round(r*0.7, 1))
                                            for a in [i*2*math.pi/6 for i in range(6)]]

ICONS.update({
# --- cafe & sweets
"croissant": [P("M8 58 C10 36 30 22 50 22 C70 22 90 36 92 58 C86 66 78 64 74 58 C70 64 62 66 58 60 C54 66 46 66 42 60 C38 66 30 64 26 58 C22 64 14 66 8 58 Z"),
    P("M26 58 C28 44 34 32 40 26 M42 60 C42 46 44 34 46 23 M58 60 C58 46 56 34 54 23 M74 58 C72 44 66 32 60 26"), spark(86, 18, 10)],
"cake_slice": [P("M10 46 L70 22 L90 40 Z"), P("M10 46 V80 L90 74 V40"), P("M10 60 L90 54 M10 70 L90 64"), C(66, 15, 5),
    P("M66 10 Q68 4 74 4"), P("M54 28 Q58 22 64 26 Q68 20 74 28")],
"teapot": [P("M24 44 C18 60 26 84 50 84 C74 84 82 60 76 44 Z"), P("M30 44 C30 30 70 30 70 44"), C(50, 28, 4),
    P("M24 52 C12 50 8 40 4 36 C10 48 14 64 26 68"), P("M76 50 C92 50 92 72 74 74"), heart(50, 62, 16), P("M84 22 Q80 16 84 10 M92 26 Q88 20 92 14")],
"donut": [C(50, 50, 36), C(50, 50, 12),
    P("M18 44 C22 24 46 16 66 20 C84 26 90 44 84 58 C78 52 74 62 68 56 C62 64 56 56 50 62 C44 56 38 66 32 58 C26 64 20 56 18 44 Z"),
    P("M30 34 L34 32 M46 26 L48 30 M62 28 L66 29 M72 42 L74 38 M28 46 L30 42 M68 50 L72 50")],
"birthday_cake": [R(16, 56, 68, 30, 4), R(26, 36, 48, 20, 3), P("M16 64 Q22 70 28 64 Q34 70 40 64 Q46 70 52 64 Q58 70 64 64 Q70 70 76 64 Q80 68 84 64"),
    P("M38 36 V24 M50 36 V22 M62 36 V24"), P("M38 18 Q34 14 38 8 Q42 14 38 18 Z M50 16 Q46 12 50 6 Q54 12 50 16 Z M62 18 Q58 14 62 8 Q66 14 62 18 Z"),
    P("M6 90 H94"), heart(50, 46, 9, True)],
# --- night
"owl": [P("M22 88 C14 60 18 30 30 18 L36 28 Q50 24 64 28 L70 18 C82 30 86 60 78 88 Z"), C(38, 44, 10), C(62, 44, 10),
    C(38, 44, 4, True), C(62, 44, 4, True), P("M46 54 L50 62 L54 54 Z"),
    P("M38 70 Q42 74 46 70 Q50 74 54 70 Q58 74 62 70 M42 78 Q46 82 50 78 Q54 82 58 78"), P("M4 90 H96"), P("M40 88 V93 M60 88 V93")],
"lamp": [P("M30 18 H70 L80 48 H20 Z"), P("M50 48 V82"), P("M30 90 Q50 80 70 90 Z"), DASH("M26 56 L16 68 M50 56 V70 M74 56 L84 68"), star(50, 33, 6)],
"pillow_moon": [P("M14 40 C10 30 20 26 30 30 C44 34 56 34 70 30 C80 26 90 30 86 40 C84 50 84 60 86 70 C90 80 80 84 70 80 C56 76 44 76 30 80 C20 84 10 80 14 70 C16 60 16 50 14 40 Z"),
    _place(MOON, 50, 55, 26), P("M78 8 H86 L78 16 H86 M88 18 H93 L88 23 H93")],
# --- garden
"watering_can": [R(24, 40, 42, 46, 5), P("M24 48 C8 48 8 76 24 76"), P("M32 40 C34 28 56 28 58 40"), P("M66 60 L88 36 M66 72 L92 42"),
    P("M84 30 L98 46"), drop(92, 58, 6), drop(84, 64, 6), drop(97, 70, 6), heart(45, 63, 14)],
"flower_pot": [P("M28 60 H72 L66 92 H34 Z"), R(24, 54, 52, 8, 2), P("M50 54 V30"),
    P("M50 46 C40 46 34 40 34 34 C44 34 50 40 50 46 Z M50 40 C60 40 66 34 66 28 C56 28 50 34 50 40 Z")] + flower(50, 20, 6),
"bee": [E(52, 54, 22, 16), P("M44 40 Q40 54 44 68 M56 39 Q52 54 56 69"), C(26, 52, 10), C(23, 49, 2, True), P("M21 56 Q24 59 27 56"),
    P("M22 44 Q16 32 10 32 M28 42 Q28 30 22 26"), E(48, 30, 9, 13, -20), E(64, 30, 9, 13, 20), P("M74 54 L82 54"), DASH("M84 70 Q94 80 82 90")],
"snail": [C(56, 50, 24), P("M56 50 m-6 0 a6 6 0 1 1 6 6 a12 12 0 0 1 -12 -12 a18 18 0 0 1 18 -18"), P("M8 80 H80 Q92 80 88 70 Q84 74 78 74"),
    P("M8 80 C4 68 10 60 18 62 C22 64 26 70 32 74"), P("M14 62 L10 48 M20 62 L22 48"), C(10, 46, 2.5), C(22, 46, 2.5), P("M13 70 Q15 72 17 70")],
"mushroom": [P("M10 54 C10 30 30 16 50 16 C70 16 90 30 90 54 Z"), P("M36 54 C34 66 34 80 38 88 H62 C66 80 66 66 64 54"),
    C(30, 40, 5), C(52, 28, 6), C(72, 40, 5), C(44, 68, 2, True), C(56, 68, 2, True), P("M47 74 Q50 77 53 74"),
    P("M26 88 L30 80 L34 88 M66 88 L70 80 L74 88")],
"tulips": [P("M30 50 V92 M60 44 V92"), P("M20 26 L25 34 L30 22 L35 34 L40 26 V38 A10 10 0 0 1 20 38 Z"),
    P("M50 20 L55 28 L60 16 L65 28 L70 20 V32 A10 10 0 0 1 50 32 Z"), P("M30 76 Q16 72 14 60 Q28 62 30 72 M60 70 Q76 66 80 54 Q64 56 60 66"),
    P("M20 92 H72")],
# --- party
"party_hat": [P("M50 8 L76 84 H24 Z"), P("M38 42 L62 46 M30 64 L70 70"), C(50, 8, 6), C(44, 56, 2.5, True), C(58, 30, 2.5, True),
    C(56, 78, 2.5, True), DASH("M24 84 Q50 96 76 84"), P("M84 20 L88 26 M12 30 L18 28"), spark(86, 48, 10)],
"crown": [P("M12 76 L8 30 L30 52 L50 18 L70 52 L92 30 L88 76 Z"), P("M14 66 H86"), C(30, 71, 3), C(50, 71, 4), C(70, 71, 3),
    C(8, 27, 3), C(50, 14, 4), C(92, 27, 3)],
# --- privacy
"safe": [R(14, 12, 72, 74, 6), R(22, 20, 56, 58, 4), C(50, 49, 14), P("M50 35 V39 M64 49 H60 M50 63 V59 M36 49 H40"),
    P("M50 49 L58 41"), C(50, 49, 2.5, True), P("M22 86 V92 M78 86 V92"), P("M72 42 V56")],
"heart_key": [heart(28, 40, 40), heart(28, 40, 16), P("M44 48 L90 74"), P("M78 67 L74 76 M86 71 L82 80 M70 63 L67 70")],
"eye_off": [P("M8 50 C22 28 38 22 50 22 C62 22 78 28 92 50 C78 72 62 78 50 78 C38 78 22 72 8 50 Z"), C(50, 50, 12), C(50, 50, 4, True),
    P("M30 25 L26 16 M50 22 V11 M70 25 L74 16"), P("M16 88 L84 12")],
"fingerprint": [P("M24 80 C18 66 18 52 22 42 A30 30 0 0 1 78 42 C82 54 80 68 76 80"),
    P("M34 86 C28 72 28 56 32 48 A19 19 0 0 1 68 48 C72 60 70 74 66 86"),
    P("M44 90 C40 76 40 62 42 56 A8 8 0 0 1 58 56 C60 66 58 78 56 90"), P("M50 58 C52 70 50 82 48 92"), spark(86, 14, 10)],
"chat_lock": [P("M12 12 H88 A8 8 0 0 1 96 20 V62 A8 8 0 0 1 88 70 H40 L22 86 V70 H12 A8 8 0 0 1 4 62 V20 A8 8 0 0 1 12 12 Z"),
    R(36, 36, 28, 22, 4), P("M42 36 V30 A8 8 0 0 1 58 30 V36"), C(50, 46, 2.5, True), P("M50 47 V52")],
# --- post
"parcel": [P("M50 18 L86 34 L86 74 L50 90 L14 74 L14 34 Z"), P("M14 34 L50 50 L86 34 M50 50 V90"), P("M32 26 L68 42 V54"),
    heart(31, 66, 12), P("M60 68 L76 61 M60 76 L72 71")],
"postcard": [R(6, 22, 88, 58, 3), P("M50 28 V74"), P("M56 48 H86 M56 58 H86 M56 68 H78"), R(70, 28, 16, 13, 1),
    P("M12 70 L24 52 L32 62 L40 48 L46 56"), C(22, 36, 5)],
# --- music
"vinyl": [C(50, 50, 40), P("M50 22 A28 28 0 0 1 78 50 M50 78 A28 28 0 0 1 22 50"), P("M50 30 A20 20 0 0 1 70 50 M50 70 A20 20 0 0 1 30 50"),
    C(50, 50, 10), C(50, 50, 2.5, True), heart(50, 50.5, 9)],
"guitar": [P("M30 92 C14 92 10 76 18 68 C22 64 20 58 24 54 C30 46 42 48 46 56 C50 62 56 62 60 66 C68 74 62 92 46 92 Z"),
    C(38, 74, 6), P("M44 60 L80 18 M48 64 L84 22"), P("M78 12 L88 4 L96 12 L86 22 Z"), P("M34 80 L86 18"), P("M26 80 L34 88")],
"retro_mic": [C(50, 28, 18), P("M36 20 H64 M33 28 H67 M36 36 H64"), P("M42 45 L44 60 H56 L58 45"), P("M50 60 V86 M34 90 H66"),
    P("M80 32 V14 L92 11 V28"), C(77, 32, 3), C(89, 28, 3), P("M12 26 Q6 34 12 42")],
"cassette": [R(8, 22, 84, 56, 5), R(20, 30, 60, 26, 3), C(36, 43, 6), C(64, 43, 6), P("M42 43 H58"), P("M28 78 L34 66 H66 L72 78"),
    P("M26 62 H74"), heart(50, 43.5, 7, True)],
# --- travel
"suitcase": [R(12, 30, 76, 54, 6), P("M38 30 V20 A4 4 0 0 1 42 16 H58 A4 4 0 0 1 62 20 V30"), P("M30 30 V84 M70 30 V84"),
    C(22, 90, 4), C(78, 90, 4), heart(50, 50, 14), star(50, 70, 6)],
"map": [P("M8 24 L34 14 L66 26 L92 16 V76 L66 86 L34 74 L8 84 Z"), P("M34 14 V74 M66 26 V86"), DASH("M16 68 Q30 50 44 58 T72 44"),
    P("M74 34 L82 42 M82 34 L74 42")],
"camera": [R(8, 32, 84, 52, 8), P("M30 32 L36 20 H64 L70 32"), C(50, 58, 18), C(50, 58, 10), R(74, 38, 10, 6, 2), P("M43 53 A8 8 0 0 1 50 48"), C(18, 40, 2.5, True)],
"hot_air_balloon": [P("M50 6 C24 6 14 28 20 46 C24 58 38 66 42 72 H58 C62 66 76 58 80 46 C86 28 76 6 50 6 Z"),
    P("M50 6 C40 20 38 50 44 72 M50 6 C60 20 62 50 56 72"), P("M42 72 L44 82 M58 72 L56 82"), R(40, 82, 20, 12, 2),
    P("M74 90 H92 A5 5 0 0 0 88 81 A7 7 0 0 0 76 84 A4 4 0 0 0 74 90 Z")],
"compass": [C(50, 50, 38), C(50, 50, 31), P("M50 22 L58 50 L50 78 L42 50 Z"), P("M42 50 H58"), C(50, 50, 3, True),
    P("M50 12 V17 M50 83 V88 M12 50 H17 M83 50 H88")],
# --- rainy day
"cat_window": [R(14, 8, 72, 82, 4), P("M50 8 V90 M14 49 H86"), P("M6 90 H94"), P("M22 90 C20 80 22 72 28 70 M42 90 C44 80 42 72 36 70")] +
    cat_head(32, 64, 0.55) + [drop(64, 22, 6), drop(76, 32, 6), drop(66, 40, 6), drop(78, 62, 6), drop(64, 74, 6)],
"rain_cloud": [P("M18 58 H76 A16 16 0 0 0 78 26 A22 22 0 0 0 36 22 A18 18 0 0 0 18 58 Z"), C(40, 42, 2.5, True), C(58, 42, 2.5, True),
    P("M45 48 Q49 46 53 48"), drop(30, 76, 10), drop(50, 86, 10), drop(70, 76, 10)],
"boots": [P("M18 18 H42 V62 L64 68 C72 70 74 82 68 84 H18 Z"), P("M18 74 H70"), P("M42 28 H18"), E(46, 92, 40, 4), drop(80, 30, 8), drop(88, 46, 6)],
# --- ocean
"whale": [P("M8 56 C8 36 30 28 52 32 C70 36 78 46 80 54 L94 40 L92 62 L80 60 C74 74 54 80 36 78 C20 76 8 70 8 56 Z"),
    C(26, 52, 2.5, True), P("M14 62 Q24 68 34 64"), P("M32 70 Q46 74 60 70"), P("M42 30 C40 20 34 18 30 14 M42 30 C44 20 50 18 54 14 M42 30 V16")],
"octopus": [P("M26 50 C20 22 80 22 74 50"),
    P("M26 50 C22 64 12 70 10 80 C18 82 24 74 30 62 M38 54 C36 70 30 80 32 90 C40 88 42 76 44 58 M56 58 C58 76 60 88 68 90 C70 80 64 70 62 54 M74 50 C78 64 88 70 90 80 C82 82 76 74 70 62"),
    C(40, 40, 3, True), C(60, 40, 3, True), P("M44 48 Q50 52 56 48"), C(84, 20, 3), C(91, 11, 2)],
"shell": [P("M50 88 L14 44 C14 24 32 12 50 12 C68 12 86 24 86 44 Z"), P("M50 88 L30 16 M50 88 V12 M50 88 L70 16 M50 88 L18 32 M50 88 L82 32"),
    P("M42 88 H58 V94 H42 Z")],
"anchor": [C(50, 14, 6), P("M50 20 V86"), P("M34 30 H66"), P("M14 60 C16 78 32 88 50 86 C68 88 84 78 86 60"),
    P("M14 60 L10 68 M14 60 L22 64 M86 60 L90 68 M86 60 L78 64"), DASH("M44 14 C30 20 24 40 34 50")],
"paper_boat": [P("M10 58 H90 L76 78 H24 Z"), P("M50 58 V12 L80 50 Z"), P("M50 22 L28 50 H50"), P("M4 90 Q14 84 24 90 T44 90 T64 90 T84 90 T96 88")],
"wave": [P("M4 70 C20 70 22 40 44 34 C64 28 80 40 76 54 C72 64 58 62 58 52 C58 44 68 44 70 50"),
    P("M4 84 Q14 78 24 84 T44 84 T64 84 T84 84 T96 84"), C(84, 28, 3), C(92, 38, 2)],
"cat_fishing": cat_head(30, 38, 0.8) + [P("M18 52 C14 64 14 78 18 88 H44 C48 78 46 64 42 52"), P("M44 62 L86 12"), P("M86 12 V68"),
    P("M74 76 C78 70 86 70 90 76 C86 82 78 82 74 76 Z M90 76 L96 71 V81 Z"), P("M56 92 Q66 88 76 92 T96 92")],
# --- tech
"laptop": [R(16, 14, 68, 48, 4), R(22, 20, 56, 36, 2), P("M6 70 H94 L88 80 H12 Z"), P("M42 70 V74 H58 V70"), R(28, 26, 24, 10, 5),
    R(44, 40, 26, 10, 5), heart(77, 22, 8, True)],
"gamepad": [P("M28 30 H72 C86 30 94 42 96 58 C98 74 88 82 80 76 L70 66 H30 L20 76 C12 82 2 74 4 58 C6 42 14 30 28 30 Z"),
    P("M24 42 V58 M16 50 H32"), C(70, 42, 3.5), C(78, 50, 3.5), C(62, 50, 3.5), C(70, 58, 3.5), P("M44 46 H48 M52 46 H56")],
"battery_love": [R(8, 30, 74, 40, 6), R(82, 42, 8, 16, 2), P("M18 38 V62 M28 38 V62 M38 38 V62"), heart(60, 50, 20, True)],
"bell": [P("M22 72 H78 L70 62 V44 A20 20 0 0 0 30 44 V62 Z"), P("M42 80 A8 8 0 0 0 58 80"), P("M50 18 V24"), C(74, 24, 10),
    heart(74, 24.5, 10, True), P("M12 40 Q8 50 12 60 M88 44 Q92 52 88 60")],
"wifi_cat": [P("M14 46 A50 50 0 0 1 86 46"), P("M26 58 A34 34 0 0 1 74 58"), P("M38 70 A17 17 0 0 1 62 70")] + cat_head(50, 84, 0.42),
})
SMALL.update({"s_drop": [_place(DROP, 24, 24, 30)], "s_shell": [P("M24 42 L8 22 C8 12 16 6 24 6 C32 6 40 12 40 22 Z"), P("M24 42 V6 M24 42 L14 10 M24 42 L34 10")],
              "s_leaf": [P("M8 40 C8 18 24 8 40 8 C40 28 28 40 8 40 Z"), P("M8 40 L30 18")]})

GENERIC = ["cat_sitting", "kitten_yarn", "sleepy_cat", "cat_box", "paw_trail", "constellation_heart", "letter_hearts",
           "chat_pair", "cloud_face", "butterfly", "balloons", "plane_trail", "sticker_pack", "fish", "constellation_cat", "headphones_cat"]
CATS = ["cat_sitting", "kitten_yarn", "sleepy_cat", "cat_box", "paw_trail", "fish"]
HEARTS = ["letter_hearts", "constellation_heart", "balloons", "cloud_face"]
T = {
 "01_cute_mix":     (["cat_astronaut", "letter_hearts", "chat_pair", "phone_chat", "plane_trail", "kitten_yarn", "coffee", "cupcake", "gift",
                      "sleepy_cat", "stamp_cat", "rocket_cat", "planet_cat", "boba", "pigeon_post", "butterfly", "cat_box", "envelope_wings",
                      "bee", "vinyl", "camera", "whale", "cat_window", "mushroom", "headphones_cat", "constellation_cat"],
                     ["s_heart", "s_star", "s_spark", "s_paw", "s_bubble", "s_env", "s_note", "s_flower"]),
 "02_space_cats":   (["cat_astronaut", "rocket_cat", "planet_cat", "ufo_cat", "moon_face", "constellation_cat", "constellation_heart",
                      "sleepy_cat", "headphones_cat", "plane_trail", "sun_face", "lamp", "owl", "pillow_moon", "compass", "wifi_cat",
                      "cat_sitting", "fish", "paw_trail"], ["s_star", "s_spark", "s_planet", "s_moon", "s_burst", "s_paw"]),
 "03_love_letters": (["letter_hearts", "chat_pair", "mailbox", "plane_trail", "constellation_heart", "stamp_cat", "pigeon_post",
                      "envelope_wings", "ring_box", "balloons", "lock_heart", "heart_key", "postcard", "parcel", "cloud_face", "teapot",
                      "cat_sitting", "kitten_yarn", "butterfly", "tulips"], ["s_heart", "s_env", "s_bubble", "s_spark", "s_flower"]),
 "04_cat_cafe":     (["coffee", "teapot", "croissant", "cake_slice", "cupcake", "donut", "boba", "icecream", "cat_sitting", "kitten_yarn",
                      "sleepy_cat", "cat_box", "cat_window", "fish", "paw_trail", "laptop", "vinyl", "lamp", "chat_pair", "letter_hearts"],
                     ["s_heart", "s_paw", "s_star", "s_spark", "s_fish", "s_note"]),
 "05_sweet_tooth":  (["cupcake", "donut", "icecream", "cake_slice", "birthday_cake", "croissant", "boba", "coffee", "teapot", "balloons",
                      "gift", "party_hat", "cloud_face", "kitten_yarn", "cat_box", "constellation_heart", "sticker_pack", "butterfly"],
                     ["s_heart", "s_star", "s_spark", "s_flower", "s_burst"]),
 "06_night_dreams": (["moon_face", "owl", "lamp", "pillow_moon", "sleepy_cat", "constellation_cat", "constellation_heart", "ufo_cat",
                      "cat_astronaut", "planet_cat", "rocket_cat", "cat_window", "teapot", "headphones_cat", "vinyl", "rain_cloud", "wifi_cat"],
                     ["s_star", "s_spark", "s_moon", "s_planet", "s_burst"]),
 "07_garden":       (["flower_pot", "tulips", "watering_can", "bee", "snail", "mushroom", "butterfly", "sun_face", "rain_cloud", "cloud_face",
                      "boots", "cat_sitting", "kitten_yarn", "sleepy_cat", "paw_trail", "hot_air_balloon", "letter_hearts", "teapot"],
                     ["s_flower", "s_leaf", "s_heart", "s_drop", "s_spark", "s_paw"]),
 "08_party":        (["birthday_cake", "party_hat", "balloons", "gift", "crown", "cupcake", "donut", "vinyl", "cassette", "retro_mic",
                      "headphones_cat", "guitar", "camera", "ring_box", "sticker_pack", "cat_box", "chat_pair", "icecream"],
                     ["s_star", "s_spark", "s_burst", "s_heart", "s_note"]),
 "09_secret_chat":  (["safe", "heart_key", "eye_off", "fingerprint", "chat_lock", "lock_heart", "shield_cat", "incognito_cat", "phone_chat",
                      "laptop", "bell", "wifi_cat", "chat_pair", "cat_box", "sleepy_cat", "cat_sitting", "envelope_wings", "parcel", "ufo_cat"],
                     ["s_star", "s_spark", "s_bubble", "s_paw", "s_env"]),
 "10_post_office":  (["mailbox", "parcel", "postcard", "stamp_cat", "pigeon_post", "envelope_wings", "letter_hearts", "plane_trail",
                      "chat_pair", "phone_chat", "map", "suitcase", "hot_air_balloon", "cat_box", "cat_sitting", "bell", "paper_boat"],
                     ["s_env", "s_heart", "s_spark", "s_star", "s_bubble"]),
 "11_music_cats":   (["vinyl", "guitar", "retro_mic", "cassette", "headphones_cat", "constellation_cat", "cat_sitting", "kitten_yarn",
                      "sleepy_cat", "cat_window", "coffee", "lamp", "phone_chat", "laptop", "party_hat", "balloons", "moon_face"],
                     ["s_note", "s_star", "s_spark", "s_heart", "s_burst"]),
 "12_travel":       (["suitcase", "map", "camera", "hot_air_balloon", "compass", "plane_trail", "paper_boat", "postcard", "parcel",
                      "anchor", "sun_face", "cloud_face", "rocket_cat", "cat_box", "whale", "shell", "phone_chat", "coffee"],
                     ["s_star", "s_spark", "s_planet", "s_heart", "s_env"]),
 "13_rainy_day":    (["rain_cloud", "boots", "cat_window", "teapot", "coffee", "lamp", "pillow_moon", "sleepy_cat", "kitten_yarn",
                      "snail", "mushroom", "tulips", "letter_hearts", "vinyl", "croissant", "cloud_face", "laptop"],
                     ["s_drop", "s_heart", "s_leaf", "s_spark", "s_star"]),
 "14_ocean":        (["whale", "octopus", "shell", "anchor", "paper_boat", "wave", "cat_fishing", "fish", "compass", "map",
                      "sun_face", "cloud_face", "hot_air_balloon", "suitcase", "camera", "cat_sitting", "icecream", "constellation_heart"],
                     ["s_fish", "s_shell", "s_drop", "s_star", "s_spark"]),
 "15_online":       (["phone_chat", "laptop", "gamepad", "battery_love", "bell", "wifi_cat", "chat_pair", "chat_lock", "headphones_cat",
                      "camera", "sticker_pack", "plane_trail", "envelope_wings", "cat_box", "cat_sitting", "rocket_cat", "cassette", "boba"],
                     ["s_bubble", "s_heart", "s_star", "s_spark", "s_note", "s_env"]),
}

if __name__ == "__main__":
    os.makedirs("out/v5/raw", exist_ok=True)
    for i, (name, (big, small)) in enumerate(T.items()):
        for b in big: assert b in ICONS, b
        rnd = random.Random(i); extra = [k for k in GENERIC if k not in big]; rnd.shuffle(extra)
        big = big + extra[:max(0, 26 - len(big))]
        svg, total, uniq, mx = generate(big, small, seed=2000 + i * 31)
        open(f"out/v5/raw/{name}.svg", "w").write(svg)
        print(f"{name:16} drawings={total} unique={uniq} max_repeat={mx} raw={len(svg)//1024}KB")
