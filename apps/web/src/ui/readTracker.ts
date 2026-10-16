import { useEffect, useRef } from 'preact/hooks';
import { seen } from '../data';

/**
 * Сообщает движку «вижу до id N», когда сообщение реально на экране:
 * ≥60% в области ленты, вкладка видна и в фокусе, лента спокойна 300 мс.
 * Решение «отметить прочитанным» и схлопывание — в воркере.
 */
export function useReadTracker(chatId: number, feed: { current: HTMLElement | null }, version: unknown): void {
  const visible = useRef(new Map<Element, number>());
  const io = useRef<IntersectionObserver | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const report = () => {
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
      let max = 0;
      for (const id of visible.current.values()) if (id > max) max = id;
      if (max) seen(chatId, max);
    };
    const schedule = () => { clearTimeout(timer.current); timer.current = setTimeout(report, 300); };
    io.current = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const id = Number((e.target as HTMLElement).dataset.msgId);
        if (id && e.intersectionRatio >= 0.6) visible.current.set(e.target, id);
        else visible.current.delete(e.target);
      }
      schedule();
    }, { root: feed.current, threshold: [0, 0.6] });
    window.addEventListener('focus', schedule);
    document.addEventListener('visibilitychange', schedule);
    return () => {
      io.current?.disconnect();
      clearTimeout(timer.current);
      window.removeEventListener('focus', schedule);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [chatId]);

  // после каждого рендера ленты — наблюдать новые строки
  useEffect(() => {
    const root = feed.current;
    if (!root || !io.current) return;
    root.querySelectorAll<HTMLElement>('[data-msg-id]').forEach((el) => io.current!.observe(el));
  }, [version]);
}
