// Действие из меню выбора чатов — над всеми выбранными сразу. «Прочитать» — как в меню строки: счётчик гасит
// seen до последнего сообщения, отметку снимает chatFlags. Удаление — через окно (useBulkDelete).
import { useEffect, useRef, useState } from 'preact/hooks';
import { Checkbox, ConfirmDialog, Presence, SelectHeader, beginHeavyAnimation, reducedMotion } from '@relay/ui';
import type { Item } from '@relay/sync-engine/src/types';
import { archiveMany, markUnreadMany, pinMany } from '../chatFlags';
import { muteMany } from '../mute';
import { closeChat, seen } from '../data';
import { findChat, getGlobal, useGlobal } from '../global';
import { act, plural } from '../groups';
import { endChatSelect, inListOrder, pruneChatSelect, selectionActions, stateOf, type SelActions, type SelList } from '../chatSelect';

export function runChatAction(action: keyof SelActions, dir: boolean, ids: number[]): 'done' | 'ask-delete' {
  if (action === 'delete') return 'ask-delete';
  if (action === 'pin') pinMany(ids, dir);
  else if (action === 'archive') archiveMany(ids, dir);
  else if (action === 'mute') muteMany(ids, dir);
  else if (dir) {
    for (const id of ids) {
      const c = findChat(getGlobal(), id);
      const last = ((c?.last as { id?: number | null } | null)?.id ?? 0) || (c?.knownMaxId as number) || 0;
      if ((c?.unread as number) > 0 && last) seen(id, last);
    }
    markUnreadMany(ids, false);
  } else markUnreadMany(ids, true);
  return 'done';
}

/**
 * Удалить несколько: личные чаты — POST /chats/:id/delete (галочка «и у собеседников» — forAll),
 * группы и каналы — выйти (своих среди выбранных нет: selectionActions не предлагает удаление).
 */
export function useBulkDelete(onDone: () => void): { open: (ids: number[]) => void; node: preact.JSX.Element } {
  const [ids, setIds] = useState<number[] | null>(null);
  const [forAll, setForAll] = useState(false);
  const s = getGlobal();
  const personal = (ids ?? []).filter((id) => findChat(s, id)?.kind === 'direct');
  const run = async () => {
    const list = ids!; setIds(null); onDone();
    const me = getGlobal().me?.userId;
    const open = getGlobal().openChatId as number;
    // allSettled + catch: отказ одного вызова (движок не запущен и т. п.) не должен стать unhandled rejection и не прерывает остальные
    const done = await Promise.allSettled(list.map((id) => (findChat(getGlobal(), id)?.kind === 'direct'
      ? act('POST', `/chats/${id}/delete`, { forAll })
      : act('DELETE', `/groups/${id}/members/${me}`)).catch(() => null)));
    // открытый чат закрываем, только если его собственный вызов удался (при ошибке act уже показал тост и вернул null)
    const i = list.indexOf(open);
    if (i >= 0 && done[i].status === 'fulfilled' && (done[i] as PromiseFulfilledResult<unknown>).value != null && getGlobal().openChatId === open) closeChat();
  };
  const n = ids?.length ?? 0;
  const node = (
    <ConfirmDialog open={!!ids} danger title={`Удалить ${n} ${plural(n, 'чат', 'чата', 'чатов')}`}
      text={'Это действие нельзя отменить.' + (personal.length < n ? ' Из групп и каналов вы выйдете.' : '')} confirm="Удалить"
      onConfirm={() => void run()} onCancel={() => setIds(null)}>
      {personal.length ? <Checkbox id="bulk-del-all" checked={forAll} onChange={() => setForAll(!forAll)}>Удалить и у собеседников, где возможно</Checkbox> : null}
    </ConfirmDialog>
  );
  return { open: (list) => { setForAll(false); setIds(list); }, node };
}

/**
 * Режим выбора для одного списка (Sidebar — 'main', Archive — 'archive'): шапка поверх своей, класс анимации
 * на обёртку списка на время входа/выхода, выход при смене страницы/папки/поиска, чистка пропавших (Escape — в nav).
 */
