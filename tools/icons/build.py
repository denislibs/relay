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

def main(src: str) -> None:
    out = {}
    missing = []
    for ours, pack in MAP.items():
        f = os.path.join(src, pack + '.svg')
        if not os.path.exists(f): missing.append(f'{ours}→{pack}'); continue
        out[ours] = inner(open(f).read())
    if missing: raise SystemExit('missing in pack: ' + ', '.join(missing))
    here = os.path.dirname(os.path.abspath(__file__))
    dst = os.path.join(here, '..', '..', 'packages', 'relay-ui', 'src', 'iconPack.js')
    js = ['// Сгенерировано tools/icons/build.py из Messenger icon pack v3 — не править руками.',
          '// PACK_ICONS: имя кита → внутренности SVG 24×24 (контур, stroke 1.8). PACK_FILLED: залитые варианты там, где они у Telegram.',
          'export var PACK_ICONS = ' + json.dumps(out, ensure_ascii=False, indent=1) + ';',
          'export var PACK_FILLED = ' + json.dumps(FILLED, ensure_ascii=False, indent=1) + ';', '']
    open(dst, 'w').write('\n'.join(js))
    print(f'{len(out)} outline + {len(FILLED)} filled → {os.path.relpath(dst)}')

if __name__ == '__main__':
    main(sys.argv[1])
