import type { ProfilePhoto } from '@relay/protocol';
import { Avatar, Button, Checkbox, Modal, peerTone, SearchInput } from '@relay/ui';
import { useState } from 'preact/hooks';
import { useGlobal } from '../../global';
import { avatarPhoto } from '../../profilePhoto';
import { filterContacts, sortByName } from '../contacts/contactsLogic';

/** Выбрать людей для звонка (из контактов): «Добавить участника» в разговоре 1:1, «Позвать» в звонке без группы. */
export function PeoplePicker({ title, action, exclude, onPick, onClose }: { title: string; action: string; exclude: number[]; onPick: (ids: number[]) => void; onClose: () => void }) {
  const contacts = useGlobal((s) => s.contacts);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<number[]>([]);
  const list = filterContacts(sortByName(contacts), q).filter((c) => !exclude.includes(c.userId as number));
  const toggle = (id: number) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= 30 ? s : [...s, id]));
  return (
    <Modal open size="slim" class="app-peoplepick" title={title} onClose={onClose}
      actions={[<Button key="ok" variant="primary" disabled={!sel.length} onClick={() => onPick(sel)}>{sel.length ? `${action} (${sel.length})` : action}</Button>]}>
      <SearchInput id="people-pick-search" label="Поиск контактов" placeholder="Поиск контактов" value={q} onInput={(e: Event) => setQ((e.target as HTMLInputElement).value)} />
      <div class="app-peoplepick-list" role="list">
        {list.length ? list.map((c) => {
          const id = c.userId as number;
          return (
            <div key={id} class="app-peoplepick-row" role="listitem">
              <Checkbox id={'people-pick-' + id} checked={sel.includes(id)} onChange={() => toggle(id)}>
                <Avatar name={String(c.name)} tone={peerTone(id)} size={36} {...avatarPhoto((c.photo as ProfilePhoto | null) ?? null)} />
                <span>{String(c.name)}</span>
              </Checkbox>
            </div>
          );
        }) : <p class="app-peoplepick-empty">{q.trim() ? 'Никого не нашли' : 'Нет контактов, которых можно позвать'}</p>}
      </div>
    </Modal>
  );
}
