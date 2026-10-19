// Люди (имя и фото — как их видит зритель) для всей страницы: одна подписка people движка на набор нужных id.
// Движок сам дозапрашивает незнакомых пачкой и присылает переименования; свой профиль — из me, без подписки.
import type { ProfilePhoto } from '@relay/protocol';
import { useEffect } from 'preact/hooks';
import { Mirror } from '@relay/sync-engine/src/client';
import type { Patch, Query } from '@relay/sync-engine/src/types';
import { getGlobal, setGlobal, useGlobal, type Person } from './global';

type Engine = { watch(q: Query, onPatch: (p: Patch) => void): { close(): void } };

let engine: Engine | null = null;
const wanted = new Set<number>();
let scheduled = false;
// подписки по возрастанию номера; live — номер той, что уже прислала данные (старшие ещё ждут первого патча)
let subs: { n: number; w: { close(): void } }[] = [];
let seq = 0, live = 0;

export function startPeople(e: Engine): void {
  engine = e;
  if (wanted.size) schedule();
}

/** Хочу видеть этих людей: id копятся до конца микрозадачи и уходят одной подпиской. */
export function wantPeople(ids: readonly number[]): void {
  const meId = getGlobal().me?.userId;
  let added = false;
  for (const id of ids) if (id && id !== meId && !wanted.has(id)) { wanted.add(id); added = true; }
  if (added) schedule();
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(resubscribe);
}

// новая подписка на весь набор; прежняя закрывается, только когда новая прислала первый патч — люди не мигают
function resubscribe(): void {
  scheduled = false;
  if (!engine) return;
  const n = ++seq, m = new Mirror();
  const w = engine.watch({ kind: 'people', ids: [...wanted] }, (p) => {
    if (n < live) return;   // запоздалый патч уже сменённой подписки
    if (n > live) {
      live = n;
      for (const s of subs) if (s.n < n) s.w.close();
      subs = subs.filter((s) => s.n >= n);
    }
    m.apply(p);
    publish(m.list() as Person[]);
  });
  subs.push({ n, w });
}

const samePhoto = (a: ProfilePhoto | null, b: ProfilePhoto | null) => a === b || JSON.stringify(a) === JSON.stringify(b);

// global.people целиком из зеркала; неизменившийся человек — прежний объект (селекторы не перерисовывают)
function publish(list: Person[]): void {
  const prev = getGlobal().people, next: Record<number, Person> = {};
  for (const it of list) {
    const old = prev[it.id];
    next[it.id] = old && old.name === it.name && samePhoto(old.photo ?? null, it.photo ?? null) ? old : it;
  }
  setGlobal({ people: next });
}

/** Имя и фото человека (как зритель его видит) — селектор, перерисовывает только при изменении этого человека. */
export function usePerson(id: number | null | undefined): { name: string; photo: ProfilePhoto | null } | null {
  useEffect(() => { if (id) wantPeople([id]); }, [id]);
  const me = useGlobal((s) => (id && s.me?.userId === id ? s.me : null));
  const p = useGlobal((s) => (id ? s.people[id] : undefined));
  if (me) return { name: me.name, photo: me.photo ?? null };
  return p ? { name: p.name, photo: p.photo ?? null } : null;
}

/** Имя для не-компонентов (уведомления, превью); ещё не знаем — пусто. */
export function personName(id: number): string {
  const g = getGlobal();
  if (g.me?.userId === id) return g.me.name;
  return g.people[id]?.name ?? '';
}
