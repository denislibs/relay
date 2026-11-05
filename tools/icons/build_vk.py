"""VK Icons (@vkontakte/icons, MIT) → packages/relay-ui/src/vkIcons.js

python3 tools/icons/build_vk.py <path to the unpacked npm package>     # npm pack @vkontakte/icons && tar xzf …

Our icon names → VK icons (24 px first, then 28/20/16). Outline names map to *_outline glyphs; *Filled variants take
the same glyph without "_outline" when VK has it (FILLED overrides the guess). Names missing here keep the kit's own
drawings (iconPack.js / kit.js), so the two sets can live side by side.
"""
import json, os, re, sys

VERSION_NOTE = '@vkontakte/icons'

MAP = {
    'search': 'search_outline', 'more': 'more_vertical', 'plus': 'add', 'close': 'cancel', 'chats': 'message_outline',
    'contacts': 'user_book_outline@56', 'sync': 'sync@20', 'phone': 'phone_outline', 'status': 'story_outline', 'channels': 'megaphone_outline', 'community': 'users_outline',
    'archive': 'archive_outline', 'unarchive': 'unarchive_outline', 'send': 'send_outline', 'mic': 'voice_outline',
    'smile': 'smile_outline', 'leaf': 'lotus_outline', 'like': 'thumbs_up_outline', 'dislike': 'thumbs_down_outline',
    'sad': 'sad_face_outline', 'coffee': 'cup_outline', 'bulb': 'lightbulb_outline', 'flag': 'flag_start',
    'bookmark': 'bookmark_outline', 'gif': 'gif_outline', 'attach': 'attach', 'check': 'done', 'clock': 'clock_outline',
    'alert': 'error_circle_outline', 'info': 'info_circle_outline', 'skipPrev': 'skip_previous', 'skipNext': 'skip_next',
    'list': 'list_bullet_outline', 'volume': 'volume_outline', 'volumeOff': 'mute_outline', 'volumeLow': 'volume_outline',
    'repeat': 'repeat_outline', 'repeatOne': 'repeat_1_outline', 'shuffle': 'shuffle_outline', 'music': 'music_outline',
    'newTab': 'external_link_outline', 'markRead': 'message_check_outline', 'markUnread': 'message_unread_outline',
    'bellOff': 'notification_slash_outline', 'lock': 'lock_outline', 'download': 'download_outline',
    'chevronRight': 'chevron_right_outline', 'logout': 'door_arrow_right_outline', 'arrowLeft': 'arrow_left_outline',
    'arrowRight': 'arrow_right_outline', 'arrowDown': 'arrow_down_outline', 'external': 'external_link_outline',
    'video': 'videocam_outline', 'mail': 'mail_outline', 'palette': 'palette_outline', 'history': 'history_backward_outline',
    'image': 'picture_outline', 'play': 'play', 'pause': 'pause', 'stop': 'stop', 'trash': 'delete_outline',
    'star': 'favorite_outline', 'reply': 'reply_outline', 'forward': 'share_outline', 'chevronLeft': 'chevron_left_outline',
    'chevronDown': 'chevron_down', 'menu': 'menu_outline', 'chevronUp': 'chevron_up', 'pin': 'pin_outline',
    'unpin': 'pin_slash_outline', 'ban': 'block_outline', 'camera': 'camera_outline', 'contact': 'user_outline',
    'poll': 'poll_outline', 'sticker': 'sticker_outline', 'phoneIn': 'phone_arrow_down_left', 'settings': 'gear_outline',
    'copy': 'copy_outline', 'eye': 'view_outline', 'eyeOff': 'hide_outline', 'key': 'key_outline', 'qr': 'qr',
    'link': 'linked_outline', 'grip': 'reorder_ios', 'undo': 'arrow_uturn_left_outline', 'redo': 'arrow_uturn_right_outline',
    'code': 'brackets_slash_outline', 'heading': 'text_heading_1_outline', 'quote': 'quote_closing', 'divider': 'minus_outline',
    'text': 'text_outline', 'expand': 'fullscreen', 'pip': 'picture_in_picture_16x9_outline', 'collapse': 'fullscreen_exit',
    'article': 'article_outline', 'listOrdered': 'list_number_outline', 'cloud': 'cloud_outline', 'file': 'document_outline',
    'pencil': 'write_outline', 'write': 'write_outline@28', 'userPlus': 'user_add_outline', 'contactAdd': 'user_add_outline@56', 'userPen': 'user_pen_outline@28', 'sortName': 'text_asc_outline', 'sortSeen': 'recent_outline', 'users': 'users_outline', 'userCheck': 'user_check_outline',
    'userX': 'user_slash_outline', 'refresh': 'refresh_outline', 'crown': 'crown_outline', 'bell': 'notification_outline',
    'timer': 'clock_circle_dashed_outline', 'shield': 'check_shield_outline', 'upload': 'upload_outline',
    'account': 'user_circle_outline', 'general': 'sliders_vertical_outline', 'folder': 'folder_simple_outline',
    'checkCircle': 'check_circle_outline', 'briefcase': 'briefcase_outline', 'home': 'home_outline', 'heart': 'like_outline',
    'graduation': 'education_outline', 'gamepad': 'game_outline', 'plane': 'plane_outline', 'cart': 'shopping_cart_outline',
    'bot': 'robot_outline', 'rocket': 'rocket', 'globe': 'globe_outline', 'devices': 'computer_smartphone_outline',
    'bug': 'bug_outline', 'laptop': 'laptop_outline', 'smartphone': 'smartphone_outline', 'at': 'mention_outline',
    'cake': 'cake_outline', 'block': 'block_outline', 'moon': 'moon', 'sun': 'sun_outline', 'calendar': 'calendar_outline',
    'copyMedia': 'picture_on_square_outline', 'soundOff': 'mute_outline', 'roundVideo': 'video_circle_outline',
    'bold': 'text_bold_outline', 'italic': 'text_italic_outline', 'underline': 'text_underline_outline',
    'strike': 'text_strikethrough_outline', 'spoiler': 'spoiler_outline',
}

