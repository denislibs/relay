import type { Me, PublicUser, UserPhoto } from '@relay/protocol';
import { getAll } from './idb';
import type { PendingOp } from './ops';
import { Table, type Row } from './rows';
import type { Store } from './store';
import type { Item, Query } from './types';

/** Предел хранения: музыки и фото профиля — по 100 на человека (сервер больше и не отдаёт). */
export const PROFILE_LIST_MAX = 100;

/** Ключ операций музыки профиля: добавление и удаление одного трека схлопываются (music:<attId>). */
export const OP_MUSIC = 'music:';
export const musicKey = (attId: string) => OP_MUSIC + attId;

export type ProfileTrack = { id: string; title: string; duration: number | null; mime: string; addedAt: string };
export type MusicRow = { userId: number; attId: string; title: string; duration: number | null; mime: string; addedAt: string };
export type PhotoRow = UserPhoto & { userId: number };
type Kind = 'm' | 'p';
/** Трек для оптимистичной строки: лежит в теле операции рядом с chatId/messageId (сервер читает только их). */
type AddBody = { chatId: number; messageId: number; track?: { id: string; title: string; duration: number | null; mime: string } };

/** Строки одного списка по людям: таблица (ключ userId:id) и индекс по человеку. */
class PerUser<T extends { userId: number }> {
  readonly table = new Table<string, T>();
  private byUser = new Map<number, Set<string>>();
  constructor(private id: (r: T) => string | number) {}

  key(r: T): string { return r.userId + ':' + this.id(r); }
  load(rows: (T & { seq: number })[]): void {
    this.table.load(rows, (r) => this.key(r));
    for (const r of rows) this.keys(r.userId).add(this.key(r));
  }
  private keys(userId: number): Set<string> {
    let s = this.byUser.get(userId);
    if (!s) { s = new Set(); this.byUser.set(userId, s); }
    return s;
  }
  rows(userId: number): Row<T>[] { return [...(this.byUser.get(userId) ?? [])].map((k) => this.table.get(k)!).filter(Boolean); }

  /** Снимок списка человека: кого нет — убрать. true — что-то изменилось. */
  apply(userId: number, list: T[]): boolean {
    const keep = new Set<string>();
    let changed = false;
    for (const r of list) { const k = this.key(r); keep.add(k); this.keys(userId).add(k); if (this.table.put(k, r, 0)) changed = true; }
    for (const k of [...(this.byUser.get(userId) ?? [])]) if (!keep.has(k)) { this.table.delete(k); this.byUser.get(userId)!.delete(k); changed = true; }
    return changed;
  }

  /** Ключи IndexedDB — [userId, id]. */
  collect(num: boolean): { put: unknown[]; del: [number, string | number][] } {
    const { put, del } = this.table.collect();
    return { put, del: del.map((k) => { const i = k.indexOf(':'), id = k.slice(i + 1); return [Number(k.slice(0, i)), num ? Number(id) : id]; }) };
  }
  clear(): void { this.table.clear(); this.byUser.clear(); }
}

/** Сводка, по которой видно, что список устарел: музыка — число и последний трек, фото — главное фото. undefined — человека не знаем. */
export function summarySig(store: Store, kind: Kind, userId: number): string | undefined {
  const u: Pick<PublicUser, 'music' | 'photo'> | null | undefined = userId === store.userId ? store.profile.me : store.users.get(userId);
  if (!u) return undefined;
  if (kind === 'm') return u.music ? u.music.count + ':' + u.music.top.id : '0';
  return u.photo ? String(u.photo.pid ?? u.photo.id) : '';
}
const tracksSig = (t: ProfileTrack[]) => (t.length ? t.length + ':' + t[0].id : '0');

/**
 * Музыка и фото профиля: строки в IndexedDB (profileMusic, profilePhotos), в памяти — таблицы и индекс по человеку.
 * База — последний ответ сервера (GET /users/:id/music, /photos; для своей музыки — и ответ операции).
 * marks (meta profileLists) — список загружали и при какой сводке: сводка в профиле сменилась (userUpdated) — список устарел.
 */
export class ProfileLists {
  readonly music = new PerUser<MusicRow>((r) => r.attId);
  readonly photos = new PerUser<PhotoRow>((r) => r.pid);
  /** списки ('m:id' / 'p:id'), изменившиеся с последнего прохода подписок */
  readonly touched = new Set<string>();
  /** запрос в пути */
  readonly loading = new Set<string>();
  /** сводка, при которой список загружен; null — человека тогда не знали */
  private marks = new Map<string, string | null>();
  private totals = new Map<number, number>();
  /** растёт при каждой новой базе списка (только в памяти): ответ, начатый раньше, уже устарел */
  private gens = new Map<string, number>();
  private persist = false;

