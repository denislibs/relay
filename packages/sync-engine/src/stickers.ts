// Стикеры в движке: мои паки / недавние / избранные и сами паки — с кэшем в IndexedDB (meta), чтобы панель
// открывалась без сети. Изменения (добавить пак, избранное, очистить недавние) — через очередь операций:
// без сети применяются сразу у себя и уходят на сервер позже; журнал ({type:'myStickers'}) двигает stickersRev.
import type { MyStickers, StickerRef, StickerSet, StickerSetInfo } from '@relay/protocol';
import { FAVED_STICKERS_LIMIT, RECENT_STICKERS_LIMIT } from '@relay/protocol';
import type { Action } from './types';
import { req } from './idb';
import type { OpSpec } from './ops';

export type StickersAction = Extract<Action, { type: 'myStickers' | 'stickerSet' | 'installStickerSet' | 'faveSticker' | 'clearRecentStickers' | 'featuredStickerSets' | 'searchStickerSets' | 'stickersByEmoji' | 'greetingSticker' }>;

export interface StickersHost {
  db: IDBDatabase;
  online(): boolean;
  http<T>(path: string): Promise<T>;
  enqueue(op: OpSpec): Promise<void>;
  bump(): void;   // stickersRev++ и changed(): интерфейс перечитает мои стикеры
}

const MINE = 'stickers:mine';
const setKey = (id: number | string) => 'stickers:set:' + id;
const EMPTY: MyStickers = { sets: [], recent: [], faved: [] };

export class Stickers {
  private mine: MyStickers | null = null;
  private sets = new Map<string, StickerSet>();   // id и short name → пак (то, что уже открывали)
  // свои изменения, которые сервер ещё не подтвердил: накладываются на его ответ, иначе кнопка «мигает» назад
  private installs = new Map<number, { on: boolean; info?: StickerSetInfo; at: number }>();
  private faves = new Map<number, { on: boolean; sticker?: StickerRef; at: number }>();
  private unrecent = new Map<number | 'all', number>();

  constructor(private h: StickersHost) {}

  private async load<T>(k: string): Promise<T | null> {
    const row = await req(this.h.db.transaction('meta').objectStore('meta').get(k)) as { k: string; v: T } | undefined;
    return row ? row.v : null;
  }
  private save(k: string, v: unknown): void {
    void req(this.h.db.transaction('meta', 'readwrite').objectStore('meta').put({ k, v })).catch(() => {});
  }

  private async cachedMine(): Promise<MyStickers> {
    this.mine ??= (await this.load<MyStickers>(MINE)) ?? null;
    return this.mine ?? EMPTY;
  }
  private setMine(m: MyStickers, persist = true): void {
    this.mine = m;
    if (persist) this.save(MINE, m);
  }

  /** Отправили стикер: наверх недавних сразу, не дожидаясь журнала. */
  async bumpRecent(s: StickerRef): Promise<void> {
    const m = await this.cachedMine();
    this.setMine({ ...m, recent: [s, ...m.recent.filter((x) => x.id !== s.id)].slice(0, RECENT_STICKERS_LIMIT) });
    this.h.bump();
  }

