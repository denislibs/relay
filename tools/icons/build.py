"""Messenger icon pack v3 → packages/relay-ui/src/iconPack.js

python tools/icons/build.py <path to the unpacked pack>/outline

Our icon names → pack files (outline 24×24, stroke 1.8, currentColor). Names missing from the pack keep the kit's own paths.
Filled variants (*Filled) exist only where Telegram draws a filled glyph (telegram-tt: new-chat-filled on the
new-chat button, archive-filled, pin-filled, share-filled for forwards, info-filled, lock-filled, play/pause):
the pack has no filled set, so they are built from its outlines — the shape is filled, inner details are cut out.
"""
import json, os, re, sys

MAP = {
    'search': 'search', 'more': 'more-vertical', 'plus': 'plus', 'close': 'close', 'chats': 'chat', 'phone': 'phone',
    'status': 'story', 'community': 'users', 'archive': 'archive', 'send': 'send', 'mic': 'mic', 'smile': 'smile',
    'attach': 'paperclip', 'check': 'check', 'clock': 'clock', 'alert': 'alert-circle', 'info': 'info', 'list': 'list',
    'volume': 'volume', 'volumeOff': 'volume-off', 'repeat': 'repeat', 'shuffle': 'shuffle', 'music': 'music',
    'musicAdd': 'music-plus', 'musicRemove': 'music-minus', 'newTab': 'external-link', 'markRead': 'check-double',
    'bellOff': 'bell-off', 'lock': 'lock', 'download': 'download', 'chevronRight': 'chevron-right', 'logout': 'logout',
    'arrowLeft': 'arrow-left', 'arrowRight': 'arrow-right', 'arrowDown': 'arrow-down', 'external': 'external-link',
    'video': 'video', 'mail': 'mail', 'palette': 'palette', 'history': 'history', 'wifiOff': 'wifi-off', 'image': 'image',
    'play': 'play', 'pause': 'pause', 'stop': 'square', 'trash': 'trash', 'star': 'star', 'reply': 'reply', 'forward': 'forward',
    'zoomIn': 'zoom-in', 'chevronLeft': 'chevron-left', 'chevronDown': 'chevron-down', 'menu': 'menu', 'chevronUp': 'chevron-up',
    'pin': 'pin', 'ban': 'block', 'camera': 'camera', 'contact': 'user', 'poll': 'poll', 'sticker': 'sticker',
    'phoneIn': 'call-incoming', 'phoneOut': 'call-outgoing', 'settings': 'settings', 'copy': 'copy', 'eye': 'eye',
    'eyeOff': 'eye-off', 'key': 'key', 'qr': 'qr', 'link': 'link', 'grip': 'grip-vertical', 'undo': 'undo', 'redo': 'redo',
    'code': 'code', 'heading': 'heading', 'quote': 'quote', 'divider': 'minus', 'text': 'type', 'expand': 'maximize',
    'collapse': 'minimize', 'article': 'newspaper', 'cloud': 'cloud', 'file': 'file', 'pencil': 'edit', 'userPlus': 'user-plus',
    'users': 'users', 'userCheck': 'user-check', 'userX': 'user-x', 'userMinus': 'user-minus', 'refresh': 'refresh',
    'crown': 'crown', 'bell': 'bell', 'timer': 'timer', 'shield': 'shield', 'upload': 'upload', 'account': 'user-circle',
    'general': 'sliders', 'storage': 'database', 'folder': 'folder', 'checkCircle': 'check-circle', 'briefcase': 'briefcase',
    'home': 'home', 'heart': 'heart', 'graduation': 'graduation', 'gamepad': 'gamepad', 'plane': 'plane', 'cart': 'cart',
    'bot': 'bot', 'rocket': 'rocket', 'globe': 'globe', 'devices': 'devices', 'bug': 'bug', 'laptop': 'laptop',
    'smartphone': 'smartphone', 'at': 'at', 'cake': 'cake', 'block': 'block', 'moon': 'moon', 'sun': 'sun', 'calendar': 'calendar',
    'soundOff': 'volume-off', 'roundVideo': 'video-message', 'bold': 'bold', 'italic': 'italic', 'underline': 'underline',
    'strike': 'strikethrough',
}

# Auto-filled variants that look worse than the outline (tiles then show the outline, a bit bolder)
SKIP_FILLED = {'globeFilled', 'devicesFilled', 'expandFilled', 'collapseFilled', 'atFilled'}   # @ — символ, его не заливают

