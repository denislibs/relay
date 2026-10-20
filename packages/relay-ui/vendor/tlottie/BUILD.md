# tlottie — Lottie-рендерер (WASM)

Источник: [dkaraush/tlottie](https://github.com/dkaraush/tlottie), лицензия MIT (`LICENSE`), коммит в `COMMIT`.
Собрано из исходников, не взято из чужих сборок:

```sh
docker build -f docker/tlottie.Dockerfile -o packages/relay-ui/vendor/tlottie docker
```

- `tlottie.wasm` — `+simd128`, `tlottie-no-simd.wasm` — для браузеров без WASM SIMD.
- Профиль `release-nostd` (`panic = abort`), фичи `wasm,no-std`, без импортов: `WebAssembly.instantiate(bytes, {})`.

## Экспорты, которые используем

| Функция | Что делает |
|---|---|
| `memory` | память модуля |
| `tlottie_alloc(len) → ptr` / `tlottie_free(ptr, len)` | буфер для входного JSON |
| `tlottie_new(ptr, len) → inst` | разбор Lottie JSON (0 — отказ: битый/недоверенный ввод) |
| `tlottie_drop(inst)` | освободить экземпляр |
| `tlottie_width/height(inst) → u32`, `tlottie_frame_rate(inst) → f32`, `tlottie_frame_count(inst) → u32` | размеры и время |
| `tlottie_render(inst, frame: f32, w, h, antialias) → ptr` | кадр `w*h*4` RGBA (без премультипликации), буфер принадлежит экземпляру и перезаписывается следующим вызовом |

## Замер (2026-10-20, Apple silicon, Bun/JSC)

20 случайных стикеров из `apps/server/assets/stickers`, все кадры (3124), 400×400 (200 px при DPR 2), сглаживание включено.

| Сборка | среднее | p95 | максимум |
|---|---|---|---|
| SIMD | 1.36 мс | 2.21 мс | 17.5 мс |
| без SIMD | 1.57 мс | 2.47 мс | 22.5 мс |

Критерий плана (p95 < 4 мс/кадр) выполнен; кадр 60 fps укладывается с запасом в одном воркере.
dotlottie не сравнивали: его WASM привязан к канвасу браузера, а прошлый плеер уходит в задаче 11.
