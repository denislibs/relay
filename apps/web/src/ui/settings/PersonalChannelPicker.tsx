// «Выберите канал» (как в Telegram): мои публичные каналы, где я владелец, с поиском по названию и @имени;
// выбранный уже канал — «Убрать канал» внизу. Выбор только меняет форму «Изменить профиль»: на сервер — по ✓.
import type { PersonalChannel } from '@relay/protocol';
import { Avatar, Modal, SearchInput, peerTone } from '@relay/ui';
import { useState } from 'preact/hooks';
import { subscribersText } from '../../channelText';
import { avatarPhoto } from '../../profilePhoto';
import { filterChannels } from './profileForm';

export function PersonalChannelPicker({ channels, current, onPick, onClose }: {
  channels: PersonalChannel[]; current: PersonalChannel | null; onPick: (c: PersonalChannel | null) => void; onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const shown = filterChannels(channels, q);
  return (
    <Modal onClose={onClose} title="Выберите канал" size="slim" class="app-pcp" bodyClass="app-pcp-body">
      <div class="app-pcp-search">
        <SearchInput id="app-pcp-q" label="Поиск канала" placeholder="Поиск" value={q} onInput={(e: Event) => setQ((e.target as HTMLInputElement).value)} />
      </div>
      <div class="app-pcp-list" role="listbox" aria-label="Каналы">
        {shown.length ? shown.map((c) => {
          const a = avatarPhoto(c.photo);
          return (
            <button key={c.id} type="button" role="option" aria-selected={current?.id === c.id} class={'app-pcp-row' + (current?.id === c.id ? ' is-on' : '')} onClick={() => onPick(c)}>
              <Avatar name={c.title || c.username} tone={peerTone(c.id)} size={42} src={a.src} thumb={a.thumb} />
              <span class="app-pcp-text"><b>{c.title || '@' + c.username}</b><small>{subscribersText(c.members)}</small></span>
            </button>
          );
        }) : <p class="app-pcp-empty">Ничего не найдено</p>}
      </div>
      {current ? <button type="button" class="app-pcp-remove" onClick={() => onPick(null)}>Убрать канал</button> : null}
    </Modal>
  );
}