# Our own drawings where the pack's glyph looks rough (outline; the filled variant is built the same way as for the pack)
OWN = {
    'cake': '<path d="M12 3.2c.8.9 1.2 1.6 1.2 2.2a1.2 1.2 0 0 1-2.4 0c0-.6.4-1.3 1.2-2.2z"/><path d="M12 7.8v2.7"/>'
            '<path d="M6.5 10.5h11a2 2 0 0 1 2 2V20h-15v-7.5a2 2 0 0 1 2-2z"/>'
            '<path d="M4.5 14.2c1.25 0 1.25 1.1 2.5 1.1s1.25-1.1 2.5-1.1 1.25 1.1 2.5 1.1 1.25-1.1 2.5-1.1 1.25 1.1 2.5 1.1 1.25-1.1 2.5-1.1"/>'
            '<path d="M3 20h18"/>',
}

# Filled variants: (fill — closed shapes painted solid, cut — strokes cut out of them, extra — strokes drawn on top as is)
FILLED = {
    # new-chat button (telegram-tt NewChatButton: new-chat-filled)
    'pencilFilled': {'fill': ['M4 20l.8-4.2L16.5 4.1a2.1 2.1 0 0 1 3 3L7.8 19.2z'], 'cut': ['M14.5 6.2l3.3 3.3']},
    # archived chats row (archive-filled)
    'archiveFilled': {'fill': ['M4.5 4h15A1.5 1.5 0 0 1 21 5.5v1.5A1.5 1.5 0 0 1 19.5 8.5h-15A1.5 1.5 0 0 1 3 7V5.5A1.5 1.5 0 0 1 4.5 4z',
                                'M5 8.5h14V18a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z'], 'cut': ['M10 13h4', 'M4 8.5h16']},
    # pinned chat / pinned in a message (pin-filled)
    'pinFilled': {'fill': ['M10 3.5h4v6l3 4H7l3-4z'], 'extra': ['M9 3.5h6', 'M12 13.5V20']},
    # forwarded / quick forward (share-filled): the pack's forward arrow as a solid curved arrow
    'forwardFilled': {'fill': ['M14.2 5.6a.8.8 0 0 1 1.3-.6l5.4 5.6a1 1 0 0 1 0 1.4l-5.4 5.6a.8.8 0 0 1-1.3-.6V14.4c-4.3 0-7.4 1.2-9.6 4.3-.3.4-.9.2-.8-.3.7-5 3.8-8.6 10.4-9.4z']},
    'replyFilled': {'fill': ['M9.8 5.6a.8.8 0 0 0-1.3-.6L3.1 10.6a1 1 0 0 0 0 1.4l5.4 5.6a.8.8 0 0 0 1.3-.6V14.4c4.3 0 7.4 1.2 9.6 4.3.3.4.9.2.8-.3-.7-5-3.8-8.6-10.4-9.4z']},
    # info toasts (info-filled)
    'infoFilled': {'fill': ['M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z'], 'cut': ['M12 11v5.5', 'M12 7.7v.2']},
    # locked folder tab (lock-filled)
    'lockFilled': {'fill': ['M8 10.5h8a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-4a3 3 0 0 1 3-3z'], 'cut': ['M12 15v2'],
                   'extra': ['M8 10.5V8a4 4 0 0 1 8 0v2.5']},
    # people: solid silhouettes (the auto fill turns the outline face into a «sad face»)
    'accountFilled': {'fill': ['M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z'], 'cut': ['M12 7.2a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6z', 'M7.4 17.6c.9-1.9 2.6-2.9 4.6-2.9s3.7 1 4.6 2.9']},
    'contactFilled': {'fill': ['M12 3.5a4 4 0 1 1 0 8 4 4 0 0 1 0-8z', 'M5 19.3c.6-3.7 3.4-5.8 7-5.8s6.4 2.1 7 5.8a1 1 0 0 1-1 1.2H6a1 1 0 0 1-1-1.2z']},
    'usersFilled': {'fill': ['M9 4.7a3.3 3.3 0 1 1 0 6.6 3.3 3.3 0 0 1 0-6.6z', 'M2.8 18.6c.6-3.3 3-5.1 6.2-5.1s5.6 1.8 6.2 5.1a.9.9 0 0 1-.9 1.1H3.7a.9.9 0 0 1-.9-1.1z',
                             'M16.5 6.2a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6z', 'M16.6 13.7c2.7 0 4.5 1.5 5 4.3a.9.9 0 0 1-.9 1.1h-3.6c-.2-2.2-1-4-2.4-5.2.6-.1 1.2-.2 1.9-.2z']},
    'communityFilled': {'fill': ['M9 4.7a3.3 3.3 0 1 1 0 6.6 3.3 3.3 0 0 1 0-6.6z', 'M2.8 18.6c.6-3.3 3-5.1 6.2-5.1s5.6 1.8 6.2 5.1a.9.9 0 0 1-.9 1.1H3.7a.9.9 0 0 1-.9-1.1z',
                             'M16.5 6.2a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6z', 'M16.6 13.7c2.7 0 4.5 1.5 5 4.3a.9.9 0 0 1-.9 1.1h-3.6c-.2-2.2-1-4-2.4-5.2.6-.1 1.2-.2 1.9-.2z']},
    # media controls (play / pause are solid in Telegram)
    'playFilled': {'fill': ['M7 4.5v15l12-7.5z']},
    'stopFilled': {'fill': ['M8 5h8a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3z']},
    'pauseFilled': {'fill': ['M7 4.5h2.5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z',
                             'M14.5 4.5H17a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-2.5a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z']},
}

