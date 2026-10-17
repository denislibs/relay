import { requestMeasure } from '@relay/ui';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { recallScroll, rememberScroll } from '../nav';

/** Запоминает scrollTop страницы по пути и возвращает его при повторном монтировании. */
export function useScrollMemory(path: string) {
  const ref = useRef<HTMLDivElement>(null);
  const queued = useRef(false);
  useLayoutEffect(() => { if (ref.current) ref.current.scrollTop = recallScroll(path); }, [path]);
  // scrollTop читаем в фазе замера кадра: в обработчике прокрутки после записей это был бы принудительный layout
  const onScroll = (e: Event) => {
    const el = e.currentTarget as HTMLElement;
    if (queued.current) return;
    queued.current = true;
    requestMeasure(() => { queued.current = false; rememberScroll(path, el.scrollTop); });
  };
  return { ref, onScroll };
}
