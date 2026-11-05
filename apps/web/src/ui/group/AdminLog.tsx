import { asideFloats, Avatar, Button, Chip, CheckRow, ChatRowSkeleton, EmptyState, IconButton, Modal, Presence, requestMutation, Section, TextField, peerTone, useMinVisible, WindowList } from '@relay/ui';
import { ADMIN_LOG_GROUPS, ADMIN_LOG_LABELS, isAdminRole, type AdminLogAction, type AdminLogEntry, type AdminLogPage, type GroupMember } from '@relay/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  appendPage, deletedAt, EMPTY_LOG, filterActive, filterChips, GROUP_LABELS, GROUP_ORDER, groupByDay, groupState, logFailure, logPath, logView, messageSeg, needsDetails, NO_FILTER, adminLogText, toggleAction, toggleActor, toggleGroup,
  type LogFilter, type LogState, type Seg, type TextCtx,
} from '../../adminLog';
import { useGlobal } from '../../global';
import { groupCall, openInner, openUserChat } from '../../data';
import { useGroup, useGroupData } from '../../groups';
import { avatarPhoto } from '../../profilePhoto';
import { clock, dayLabel } from '../format';
import { GPage } from './common';
import type { Nav } from './Manage';

// «Недавние действия»: журнал только с сервера и только онлайн (в IndexedDB не хранится, журналом обновлений не приходит).
// Новые записи — при повторном открытии и по кнопке обновления; связь вернулась — повтор сам.

const ROW_H = 84;   // строки равной высоты (текст зажат): WindowList в дне и никаких прыжков при подгрузке
const PAGE = 50;
type Status = 'loading' | 'ready' | 'offline' | 'denied' | 'error';

function useAdminLog(chatId: number, filter: LogFilter, admin: boolean) {
  const [log, setLog] = useState<LogState>(EMPTY_LOG);
  const [status, setStatus] = useState<Status>('loading');
  const [tail, setTail] = useState<'idle' | 'loading' | 'offline'>('idle');
  const [fresh, setFresh] = useState(0);   // номер показанной выдачи: новая проявляется
  const logRef = useRef(log); logRef.current = log;
  const seq = useRef(0);
  const busy = useRef(false);

  const first = useCallback(() => {
    const my = ++seq.current;
    busy.current = false;
    setStatus('loading');
    setTail('idle');
    void groupCall<AdminLogPage>('GET', logPath(chatId, filter, null, PAGE)).then((r) => {
      if (my !== seq.current) return;
      if (!r.ok) {
        const st = logFailure(r.code);
        setStatus(st);
        if (st === 'denied') setLog(EMPTY_LOG);   // сняли с поста: показанное больше не держим
        return;
      }
      setLog(appendPage(EMPTY_LOG, r.data));
      setStatus('ready');
      setFresh((n) => n + 1);
    });
  }, [chatId, JSON.stringify(filter)]);

  const more = useCallback(() => {
    const cur = logRef.current;
    if (busy.current || !cur.hasMore || !cur.entries.length) return;
    const my = seq.current;
    busy.current = true;
    setTail('loading');
    void groupCall<AdminLogPage>('GET', logPath(chatId, filter, cur.entries[cur.entries.length - 1].id, PAGE)).then((r) => {
      if (my !== seq.current) return;
      busy.current = false;
      if (r.ok) { setLog((l) => appendPage(l, r.data)); setTail('idle'); return; }
      const st = logFailure(r.code);
      if (st === 'denied') { setLog(EMPTY_LOG); setStatus('denied'); setTail('idle'); } else setTail('offline');
    });
  }, [chatId, JSON.stringify(filter)]);

  useEffect(() => { if (admin) first(); else { seq.current++; setLog(EMPTY_LOG); setStatus('denied'); } }, [first, admin]);

  // связь вернулась — повтор того, что не дошло
  const online = useGlobal((s) => s.status.online);
  useEffect(() => {
    if (!online || !admin) return;
    if (status === 'offline' || status === 'error') first();
    else if (tail === 'offline') more();
  }, [online]);

  return { log, status, tail, fresh, reload: first, more };
}

