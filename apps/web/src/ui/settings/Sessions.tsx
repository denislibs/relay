import { Button, ChatRowSkeleton, ConfirmDialog, EmptyState, InfoRow, MenuPopover, Modal, PanelHeader, Presence, SelectRow, Section, reducedMotion, useMinVisible } from '@relay/ui';
import type { SessionInfo } from '@relay/protocol';
import { useEffect, useRef, useState } from 'preact/hooks';
import { sessionsSeen } from '../../banners';
import { useGlobal } from '../../global';
import { back } from '../../nav';
import { confirmSession, loadSessions, registerPrefetch, setSessionsTtl, terminateOtherSessions, terminateSession } from '../../settingsData';
import { fullDateTime, sessionTime } from '../format';
import { useLeaving } from '../useLeaving';
import { QrScanner } from '../QrLogin';

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
/** Знак и цвет плитки — по браузеру, как в Telegram; не браузер (приложение) — телефон или компьютер по ОС. */
const BROWSERS: [RegExp, string, Tile][] = [
  [/^Chrome/, 'browserChrome', 'green'],
  [/^Safari/, 'browserSafari', 'blue'],
  [/^Firefox/, 'browserFirefox', 'orange'],
  [/^Edge/, 'browserEdge', 'blue'],
  [/^Opera/, 'browserOpera', 'red'],
  [/^Яндекс/, 'browserYandex', 'red'],
];
function deviceLook(device: string): { icon: string; tile: Tile } {
  const b = BROWSERS.find(([re]) => re.test(device));
  if (b) return { icon: b[1], tile: b[2] };
  return { icon: /iOS|Android/.test(device) ? 'smartphone' : 'laptop', tile: 'gray' };
}

const NEW_LOGIN = <span class="app-session-new">Новый вход — не подтверждён</span>;
/** Неподтверждённый сеанс не может завершать другие (сервер ответит fresh_session) — не предлагаем. */
const LOCKED_HINT = 'Доступно после подтверждения входа на другом устройстве';

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
  const [scan, setScan] = useState(false);

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

  // подтверждение в очереди — пометка «новый вход» уже снята (как и плашка «Это вы?»)
  const list = raw ? sessionsSeen(raw, keys) : null;
  const waiting = list == null && !offline;
  const skeleton = useMinVisible(waiting, { delay: 150, min: 600 });
  const current = list?.find((s) => s.current) ?? null;
  const others = list?.filter((s) => !s.current) ?? [];
  const locked = !!current?.unconfirmed;
  // подсказку, раз показав, не выдёргиваем: после подтверждения она сворачивается по высоте — строка не прыгает
  const lockSeen = useRef(false);
  if (locked) lockSeen.current = true;
  // детали — по id из живого списка: «Это я» снимает пометку прямо в открытой модалке
  const shown = details ? list?.find((s) => s.id === details.id) ?? details : null;
  const ms = reducedMotion() ? 0 : 220;
  const rows = useLeaving(others, (s) => String(s.id), ms);
  const allRow = useLeaving(others.length ? ['all'] : [], (k) => k, ms);

  const end = (id: number) => { setMenu(null); setDetails(null); void terminateSession(id); };

  return (
    <div class="rl-sidepage" aria-label="Активные сеансы">
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title="Активные сеансы" onClose={() => void back()} />
      <div class="rl-settings">
        <Section footer="Отсканируйте QR-код на экране входа другого устройства, чтобы войти там без кода.">
          <InfoRow tile="green" icon="qr" title="Подключить устройство" onClick={() => setScan(true)} />
        </Section>
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
                  <InfoRow {...deviceLook(current.device)} title={current.device} subtitle={current.unconfirmed ? NEW_LOGIN : (current.ip ? current.ip + ' · ' : '') + 'в сети'} onClick={() => setDetails(current)} />
                  {allRow.map((r) => (
                    <div key={r.key} class={'app-collapse' + (r.leaving ? ' app-collapse-out' : '')}>
                      <div class={'app-row-lock' + (locked ? ' app-row-off' : '')} aria-disabled={locked ? 'true' : undefined}>
                        <InfoRow icon="logout" danger title="Завершить все другие сеансы" subtitle={lockSeen.current ? <span class={'app-lock-hint' + (locked ? '' : ' app-lock-hint-off')} aria-hidden={locked ? undefined : 'true'}><span>{LOCKED_HINT}</span></span> : undefined} onClick={locked ? undefined : () => setAskAll(true)} />
                      </div>
                    </div>
                  ))}
                </Section>
              ) : null}
              {rows.length ? (
                <Section title="Активные сеансы">
                  <div role="list">
                    {rows.map(({ item: s, key, leaving }) => (
                      <div key={key} role="listitem" class={'app-collapse' + (leaving ? ' app-collapse-out' : '')}
                        onContextMenu={(e) => { e.preventDefault(); if (!leaving && !locked) setMenu({ x: e.clientX, y: e.clientY, id: s.id }); }}>
                        <div>
                          <InfoRow {...deviceLook(s.device)} title={s.device} subtitle={s.unconfirmed ? NEW_LOGIN : s.ip ?? ''} value={s.online ? 'в сети' : sessionTime(s.lastActiveAt)} onClick={() => { if (!leaving) setDetails(s); }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </Section>
              ) : null}
              <Section title="Автоматически завершать сеансы">
                <SelectRow label="Если не активен" value={ttl} options={TTL_OPTIONS} disabled={locked} onChange={(v: number) => { if (Number(v) !== ttl) void setSessionsTtl(Number(v)); }} />
              </Section>
            </div>
          )}
        </div>
      </div>
      <MenuPopover open={!!menu} anchor={menu ?? undefined} label="Действия" onClose={() => setMenu(null)}
        items={menu ? [{ icon: 'logout', label: 'Завершить', danger: true, onClick: () => end(menu.id) }] : []} />
      {shown ? (
        <Modal title={shown.device} size="slim" onClose={() => setDetails(null)} actions={shown.current ? null : (
          <>
            {shown.unconfirmed ? <Button disabled={locked} onClick={() => void confirmSession(shown.id)}>Это я</Button> : null}
            <Button variant="danger" disabled={locked} onClick={() => end(shown.id)}>Завершить сеанс</Button>
          </>
        )}>
          <dl class="app-session-info">
            <dt>Устройство</dt><dd>{shown.device}</dd>
            <dt>IP</dt><dd>{shown.ip ?? '—'}</dd>
            <dt>Вход</dt><dd>{fullDateTime(shown.createdAt)}</dd>
            <dt>Последняя активность</dt><dd>{shown.online ? 'в сети' : fullDateTime(shown.lastActiveAt)}</dd>
          </dl>
          {shown.unconfirmed ? <p class="app-session-note">{NEW_LOGIN}</p> : null}
          {locked && !shown.current ? <p class="app-session-note">{LOCKED_HINT}</p> : null}
        </Modal>
      ) : null}
      {scan ? <QrScanner onClose={() => setScan(false)} /> : null}
      <ConfirmDialog open={askAll} danger title="Завершить все другие сеансы?" text="Relay выйдет из аккаунта на всех устройствах, кроме этого." confirm="Завершить" cancel="Отмена"
        onCancel={() => setAskAll(false)} onConfirm={() => { setAskAll(false); void terminateOtherSessions(); }} />
    </div>
  );
}