  static async load(db: IDBDatabase, meta: { k: string; v: unknown }[]): Promise<ProfileLists> {
    const c = new ProfileLists();
    c.music.load(await getAll<MusicRow & { seq: number }>(db, 'profileMusic'));
    c.photos.load(await getAll<PhotoRow & { seq: number }>(db, 'profilePhotos'));
    const v = meta.find((m) => m.k === 'profileLists')?.v as { marks: [string, string | null][]; totals: [number, number][] } | undefined;
    for (const [k, s] of v?.marks ?? []) c.marks.set(k, s);
    for (const [id, n] of v?.totals ?? []) c.totals.set(id, n);
    return c;
  }

  loaded(tag: string): boolean { return this.marks.has(tag); }
  gen(tag: string): number { return this.gens.get(tag) ?? 0; }
  total(userId: number): number | null { return this.totals.get(userId) ?? null; }
  /** Загружен и сводка с тех пор сменилась. */
  stale(store: Store, kind: Kind, userId: number): boolean {
    const tag = kind + ':' + userId, cur = summarySig(store, kind, userId);
    return this.marks.has(tag) && cur !== undefined && this.marks.get(tag) !== cur;
  }

  private based(tag: string, sig: string | null): void {
    this.gens.set(tag, this.gen(tag) + 1);
    this.marks.set(tag, sig);
    this.persist = true;
    this.touched.add(tag);
  }

  applyMusic(userId: number, tracks: ProfileTrack[], sig: string | null = tracksSig(tracks)): void {
    this.music.apply(userId, tracks.slice(0, PROFILE_LIST_MAX).map((t) => ({ userId, attId: t.id, title: t.title, duration: t.duration ?? null, mime: t.mime, addedAt: t.addedAt })));
    this.based('m:' + userId, sig);
  }

  applyPhotos(userId: number, photos: UserPhoto[], total: number, sig: string | null): void {
    this.photos.apply(userId, photos.slice(0, PROFILE_LIST_MAX).map((p) => ({ userId, pid: p.pid, id: p.id, small: p.small, thumb: p.thumb, at: p.at, ...(p.video ? { video: p.video } : {}) })));
    this.totals.set(userId, total);
    this.based('p:' + userId, sig);
  }

  /** Сводка человека сменилась (userUpdated): список пересчитать, движок перечитает его, если на него подписаны. */
  noteSummary(kind: Kind, userId: number): void { this.touched.add(kind + ':' + userId); }

  /** Что дописать в транзакцию flush. */
  collect(): { music: { put: unknown[]; del: [number, string | number][] }; photos: { put: unknown[]; del: [number, string | number][] }; meta: { k: string; v: unknown } | null } {
    const meta = this.persist ? { k: 'profileLists', v: { marks: [...this.marks], totals: [...this.totals] } } : null;
    this.persist = false;
    return { music: this.music.collect(false), photos: this.photos.collect(true), meta };
  }

  reset(): void {
    for (const k of [...this.marks.keys(), ...this.loading]) this.touched.add(k);
    this.music.clear(); this.photos.clear(); this.marks.clear(); this.totals.clear(); this.loading.clear();
    for (const k of this.gens.keys()) this.gens.set(k, this.gen(k) + 1);
  }
}

/** userUpdated: сводка музыки или главное фото сменились — отметить списки человека (до и после применения профиля). */
export function noteSummaries(store: Store, userId: number, before: [string | undefined, string | undefined]): void {
  if (summarySig(store, 'm', userId) !== before[0]) store.profileLists.noteSummary('m', userId);
  if (summarySig(store, 'p', userId) !== before[1]) store.profileLists.noteSummary('p', userId);
}

type MusicView = MusicRow & { pending: boolean };

/** Своя музыка, как её видит интерфейс: база + очередь (POST — трек сверху, DELETE — без него). */
export function musicView(base: MusicRow[], ops: readonly PendingOp[], userId: number): MusicView[] {
  const view = new Map<string, MusicView>(base.map((r) => [r.attId, { ...r, pending: false }]));
  for (const op of ops) {
    if (!op.key.startsWith(OP_MUSIC)) continue;
    const attId = op.key.slice(OP_MUSIC.length);
    if (op.method === 'DELETE') { view.delete(attId); continue; }
    const t = (op.body as AddBody | undefined)?.track;
    if (t && !view.has(attId)) view.set(attId, { userId, attId, title: t.title, duration: t.duration, mime: t.mime, addedAt: new Date(op.at).toISOString(), pending: true });
  }
  return [...view.values()].sort((a, b) => (a.addedAt < b.addedAt ? 1 : a.addedAt > b.addedAt ? -1 : a.attId < b.attId ? 1 : -1)).slice(0, PROFILE_LIST_MAX);
}

type Result = { items: Map<string, Item>; order: string[]; sig: Map<string, string> };
function result(list: Item[]): Result {
  return { items: new Map(list.map((it) => [it.key, it])), order: list.map((it) => it.key), sig: new Map(list.map((it) => [it.key, JSON.stringify(it)])) };
}

