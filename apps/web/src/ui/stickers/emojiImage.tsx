/** @jsxImportSource preact */
import { reducedMotion } from '@relay/ui';
import { useEffect, useState } from 'preact/hooks';

// Эмодзи в пикере — картинками Apple (public/emoji/apple, см. NOTICE.md) там, где системный шрифт рисует их иначе
// (Windows, Linux, Android). На macOS и iOS тот же рисунок даёт сам шрифт, а глиф дешевле картинки.
const NATIVE = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
const FADE_MS = 200;

/** 😀 → «1f600», 🏳️‍🌈 → «1f3f3-200d-1f308», #️⃣ → «0023-20e3»: код-пойнты через «-», без селектора fe0f. */
export function emojiFile(e: string): string {
  return [...e].map((c) => c.codePointAt(0)!.toString(16).padStart(4, '0')).filter((h) => h !== 'fe0f').join('-');
}

const loaded = new Set<string>();   // уже загружены в этой вкладке — встают сразу, без заглушки и проявления

/**
 * Пока картинка грузится — серый круг на её месте; загрузилась — проявляется, круг гаснет (200 мс). Переход
 * объявлен только на время проявления: на тысяче плиток постоянный transition стоил бы пересчёта стилей.
 * Нет файла для эмодзи (новее набора) — остаётся системный глиф.
 */
export function EmojiGlyph({ e }: { e: string }) {
  const src = `/emoji/apple/${emojiFile(e)}.png`;
  const [state, setState] = useState<'wait' | 'fade' | 'done' | 'fail'>(() => (loaded.has(src) ? 'done' : 'wait'));
  useEffect(() => {
    if (state !== 'fade') return;
    const t = setTimeout(() => setState('done'), FADE_MS + 50);
    return () => clearTimeout(t);
  }, [state]);
  if (NATIVE || state === 'fail') return <>{e}</>;
  const onLoad = () => {
    loaded.add(src);
    if (state !== 'wait') return;
    if (reducedMotion()) setState('done');
    else requestAnimationFrame(() => setState('fade'));
  };
  return (
    <span class={'app-emoji-pic is-' + state}>
      <img src={src} alt={e} width={34} height={34} loading="lazy" decoding="async" draggable={false} onLoad={onLoad} onError={() => setState('fail')} />
    </span>
  );
}
