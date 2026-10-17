import { Button, ChatRowSkeleton, ConfirmDialog, EmptyState, InfoRow, Menu, Modal, PanelHeader, Presence, SelectRow, Section, reducedMotion, useMinVisible } from '@relay/ui';
import type { SessionInfo } from '@relay/protocol';
import { sessionsView } from '@relay/sync-engine/src/sessions';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useGlobal } from '../../global';
import { back } from '../../nav';
import { loadSessions, registerPrefetch, setSessionsTtl, terminateOtherSessions, terminateSession } from '../../settingsData';
import { fullDateTime, sessionTime } from '../format';

// список берётся с сервера по запросу: на главной странице настроек и при наведении на строку раздела
registerPrefetch('settings/sessions', () => { void loadSessions(); });

const TTL_OPTIONS = [
  { value: 7, label: '1 неделю' },
  { value: 30, label: '1 месяц' },
  { value: 90, label: '3 месяца' },
  { value: 180, label: '6 месяцев' },
  { value: 365, label: '1 год' },
];

type Tile = 'blue' | 'orange' | 'red' | 'gray' | 'green' | 'purple';
/** Плитка по браузеру, значок — телефон или компьютер (по ОС). */
function deviceLook(device: string): { icon: string; tile: Tile } {
  const icon = /iOS|Android/.test(device) ? 'smartphone' : 'laptop';
  const tile: Tile = /^Chrome/.test(device) ? 'green' : /^(Safari|Edge)/.test(device) ? 'blue' : /^Firefox/.test(device) ? 'orange' : /^(Opera|Яндекс)/.test(device) ? 'red' : 'gray';
  return { icon, tile };
}

/** Строки, ушедшие из списка, ещё ms держатся на месте и схлопываются по высоте (а не пропадают рывком). */
function useLeaving<T>(items: T[], key: (t: T) => string, ms: number): { item: T; key: string; leaving: boolean }[] {
  const prev = useRef<{ item: T; key: string }[]>([]);
  const leaving = useRef(new Map<string, { item: T; after: string | null }>());
  const [, force] = useState(0);
  const keys = new Set(items.map(key));
  prev.current.forEach((p, i) => {
    if (!keys.has(p.key) && !leaving.current.has(p.key) && ms > 0) leaving.current.set(p.key, { item: p.item, after: i > 0 ? prev.current[i - 1].key : null });
  });
  for (const k of [...leaving.current.keys()]) if (keys.has(k)) leaving.current.delete(k);
  const out: { item: T; key: string; leaving: boolean }[] = items.map((item) => ({ item, key: key(item), leaving: false }));
  for (const [k, v] of leaving.current) {
    const at = v.after == null ? 0 : out.findIndex((o) => o.key === v.after) + 1;
    out.splice(at > 0 || v.after == null ? at : out.length, 0, { item: v.item, key: k, leaving: true });
  }
  prev.current = out.filter((o) => !o.leaving).map(({ item, key }) => ({ item, key }));
  const n = leaving.current.size;
  useEffect(() => {
    if (!n) return;
    const t = setTimeout(() => { leaving.current.clear(); force((x) => x + 1); }, ms);
    return () => clearTimeout(t);
  }, [n]);
  return out;
}