  async act(a: StickersAction): Promise<unknown> {
    switch (a.type) {
      case 'myStickers': {
        const cached = await this.cachedMine();
        if (!this.h.online()) return { ...cached, offline: true };
        try {
          const fresh = this.overlay(await this.h.http<MyStickers>('/my-stickers'));
          this.setMine(fresh);
          return fresh;
        } catch { return { ...cached, offline: true }; }
      }
      case 'stickerSet': {
        const id = String(a.id);
        let hit = this.sets.get(id) ?? (await this.load<StickerSet>(setKey(id)));
        if (hit && (a.hash == null || hit.hash === a.hash)) { this.sets.set(id, hit); return hit; }
        if (!this.h.online()) return hit ?? null;
        try {
          const set = await this.h.http<StickerSet>(`/sticker-sets/${encodeURIComponent(id)}`);
          for (const k of [String(set.id), set.shortName]) { this.sets.set(k, set); this.save(setKey(k), set); }
          return set;
        } catch { return hit ?? null; }
      }
      case 'installStickerSet': {
        this.installs.set(a.setId, { on: a.on, info: a.info, at: Date.now() });
        const m = await this.cachedMine();
        if (!a.on) this.setMine({ ...m, sets: m.sets.filter((s) => s.id !== a.setId) });
        else if (a.info && !m.sets.some((s) => s.id === a.setId)) this.setMine({ ...m, sets: [a.info as StickerSetInfo, ...m.sets] });
        this.h.bump();
        await this.h.enqueue({ key: 'stickers:set:' + a.setId, method: 'POST', path: '/my-stickers/sets', body: { setId: a.setId, on: a.on } });
        return null;
      }
      case 'faveSticker': {
        this.faves.set(a.id, { on: a.on, sticker: a.sticker, at: Date.now() });
        const m = await this.cachedMine();
        const faved = a.on && a.sticker ? [a.sticker, ...m.faved.filter((x) => x.id !== a.id)].slice(0, FAVED_STICKERS_LIMIT) : m.faved.filter((x) => x.id !== a.id);
        this.setMine({ ...m, faved });
        this.h.bump();
        await this.h.enqueue({ key: 'stickers:fave:' + a.id, method: 'POST', path: '/my-stickers/faved', body: { id: a.id, on: a.on } });
        return null;
      }
      case 'clearRecentStickers': {
        this.unrecent.set(a.id ?? 'all', Date.now());
        const m = await this.cachedMine();
        this.setMine({ ...m, recent: a.id != null ? m.recent.filter((x) => x.id !== a.id) : [] });
        this.h.bump();
        await this.h.enqueue({ key: 'stickers:recent:' + (a.id ?? 'all'), method: 'DELETE', path: '/my-stickers/recent' + (a.id != null ? `?id=${a.id}` : '') });
        return null;
      }
      case 'featuredStickerSets':
        if (!this.h.online()) return [];
        return this.h.http<StickerSetInfo[]>(`/sticker-sets/featured?offset=${a.offset ?? 0}`).catch(() => []);
      case 'searchStickerSets':
        if (!this.h.online()) return [];
        return this.h.http<StickerSetInfo[]>(`/sticker-sets/search?q=${encodeURIComponent(a.q)}`).catch(() => []);
      case 'stickersByEmoji': {
        const local = () => this.localByEmoji(a.emoji);
        if (!this.h.online()) return local();
        return this.h.http<StickerRef[]>(`/stickers-by-emoji?e=${encodeURIComponent(a.emoji)}`).catch(local);
      }
      case 'greetingSticker':
        // каждый раз новый случайный: запоминает выбранный интерфейс (на время открытого чата)
        if (!this.h.online()) return null;
        return this.h.http<StickerRef>('/stickers/greeting').catch(() => null);
    }
  }

  /** Ответ сервера + ещё не подтверждённые свои изменения. Подтверждённое (или старше минуты) забываем. */
  private overlay(m: MyStickers): MyStickers {
    const stale = Date.now() - 60_000;
    let { sets, recent, faved } = m;
    for (const [id, o] of this.installs) {
      const has = sets.some((s) => s.id === id);
      if (has === o.on || o.at < stale) { this.installs.delete(id); continue; }
      sets = o.on ? (o.info ? [o.info, ...sets] : sets) : sets.filter((s) => s.id !== id);
    }
    for (const [id, o] of this.faves) {
      const has = faved.some((s) => s.id === id);
      if (has === o.on || o.at < stale) { this.faves.delete(id); continue; }
      faved = o.on ? (o.sticker ? [o.sticker, ...faved].slice(0, FAVED_STICKERS_LIMIT) : faved) : faved.filter((s) => s.id !== id);
    }
    for (const [id, at] of this.unrecent) {
      const left = id === 'all' ? recent.length > 0 : recent.some((s) => s.id === id);
      if (!left || at < stale) { this.unrecent.delete(id); continue; }
      recent = id === 'all' ? [] : recent.filter((s) => s.id !== id);
    }
    return { sets, recent, faved };
  }

  /** Без сети: по эмодзи из недавних и уже открытых паков. */
  private async localByEmoji(emoji: string): Promise<StickerRef[]> {
    const e = emoji.replace(/️/g, '');
    const m = await this.cachedMine();
    const seen = new Set<number>(), out: StickerRef[] = [];
    for (const s of [...m.recent, ...[...this.sets.values()].flatMap((x) => x.stickers)]) {
      if (s.emoji.replace(/️/g, '') === e && !seen.has(s.id)) { seen.add(s.id); out.push(s); }
    }
    return out;
  }
}