/** Сегменты записи: имена и сообщение — кнопки. */
function Segs({ segs, onUser }: { segs: Seg[]; onUser: (id: number) => void }) {
  return <>{segs.map((s, i) => s.t === 'text' ? <span key={i}>{s.v}</span>
    : s.t === 'b' ? <b key={i}>{s.v}</b>
    : s.t === 'user' ? (s.id != null ? <button key={i} type="button" class="app-log-name" onClick={() => onUser(s.id as number)}>{s.name}</button> : <b key={i}>{s.name}</b>)
    : null)}</>;
}

function Row({ e, ctx, onUser, onMessage, onDetails }: { e: AdminLogEntry; ctx: TextCtx; onUser: (id: number) => void; onMessage: (e: AdminLogEntry) => void; onDetails: (e: AdminLogEntry) => void }) {
  const segs = adminLogText(e, ctx);
  const msg = messageSeg(e), gone = deletedAt(e), long = needsDetails(segs);
  const actor = e.actorId != null ? ctx.users.get(e.actorId) : undefined;
  const name = actor?.name ?? 'Пользователь';
  const canOpen = e.actorId != null && actor?.name != null;
  const ava = <Avatar name={name} tone={peerTone(e.actorId ?? 0)} size={40} {...avatarPhoto(actor?.photo ?? null)} />;
  return (
    <div class="app-log-row" role="listitem">
      {canOpen ? <button type="button" class="app-log-ava" aria-label={name} onClick={() => onUser(e.actorId as number)}>{ava}</button> : <span class="app-log-ava">{ava}</span>}
      <div class="app-log-main">
        <div class={'app-log-text' + (msg || gone || long ? ' is-two' : '')}><Segs segs={segs} onUser={onUser} /></div>
        {msg ? <button type="button" class="app-log-msg" onClick={() => onMessage(e)}>{msg.t === 'msg' ? msg.v : ''}</button>
          : gone ? <span class="app-log-sub">от {dayLabel(gone).toLowerCase()}, {clock(gone)}</span>
          : long ? <button type="button" class="app-log-more" onClick={() => onDetails(e)}>Подробнее</button> : null}
      </div>
      <time class="app-log-time" dateTime={e.at}>{clock(e.at)}</time>
    </div>
  );
}

/** Фильтр: типы по группам (группу можно раскрыть до отдельных типов), исполнители из текущих админов, поиск. */
function FilterDialog({ open, chatId, value, onClose, onApply }: { open: boolean; chatId: number; value: LogFilter; onClose: () => void; onApply: (f: LogFilter) => void }) {
  const [f, setF] = useState(value);
  const [expanded, setExpanded] = useState<string | null>(null);
  useEffect(() => { if (open) setF(value); }, [open]);
  const admins = useGroupData<{ members: GroupMember[] }>(open ? `/groups/${chatId}/members?filter=admins` : null);
  return (
    <Modal open={open} onClose={onClose} title="Фильтр"
      actions={[
        <button key="reset" type="button" class="rl-mdl-btn" onClick={() => { onApply(NO_FILTER); onClose(); }}>Сбросить</button>,
        <button key="ok" type="button" class="rl-mdl-btn" onClick={() => { onApply(f); onClose(); }}>Применить</button>,
      ]}>
      <div class="app-log-filter">
        <TextField label="Имя или действие" value={f.q} maxLength={64} onInput={(v: string) => setF({ ...f, q: v })} />
        <Section title="Действия">
          {GROUP_ORDER.map((g) => {
            const st = groupState(f, g), list = ADMIN_LOG_GROUPS[g] as readonly AdminLogAction[], opened = expanded === g;
            const on = list.filter((a) => f.actions.includes(a)).length;
            return (
              <div key={g}>
                <div class="app-gm-media">
                  <CheckRow checked={st === 'all'} label={GROUP_LABELS[g]} subtitle={st === 'some' ? `${on} из ${list.length}` : undefined} onChange={() => setF(toggleGroup(f, g))} />
                  <IconButton class={'app-gm-expand' + (opened ? ' is-open' : '')} icon="chevronDown" label={opened ? 'Свернуть' : 'Выбрать типы'} onClick={() => setExpanded(opened ? null : g)} />
                </div>
                <div class={'app-gm-sub' + (opened ? ' is-open' : '')}>
                  <div>{opened ? list.map((a) => <CheckRow key={a} checked={f.actions.includes(a)} label={ADMIN_LOG_LABELS[a]} onChange={() => setF(toggleAction(f, a))} />) : null}</div>
                </div>
              </div>
            );
          })}
        </Section>
        <Section title="Кто">
          {admins.data ? admins.data.members.map((m) => <CheckRow key={m.userId} checked={f.actors.includes(m.userId)} label={m.name} onChange={() => setF(toggleActor(f, m.userId))} />) : <div class="app-log-filter-wait" aria-busy="true" />}
        </Section>
      </div>
    </Modal>
  );
}