/** Подписка profileMusic: треки новые сверху (свои — с очередью), служебный ~profileMusic {loaded, loading}. */
export function profileMusicResult(store: Store, userId: number, ops: readonly PendingOp[], loading: boolean): Result {
  const rows = store.profileLists.music.rows(userId);
  const list: Item[] = musicView(rows, userId === store.userId ? ops : [], userId)
    .map((r) => ({ key: r.attId, attId: r.attId, title: r.title, duration: r.duration, mime: r.mime, addedAt: r.addedAt, pending: r.pending }));
  list.push({ key: '~profileMusic', loaded: store.profileLists.loaded('m:' + userId), loading });
  return result(list);
}

/** Подписка profilePhotos: главное фото первым, дальше новые сверху; служебный ~profilePhotos {loaded, loading, total}. */
export function profilePhotosResult(store: Store, userId: number, me: Me | null, loading: boolean): Result {
  const u = userId === store.userId ? me : store.users.get(userId);
  const main = u?.photo?.pid;
  const rows = store.profileLists.photos.rows(userId).sort((a, b) => Number(b.pid === main) - Number(a.pid === main) || b.at - a.at || b.pid - a.pid);
  const list: Item[] = rows.slice(0, PROFILE_LIST_MAX).map((r) => ({ key: String(r.pid), pid: r.pid, id: r.id, small: r.small, thumb: r.thumb, at: r.at, ...(r.video ? { video: r.video } : {}) }));
  list.push({ key: '~profilePhotos', loaded: store.profileLists.loaded('p:' + userId), loading, total: store.profileLists.total(userId) });
  return result(list);
}

type ListQuery = Extract<Query, { kind: 'profileMusic' | 'profilePhotos' }>;
const kindOf = (q: ListQuery): Kind => (q.kind === 'profileMusic' ? 'm' : 'p');

/**
 * Загрузка списков для подписок: не загружен или устарел (сводка сменилась) — один запрос на человека и список.
 * Сводка, при которой уже спрашивали, за это подключение второй раз не спрашивается (и отказ тоже) — без повторов по кругу.
 */
export class ProfileListsLoader {
  private asked = new Set<string>();

  constructor(private store: Store, private deps: {
    online: () => boolean;
    http: <T>(path: string) => Promise<T>;
    run: (fn: () => Promise<unknown>) => void;
    changed: () => void;
  }) {}

  loading(q: ListQuery): boolean { return this.store.profileLists.loading.has(kindOf(q) + ':' + q.userId); }

  /** Новое подключение: прошлые запросы и отказы — спросим снова, если понадобится. */
  reconnect(): void { this.asked.clear(); }

  want(q: ListQuery): void {
    const lists = this.store.profileLists, kind = kindOf(q), userId = q.userId, tag = kind + ':' + userId;
    if (!this.deps.online() || lists.loading.has(tag)) return;
    if (lists.loaded(tag) && !lists.stale(this.store, kind, userId)) return;
    const sig = summarySig(this.store, kind, userId) ?? null;
    const asked = tag + '|' + sig;
    if (this.asked.has(asked)) return;
    this.asked.add(asked);
    lists.loading.add(tag);
    lists.touched.add(tag);
    const gen = lists.gen(tag), reset = this.store.resetGen;
    // ответ, начатый до новой базы (ответ операции, сброс), не откатывает её
    const fresh = () => lists.gen(tag) === gen && this.store.resetGen === reset;
    this.deps.run(async () => {
      try {
        if (kind === 'm') {
          const r = await this.deps.http<{ tracks: ProfileTrack[] }>(`/users/${userId}/music`);
          if (fresh()) lists.applyMusic(userId, r.tracks, sig);
        } else {
          const r = await this.deps.http<{ photos: UserPhoto[]; total: number }>(`/users/${userId}/photos?limit=${PROFILE_LIST_MAX}`);
          if (fresh()) lists.applyPhotos(userId, r.photos, r.total, sig);
        }
        await this.store.flush();
      } finally {
        lists.loading.delete(tag);
        lists.touched.add(tag);
        this.deps.changed();
      }
    });
  }

  /** Ответ операции музыки — новая база своего списка. false — не наша операция. */
  opDone(op: PendingOp, value: unknown): boolean {
    if (!op.key.startsWith(OP_MUSIC)) return false;
    const v = value as { tracks?: ProfileTrack[] } | null;
    if (v && Array.isArray(v.tracks)) {
      this.store.profileLists.applyMusic(this.store.userId, v.tracks);
      this.deps.run(() => this.store.flush());
    }
    return true;
  }
}

/** Трек из сообщения для оптимистичной строки — как его назовёт сервер (имя файла без расширения). */
export function trackOf(store: Store, chatId: number, messageId: number): AddBody['track'] | null {
  const a = store.messageById(chatId, messageId)?.attachment;
  if (!a || a.kind !== 'audio') return null;
  return { id: a.id, title: a.name.replace(/\.[^.]{1,5}$/, '').slice(0, 200), duration: a.duration ?? null, mime: a.mime };
}