def inner(svg: str) -> str:
    m = re.search(r'<svg[^>]*>(.*)</svg>', svg, re.S)
    body = m.group(1).strip()
    if re.search(r'<(script|foreignObject|image|use)\b|on[a-z]+=|href=', body, re.I):
        raise SystemExit('refusing suspicious svg content')
    return body

import math
from svgelements import SVG, Path as SPath, Rect as SRect, Circle as SCircle, Ellipse as SEllipse

def autofill(body: str):
    """Filled variant of an outline: closed shapes are filled; strokes and tiny dots inside them are cut out; the rest stays a stroke."""
    svg = SVG.parse(__import__('io').StringIO(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">{body}</svg>'), reify=True)
    closed, lines = [], []
    for e in svg.elements():
        if isinstance(e, (SRect, SCircle, SEllipse)):
            d = SPath(e).d(); bb = e.bbox()
            small = isinstance(e, SCircle) and (bb[2] - bb[0]) <= 2.6
            (lines if small else closed).append((d, bb, small))
        elif isinstance(e, SPath) and not isinstance(e, (SRect, SCircle, SEllipse)):
            for sp in e.as_subpaths():
                p = SPath(sp); d = p.d()
                if not d.strip(): continue
                bb = p.bbox()
                (closed if p.segments() and getattr(p.segments()[-1], '__class__').__name__ == 'Close' else lines).append((d, bb, False))
    def inside(bb, big):
        cx, cy = (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2
        return big[0] - .3 <= cx <= big[2] + .3 and big[1] - .3 <= cy <= big[3] + .3 and (bb[2] - bb[0]) <= (big[2] - big[0]) + .5 and (bb[3] - bb[1]) <= (big[3] - big[1]) + .5
    area = lambda b: max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    holes = [(d, bb) for d, bb, _ in closed if any(b is not bb and inside(bb, b) and area(bb) < .6 * area(b) for _, b, _ in closed)]
    fill = [d for d, bb, _ in closed if all(bb is not hb for _, hb in holes)]
    cut, extra = [d for d, _ in holes], []
    for d, bb, small in lines:
        (cut if any(inside(bb, b) for _, b, _ in closed) else (fill if small else extra)).append(d)
    if not fill: return None
    out = {'fill': fill}
    if cut: out['cut'] = cut
    if extra: out['extra'] = extra
    return out

def main(src: str) -> None:
    out = {}
    missing = []
    for ours, pack in MAP.items():
        f = os.path.join(src, pack + '.svg')
        if not os.path.exists(f): missing.append(f'{ours}→{pack}'); continue
        out[ours] = inner(open(f).read())
    if missing: raise SystemExit('missing in pack: ' + ', '.join(missing))
    out.update(OWN)
    filled = {}
    for name, body in out.items():
        f = autofill(body)
        if f: filled[name + 'Filled'] = f
    for name in SKIP_FILLED: filled.pop(name, None)   # заливка их только портит — остаются контуром
    filled.update(FILLED)   # нарисованные вручную — поверх автоматических
    here = os.path.dirname(os.path.abspath(__file__))
    dst = os.path.join(here, '..', '..', 'packages', 'relay-ui', 'src', 'iconPack.js')
    js = ['// Сгенерировано tools/icons/build.py из Messenger icon pack v3 — не править руками.',
          '// PACK_ICONS: имя кита → внутренности SVG 24×24 (контур, stroke 1.8). PACK_FILLED: залитые варианты там, где они у Telegram.',
          'export var PACK_ICONS = ' + json.dumps(out, ensure_ascii=False, indent=1) + ';',
          'export var PACK_FILLED = ' + json.dumps(filled, ensure_ascii=False, indent=1) + ';', '']
    open(dst, 'w').write('\n'.join(js))
    print(f'{len(out)} outline + {len(filled)} filled → {os.path.relpath(dst)}')

if __name__ == '__main__':
    main(sys.argv[1])