export function AdminLog({ nav }: { nav: Nav }) {
  const { chatId } = nav;
  const { me, kind } = useGroup(chatId);
  const admin = isAdminRole(me?.role ?? 'member');
  const [filter, setFilter] = useState<LogFilter>(NO_FILTER);
  const [asking, setAsking] = useState(false);
  const [details, setDetails] = useState<AdminLogEntry | null>(null);
  const { log, status, tail, fresh, reload, more } = useAdminLog(chatId, filter, admin);
  const ctx = useMemo<TextCtx>(() => ({ kind, users: log.users, chats: log.chats }), [kind, log.users, log.chats]);
  const days = useMemo(() => groupByDay(log.entries, dayLabel), [log.entries]);
  const adminNames = useGroupData<{ members: GroupMember[] }>(filter.actors.length ? `/groups/${chatId}/members?filter=admins` : null);
  const actorName = (id: number) => adminNames.data?.members.find((m) => m.userId === id)?.name ?? log.users.get(id)?.name ?? 'Пользователь';
  const chips = filterChips(filter, actorName);

  // лоадер — с задержкой и минимальным временем; уже показанное при обновлении не гасим, пока нет новой выдачи
  const skeleton = useMinVisible(status === 'loading' && !log.entries.length, { delay: 150, min: 600 });
  const tailBusy = useMinVisible(tail === 'loading', { delay: 150, min: 400 });
  const view = logView({ entries: log.entries.length, status }, filter);
  const page = useRef<HTMLDivElement>(null);

  const closeIfFloats = () => { if (asideFloats()) nav.close(); };
  const onUser = (id: number) => {
    const key = log.users.get(id)?.key;
    closeIfFloats();
    void openUserChat(id, key ? { key } : undefined);
  };
  const onMessage = (e: AdminLogEntry) => {
    const m = e.message;
    if (!m) return;
    closeIfFloats();
    // тот же чат в стеке — openInner только снимет слои выше и прокрутит (focusMessage); комментарий — поверх, в своём треде
    openInner(m.threadId != null ? { chatId, threadId: m.threadId } : chatId, { id: m.id, sort: m.id });
  };
  const refresh = () => {
    reload();
    // новая выдача начинается сверху: прокрутка — на начало, а не где-то посреди старых строк
    requestMutation(() => { page.current?.closest('.rl-settings')?.scrollTo({ top: 0 }); });
  };

  // ключ — минус id: WindowList держит строки в DOM по ключу, так порядок для чтения с экрана — новые сверху
  const rowsFor = (entries: AdminLogEntry[], last: boolean) => (
    <WindowList items={entries} rowHeight={ROW_H} overscan={6} role="list" getKey={(e: AdminLogEntry) => -e.id} onNearEnd={last ? more : undefined} nearEndKey={last ? log.entries.length : undefined}
      render={(e: AdminLogEntry) => <Row e={e} ctx={ctx} onUser={onUser} onMessage={onMessage} onDetails={setDetails} />} />
  );

  return (
    <GPage title="Недавние действия" onBack={nav.back}
      actions={admin ? [
        { icon: 'refresh', label: 'Обновить', onClick: refresh },
        { icon: 'general', label: 'Фильтр', onClick: () => setAsking(true) },
      ] : undefined}>
      <div ref={page} class="app-log">
        {filterActive(filter) ? (
          <div class="app-log-chips" role="group" aria-label="Активный фильтр">
            {chips.map((c) => <Chip key={c.key} active aria-label={`Убрать: ${c.label}`} onClick={() => setFilter(c.remove(filter))}>{c.label}</Chip>)}
            <Chip onClick={() => setFilter(NO_FILTER)}>Сбросить</Chip>
          </div>
        ) : null}
        <div class="app-listwrap is-fresh">
          {/* скелет уходит сам, стиранием поверх уже готовой выдачи (.app-listwrap); выдача новая — проявляется (key) */}
          <Presence show={skeleton} exitMs={280}>
            <div class="app-skel" aria-busy="true" aria-label="Загрузка журнала">
              {[0, 1, 2, 3, 4].map((i) => <div key={i} style={{ '--i': i }}><ChatRowSkeleton /></div>)}
            </div>
          </Presence>
          {view === 'list' ? (
            <div key={fresh} class="app-log-list">
              {days.map((d, i) => (
                <section key={d.key + ':' + i} class="app-log-day" aria-label={d.label}>
                  <h3 class="app-log-daylabel">{d.label}</h3>
                  {rowsFor(d.entries, i === days.length - 1)}
                </section>
              ))}
              {log.hasMore || tail !== 'idle' ? (
                <div class="app-log-tail" role="status">
                  {tail === 'offline'
                    ? <><span>Нет сети</span><Button size="small" onClick={more}>Повторить</Button></>
                    : <Presence show={tailBusy} exitMs={200}><svg class="app-sm-spin" width="22" height="22" viewBox="0 0 18 18" fill="none" aria-label="Загружаем ещё"><circle cx="9" cy="9" r="7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="30 44" /></svg></Presence>}
                </div>
              ) : null}
            </div>
          ) : skeleton ? null
            : view === 'empty' ? <EmptyState kind="log" title="За последние 48 часов действий нет" text="Здесь появятся действия администраторов и участников." />
            : view === 'emptyFiltered' ? <EmptyState kind="search" title="Ничего не найдено" text="Попробуйте изменить фильтр." action={<Button onClick={() => setFilter(NO_FILTER)}>Сбросить</Button>} />
            : view === 'offline' ? <EmptyState title="Нет сети" text="Журнал загрузится, когда появится подключение." action={<Button onClick={reload}>Повторить</Button>} />
            : view === 'error' ? <EmptyState title="Не получилось загрузить" text="Попробуйте ещё раз." action={<Button onClick={reload}>Повторить</Button>} />
            : view === 'denied' ? <EmptyState title="Нет доступа" text="Журнал видят только администраторы." />
            : null}
        </div>
      </div>
      <FilterDialog open={asking} chatId={chatId} value={filter} onClose={() => setAsking(false)} onApply={setFilter} />
      <Modal open={!!details} onClose={() => setDetails(null)} title={details ? `${dayLabel(details.at)}, ${clock(details.at)}` : ''} size="confirm" closeButton={false}
        actions={[<button key="x" type="button" class="rl-mdl-btn" onClick={() => setDetails(null)}>Закрыть</button>]}>
        {details ? <p class="rl-mdl-text app-log-full"><Segs segs={adminLogText(details, ctx)} onUser={(id) => { setDetails(null); onUser(id); }} /></p> : null}
      </Modal>
    </GPage>
  );
}
