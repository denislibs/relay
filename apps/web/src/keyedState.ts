import { useState } from 'preact/hooks';

/**
 * Состояние, привязанное к ключу (чат, собеседник, путь). useState с кэшем в инициализаторе сбрасывался на новый
 * ключ только в useEffect — то есть после первой отрисовки: на кадр компонент показывал данные прежнего чата
 * (вкладки медиа чужого профиля, участников прежней группы). Здесь сменился ключ — сразу значение для нового:
 * из кэша, а нет его — read вернёт «ещё не знаем», и компонент покажет загрузку.
 */
export function useKeyedState<K, V>(key: K, read: (k: K) => V): [V, (next: V | ((prev: V) => V)) => void] {
  const [st, setSt] = useState(() => ({ key, v: read(key) }));
  const set = (next: V | ((prev: V) => V)) => setSt((s) => keyedNext(s, key, read, next));
  return [keyedValue(st, key, read), set];
}

type Keyed<K, V> = { key: K; v: V };
/** Значение для ключа: своё — из состояния, чужое (ключ сменился) — read(key). */
export function keyedValue<K, V>(st: Keyed<K, V>, key: K, read: (k: K) => V): V {
  return Object.is(st.key, key) ? st.v : read(key);
}
/** Новое состояние: записывается всегда под текущим ключом; функция-обновитель видит значение этого ключа. */
export function keyedNext<K, V>(st: Keyed<K, V>, key: K, read: (k: K) => V, next: V | ((prev: V) => V)): Keyed<K, V> {
  return { key, v: typeof next === 'function' ? (next as (p: V) => V)(keyedValue(st, key, read)) : next };
}
