# Узоры обоев

Генератор дудлов для `apps/web/public/patterns/` (SVG 1200×1200, бесшовные, чёрные линии на прозрачном, 3 `<path>` на узор).

- `gen_v4.py`: рисунки (`ICONS`, `SMALL`, `TINY`) и помощники.
- `gen_v5.py`: темы `T` (15 наборов).
- `gen_v6.py`: плотная раскладка. Пять ярусов размеров, от «героев» до мелочи. Столкновения считаются по сетке занятости с повёрнутыми рамками рисунков. Зазоры 6–8 px, промежутки заполняются уменьшенными рисунками.
- `optimize.py`: склеивает узор в 3 пути, прогоняет svgo, сжимает gzip (`.tgv`). Обводка 2.1: на экране плитка 640 px.

```bash
pip install svgelements        # и svgo: npm i -g svgo (или bunx svgo)
python gen_v6.py               # → out/v6/raw/*.svg   (python gen_v6.py 01_cute_mix — только одну тему)
python optimize.py out/v6/raw out/v6
```

Готовые `out/v6/<имя>.svg` и `.tgv` копируются в `apps/web/public/patterns/<id>.svg` и `<id>.svg.gz`. Новый набор нужно ещё вписать в `PATTERN_FILES` (`packages/relay-ui/src/more.js`) и `PATTERN_NAMES` (`apps/web/src/wallpapers.ts`).