export function useChatSelectMode(list: SelList, rows: readonly Item[]) {
  const sel = useGlobal((s) => (s.chatSelect?.list === list ? s.chatSelect : null));
  const folder = useGlobal((s) => s.folder), view = useGlobal((s) => s.sidebarView), searchOpen = useGlobal((s) => s.searchOpen);
  const on = !!sel;
  // шапка на выходе (Presence закрывается 200 мс) показывает последнее ненулевое число, а не «Выбрано: 0»
  const lastCount = useRef(0);
  if (sel) lastCount.current = sel.ids.length;
  // Анимация — только в момент смены режима (300 мс), с паузой остальных анимаций приложения.
  // Класс вычисляется в том же рендере, что и смена режима: из эффекта он приходил кадром позже, и строки
  // успевали показаться в конечном положении, а потом откатывались к началу анимации (рывок туда-обратно).
  const was = useRef(on), anim = useRef<null | 'in' | 'out'>(null), [, rerender] = useState(0);
  if (was.current !== on) { was.current = on; anim.current = reducedMotion() ? null : on ? 'in' : 'out'; }
  useEffect(() => {
    if (!anim.current) return;
    const end = beginHeavyAnimation(300);
    const t = setTimeout(() => { anim.current = null; end(); rerender((n) => n + 1); }, 300);
    return () => { clearTimeout(t); end(); };
  }, [on]);
  // Ушли со списка — выбор закончен. Закрываем только свой режим: Sidebar смонтирован всегда, а «Архив»
  // размонтируется через 300 мс после ухода — его очистка не должна снять режим «Все», включённый за это время.
  // Первый запуск эффекта ничего не делает (только очистка при смене папки/страницы/поиска или размонтировании).
  useEffect(() => () => { if (getGlobal().chatSelect?.list === list) endChatSelect(); }, [folder, view, searchOpen]);
  useEffect(() => {
    if (!on) return;
    const has = new Set(rows.map((c) => c.id as number));
    pruneChatSelect((id) => has.has(id));
  }, [rows, on]);
  // Esc снимает режим через навигацию (main.tsx → nav escMode): после слоёв переднего плана, до закрытия чата
  const del = useBulkDelete(endChatSelect);
  const getItems = () => {
    const s = getGlobal(), ids = inListOrder(s.chatSelect?.ids ?? [], s.chats);
    const a = selectionActions(ids.map((id) => stateOf(findChat(s, id) as never)));
    const item = (k: keyof SelActions, icon: string, label: string, danger?: boolean) => ({ icon, label, danger, onClick: () => {
      if (runChatAction(k, a[k]!, ids) === 'ask-delete') del.open(ids); else endChatSelect();
    } });
    return [
      ...(a.read === undefined ? [] : [a.read ? item('read', 'markRead', 'Отметить как прочитанные') : item('read', 'markUnread', 'Отметить как непрочитанные')]),
      ...(a.pin === undefined ? [] : [item('pin', a.pin ? 'pin' : 'unpin', a.pin ? 'Закрепить' : 'Открепить')]),
      ...(a.mute === undefined ? [] : [item('mute', a.mute ? 'bellOff' : 'bell', a.mute ? 'Выключить уведомления' : 'Включить уведомления')]),
      ...(a.archive === undefined ? [] : [item('archive', a.archive ? 'archive' : 'unarchive', a.archive ? 'В архив' : 'Вернуть из архива')]),
      ...(a.delete ? ['-' as const, item('delete', 'trash', 'Удалить', true)] : []),
    ];
  };
  const header = (
    <Presence show={on} exitMs={200}>
      <SelectHeader count={sel?.ids.length ?? lastCount.current} onCancel={endChatSelect} getItems={getItems} />
    </Presence>
  );
  const wrapClass = anim.current ? ' rl-sel-anim' + (anim.current === 'out' ? ' rl-sel-leave' : '') : '';
  // на выходе кружок ещё 300 мс в строке и гаснет на месте; полоса под него закрыта сразу, содержимое едет
  // обратно сдвигом (rl-sel-leave) — без второго скачка в конце
  const rowsSelecting = on || anim.current === 'out';
  return { sel, header, wrapClass, rowsSelecting, node: del.node };
}
