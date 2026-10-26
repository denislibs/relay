#!/usr/bin/env python3
"""Силуэты реакций для панели «все реакции»: пока картинка грузится, на её месте серый силуэт (как в Telegram).

Из static.webp каждой реакции — альфа-канал, уменьшенный до SIZE×SIZE и порогом сведённый к маске: маленькая
PNG (data: URI) в поле "silhouette" записи reactions.json. Клиент рисует её CSS-маской цветом темы. Каталог
сервера отдаёт поле как есть (apps/server/src/reactions/catalog.ts).

    python3 tools/reactions/silhouettes.py [путь к assets/reactions]

Запускать после обновления ассетов реакций; повторный запуск пересчитывает все силуэты.
"""
import base64, io, json, os, sys
from PIL import Image

SIZE = 48          # 36 px ячейки ×1.33: на 2× экране силуэт виден секунды, чёткость не нужна, вес — нужен
THRESHOLD = 40     # альфа ниже — прозрачно (полупрозрачная тень по краю не входит в силуэт)


def silhouette(path):
    img = Image.open(path).convert('RGBA')
    alpha = img.getchannel('A').resize((SIZE, SIZE), Image.LANCZOS)
    alpha = alpha.point(lambda a: 255 if a >= THRESHOLD else 0)
    mask = Image.new('LA', (SIZE, SIZE), 0)
    mask.putalpha(alpha)
    buf = io.BytesIO()
    mask.save(buf, 'PNG', optimize=True)
    return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode('ascii')


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', '..', 'apps', 'server', 'assets', 'reactions')
    index = os.path.join(root, 'reactions.json')
    with open(index, encoding='utf-8') as f:
        entries = json.load(f)
    done = total = 0
    for e in entries:
        static = os.path.join(root, e.get('slug', ''), (e.get('files') or {}).get('static', ''))
        if not os.path.isfile(static):
            continue
        e['silhouette'] = silhouette(static)
        total += len(e['silhouette'])
        done += 1
    with open(index, 'w', encoding='utf-8') as f:
        json.dump(entries, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print(f'silhouettes: {done}/{len(entries)}, {total // 1024} KB in reactions.json')


if __name__ == '__main__':
    main()
