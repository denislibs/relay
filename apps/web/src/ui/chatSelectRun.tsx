// Действие из меню выбора чатов — над всеми выбранными сразу. «Прочитать» — как в меню строки: счётчик гасит
// seen до последнего сообщения, отметку снимает chatFlags. Удаление — через окно (useBulkDelete).
import { useState } from 'preact/hooks';
import { Checkbox, ConfirmDialog } from '@relay/ui';
import { archiveMany, markUnreadMany, pinMany } from '../chatFlags';
import { muteMany } from '../mute';
import { closeChat, seen } from '../data';
import { findChat, getGlobal } from '../global';
import { act, plural } from '../groups';
import type { SelActions } from '../chatSelect';

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
    await Promise.all(list.map((id) => findChat(getGlobal(), id)?.kind === 'direct'
      ? act('POST', `/chats/${id}/delete`, { forAll })
      : act('DELETE', `/groups/${id}/members/${me}`)));
    if (list.includes(getGlobal().openChatId as number)) closeChat();
  };
  const n = ids?.length ?? 0;
  const node = (
    <ConfirmDialog open={!!ids} danger title={`Удалить ${n} ${plural(n, 'чат', 'чата', 'чатов')}`}
      text="Это действие нельзя отменить. Из групп и каналов вы выйдете." confirm="Удалить"
      onConfirm={() => void run()} onCancel={() => setIds(null)}>
      {personal.length ? <Checkbox id="bulk-del-all" checked={forAll} onChange={() => setForAll(!forAll)}>Удалить и у собеседников, где возможно</Checkbox> : null}
    </ConfirmDialog>
  );
  return { open: (list) => { setForAll(false); setIds(list); }, node };
}