/** «Активные сеансы»: это устройство, другие сеансы (меню строки и детали), автозавершение неактивных. */
export function Sessions() {
  const raw = useGlobal((s) => s.sessions);
  const offline = useGlobal((s) => s.sessionsOffline);
  const keys = useGlobal((s) => s.opsKeys);
  const ttl = useGlobal((s) => s.settings.sessionsTtlDays);
  const phase = useGlobal((s) => s.status.phase);
  const [menu, setMenu] = useState<{ x: number; y: number; id: number } | null>(null);
  const [details, setDetails] = useState<SessionInfo | null>(null);
  const [askAll, setAskAll] = useState(false);

  // при каждом открытии — свежий список («в сети», последняя активность); пока он идёт, на экране прежний
  useEffect(() => { void loadSessions(true); }, []);
  // связь вернулась — догружаем то, что не дошло без сети
  useEffect(() => { if (phase === 'ready' && offline) void loadSessions(true); }, [phase, offline]);
  useEffect(() => {
    if (!details) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDetails(null); } };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, [details]);

  const list = raw ? sessionsView(raw, keys) : null;
  const waiting = list == null && !offline;
  const skeleton = useMinVisible(waiting, { delay: 150, min: 600 });
  const current = list?.find((s) => s.current) ?? null;
  const others = list?.filter((s) => !s.current) ?? [];
  const ms = reducedMotion() ? 0 : 220;
  const rows = useLeaving(others, (s) => String(s.id), ms);
  const allRow = useLeaving(others.length ? ['all'] : [], (k) => k, ms);

  const end = (id: number) => { setMenu(null); setDetails(null); void terminateSession(id); };

  return (
    <div class="rl-sidepage" aria-label="Активные сеансы">
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title="Активные сеансы" onClose={() => void back()} />
      <div class="rl-settings">
        <div class="app-listwrap">
          <Presence show={skeleton} exitMs={280}>
            <div class="app-skel" aria-busy="true" aria-label="Загрузка сеансов">
              <Section title="Это устройство">{[0].map((i) => <div key={i} style={{ '--i': i }}><ChatRowSkeleton /></div>)}</Section>
              <Section title="Активные сеансы">{[1, 2].map((i) => <div key={i} style={{ '--i': i }}><ChatRowSkeleton /></div>)}</Section>
            </div>
          </Presence>
          {waiting || skeleton ? null : !list ? (
            <EmptyState title="Нет сети" text="Список сеансов загрузится, когда появится подключение." />
          ) : (
            <div>
              {current ? (
                <Section title="Это устройство">
                  <InfoRow {...deviceLook(current.device)} title={current.device} subtitle={(current.ip ? current.ip + ' · ' : '') + 'в сети'} onClick={() => setDetails(current)} />
                  {allRow.map((r) => (
                    <div key={r.key} class={'app-collapse' + (r.leaving ? ' app-collapse-out' : '')}>
                      <div><InfoRow icon="logout" danger title="Завершить все другие сеансы" onClick={() => setAskAll(true)} /></div>
                    </div>
                  ))}
                </Section>
              ) : null}
              {rows.length ? (
                <Section title="Активные сеансы">
                  <div role="list">
                    {rows.map(({ item: s, key, leaving }) => (
                      <div key={key} role="listitem" class={'app-collapse' + (leaving ? ' app-collapse-out' : '')}
                        onContextMenu={(e) => { e.preventDefault(); if (!leaving) setMenu({ x: e.clientX, y: e.clientY, id: s.id }); }}>
                        <div>
                          <InfoRow {...deviceLook(s.device)} title={s.device} subtitle={s.ip ?? ''} value={s.online ? 'в сети' : sessionTime(s.lastActiveAt)} onClick={() => { if (!leaving) setDetails(s); }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </Section>
              ) : null}
              <Section title="Автоматически завершать сеансы">
                <SelectRow label="Если не активен" value={ttl} options={TTL_OPTIONS} onChange={(v: number) => { if (Number(v) !== ttl) void setSessionsTtl(Number(v)); }} />
              </Section>
            </div>
          )}
        </div>
      </div>
      {menu ? (
        <>
          <div class="rl-msgmenu-scrim" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div class="rl-msgmenu" style={{ left: Math.min(menu.x, innerWidth - 240), top: Math.min(menu.y, innerHeight - 80) }}>
            <Menu label="Действия" onClose={() => setMenu(null)} items={[{ icon: 'logout', label: 'Завершить', danger: true, onClick: () => end(menu.id) }]} />
          </div>
        </>
      ) : null}
      {details ? (
        <Modal title={details.device} onClose={() => setDetails(null)} actions={details.current ? null : (
          <Button variant="danger" onClick={() => end(details.id)}>Завершить сеанс</Button>
        )}>
          <dl class="app-session-info">
            <dt>Устройство</dt><dd>{details.device}</dd>
            <dt>IP</dt><dd>{details.ip ?? '—'}</dd>
            <dt>Вход</dt><dd>{fullDateTime(details.createdAt)}</dd>
            <dt>Последняя активность</dt><dd>{details.online ? 'в сети' : fullDateTime(details.lastActiveAt)}</dd>
          </dl>
        </Modal>
      ) : null}
      <ConfirmDialog open={askAll} danger title="Завершить все другие сеансы?" text="Relay выйдет из аккаунта на всех устройствах, кроме этого." confirm="Завершить" cancel="Отмена"
        onCancel={() => setAskAll(false)} onConfirm={() => { setAskAll(false); void terminateOtherSessions(); }} />
    </div>
  );
}
