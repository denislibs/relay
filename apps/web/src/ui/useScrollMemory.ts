import { useLayoutEffect, useRef } from 'preact/hooks';
import { recallScroll, rememberScroll } from '../nav';

/** Запоминает scrollTop страницы по пути и возвращает его при повторном монтировании. */
export function useScrollMemory(path: string) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (ref.current) ref.current.scrollTop = recallScroll(path); }, [path]);
  return { ref, onScroll: (e: Event) => rememberScroll(path, (e.currentTarget as HTMLElement).scrollTop) };
}