# *Filled where the solid VK glyph is not simply "<outline name without _outline>"
FILLED = {
    'pencilFilled': 'write', 'sendFilled': 'send', 'micFilled': 'voice', 'chatsFilled': 'message', 'contactFilled': 'user',
    'starFilled': 'favorite', 'heartFilled': 'like', 'eyeFilled': 'view', 'eyeOffFilled': 'hide', 'folderFilled': 'folder',
    'bellFilled': 'notification', 'bellOffFilled': 'notification_disable', 'statusFilled': 'story', 'alertFilled': 'error_circle',
    'checkCircleFilled': 'check_circle_on', 'forwardFilled': 'share', 'imageFilled': 'picture', 'videoFilled': 'videocam',
    'settingsFilled': 'settings', 'communityFilled': 'users', 'briefcaseFilled': 'work',
    'gamepadFilled': 'game', 'timerFilled': 'clock', 'soundOffFilled': 'mute', 'volumeOffFilled': 'mute', 'fileFilled': 'document',
    'graduationFilled': 'education', 'banFilled': 'block', 'blockFilled': 'block', 'trashFilled': 'delete',
    'accountFilled': 'user', 'userXFilled': 'user_slash', 'shieldFilled': 'privacy', 'infoFilled': 'info',
    'moreFilled': 'more_vertical', 'cakeFilled': 'cake', 'storageFilled': 'memory_card', 'generalFilled': 'settings', 'playFilled': 'play', 'pauseFilled': 'pause', 'stopFilled': 'stop', 'roundVideoFilled': 'video_circle',
}
# Filled names Relay uses (PACK_FILLED in iconPack.js + kit) — only these get a VK solid variant
SIZES = ('24', '28', '20', '16', '32', '36', '12')


def main(pkg):
    src = os.path.join(pkg, 'src', 'svg')
    def find(name):
        if '@' in name:   # явный размер: «имя@56»
            name, size = name.split('@')
            p = os.path.join(src, size, f'{name}_{size}.svg')
            return p if os.path.exists(p) else None
        for s in SIZES:
            p = os.path.join(src, s, f'{name}_{s}.svg')
            if os.path.exists(p): return p
        return None

    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    pack = open(os.path.join(root, 'packages', 'relay-ui', 'src', 'iconPack.js')).read()
    filled_names = set(re.findall(r'"([a-zA-Z]+Filled)"\s*:', pack)) | set(FILLED)

    out, missing = {}, []
    for ours, vk in MAP.items():
        p = find(vk)
        if p: out[ours] = p
        else: missing.append(f'{ours}→{vk}')
    for f in sorted(filled_names):
        base = MAP.get(f[:-len('Filled')])
        guess = FILLED.get(f) or (base and base.split('@')[0].replace('_outline', ''))
        p = guess and find(guess)
        if p: out[f] = p   # и когда совпадает с обычным (уже залитым): плитки берут имя *Filled

    icons = {}
    for ours, p in sorted(out.items()):
        svg = open(p).read()
        vb = re.search(r'viewBox="([^"]+)"', svg).group(1)
        inner = re.search(r'<svg[^>]*>([\s\S]*)</svg>', svg).group(1).strip()
        # старые файлы из Sketch: комментарий, <title> (стал бы всплывающей подсказкой) и <desc> не нужны
        inner = re.sub(r'<!--[\s\S]*?-->|<title>[\s\S]*?</title>|<desc>[\s\S]*?</desc>', '', inner).strip()
        # ids (clipPath, mask) must be unique on the page
        for i in set(re.findall(r'id="([^"]+)"', inner)):
            inner = inner.replace(f'id="{i}"', f'id="vk-{ours}-{i}"').replace(f'#{i})', f'#vk-{ours}-{i})')
        icons[ours] = [vb, inner]

    lic = open(os.path.join(pkg, 'LICENSE')).read().strip()
    version = json.load(open(os.path.join(pkg, 'package.json')))['version']
    js = ('// Сгенерировано tools/icons/build_vk.py из @vkontakte/icons ' + version + ' — не править руками.\n'
          '// VK_ICONS: имя кита → [viewBox, внутренности SVG] (залитые фигуры, fill currentColor).\n/*\n'
          + lic + '\n*/\n'
          'export var VK_ICONS = ' + json.dumps(icons, ensure_ascii=False, indent=0) + ';\n')
    open(os.path.join(root, 'packages', 'relay-ui', 'src', 'vkIcons.js'), 'w').write(js)
    print(f'{len(icons)} icons ({sum(1 for k in icons if k.endswith("Filled"))} filled) → vkIcons.js, {len(js)//1024} KB')
    if missing: print('not found:', ', '.join(missing))


if __name__ == '__main__':
    main(sys.argv[1])
