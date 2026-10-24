import { Avatar, Badge, Icon, Modal, Presence, ProgressRing, peerTone, ripple, useMinVisible } from '@relay/ui';
import type { Replies } from '@relay/protocol';
import type { Item } from '@relay/sync-engine/src/types';
import { hasUnreadReplies } from '@relay/sync-engine/src/channel';
import { useEffect, useState } from 'preact/hooks';
import { commentsLabel, compactCount } from '../channelText';
import { groupCall, openInner, readBy } from '../data';
import { useGlobal } from '../global';
import { errorText } from '../groups';
import { isChatMuted, toggleMute } from '../mute';
import { wantPeople } from '../people';
import { senderAvatar } from '../profilePhoto';
import { showToast } from '../settingsData';
import { asLast, previewBody } from './preview';

// Каналы в ленте: мета поста, кнопка комментариев, нижняя панель подписчика, «к упоминанию», «кто прочитал»,
// плашка поста над тредом. Поведение — как в Telegram, разметка — своя.

/** Мета поста перед временем: глаз и просмотры, подпись автора, булавка (функция: Bubble рисует её дважды — копия держит место). */
export function postMeta(m: Item, pinned: boolean): () => preact.VNode {
  const views = typeof m.views === 'number' ? m.views as number : null;
  const sign = (m.postAuthor as string | undefined) || null;
  return () => (
    <>
      {pinned ? <span class="rl-post-pin" aria-label="Закреплено"><Icon name="pinFilled" size={12} /></span> : null}
      {views != null ? <span class="rl-post-views" aria-label={`Просмотров: ${views}`}><Icon name="eye" size={14} />{compactCount(views)}</span> : null}
      {sign ? <span class="rl-post-sign">{sign}</span> : null}
    </>
  );
}

/**
 * Кнопка под постом: до трёх аватаров последних комментаторов, «N комментариев» / «Оставить комментарий», точка
 * непрочитанного. Участник группы обсуждения — тред поверх стека; не участник — подсказка вступить.
 */
export function Comments({ m }: { m: Item }) {
  const r = m.replies as Replies;
  const recent = r.recent.slice(0, 3);
  // имена для инициалов: свои — из профиля (себя в people нет), чужие — из people (неизвестные — без имени, иконкой)
  const names = useGlobal((s) => recent.map((id) => (id === s.me?.userId ? s.me.name : s.people[id]?.name ?? '')));
  const member = useGlobal((s) => s.chats.some((c) => c.id === r.chatId));
  const [ask, setAsk] = useState(false);
  useEffect(() => { if (recent.length) wantPeople(recent); }, [recent.join(',')]);
  const unread = hasUnreadReplies(m as never);
  const open = (e: MouseEvent) => {
    e.stopPropagation();
    if (member) openInner({ chatId: r.chatId, threadId: r.copyId });
    else setAsk(true);
  };
  return (
    <>
      <button type="button" class="app-comments" onPointerDown={ripple} onClick={open} aria-label={commentsLabel(r.count) + (unread ? ', есть новые' : '')}>
        {recent.length ? (
          <span class="app-comments-avas" aria-hidden="true">
            {recent.map((id, i) => <Avatar key={id} name={names[i]} tone={peerTone(id)} size={24} {...senderAvatar(id)} />)}
          </span>
        ) : <Icon name="chats" size={22} class="app-comments-icon" />}
        <span class="app-comments-label">{commentsLabel(r.count)}</span>
        {unread ? <i class="app-comments-dot" aria-hidden="true" /> : null}
        <Icon name="chevronRight" size={20} class="app-comments-chev" />
      </button>
      <Modal open={ask} onClose={() => setAsk(false)} title="Вступите в группу, чтобы читать и писать" size="confirm" closeButton={false}
        actions={[<button key="ok" type="button" class="rl-mdl-btn" onClick={() => setAsk(false)}>Понятно</button>]}>
        <p class="rl-mdl-text">Комментарии к постам живут в группе обсуждения канала. Вступите в неё по ссылке из описания канала или попросите приглашение у администраторов.</p>
      </Modal>
    </>
  );
}

/**
 * Нижняя панель канала вместо поля ввода (как в Telegram): не подписан — «Подписаться» («Подать заявку», если
 * вступление по одобрению); подписчик без права публиковать — «Выключить / Включить звук».
 */
export function ChannelBar({ chatId, member, username, approval }: { chatId: number; member: boolean; username: string | null; approval: boolean }) {
  const muted = useGlobal((s) => isChatMuted(chatId, s));
  const [busy, setBusy] = useState(false);
  const spin = useMinVisible(busy, { delay: 150, min: 600 });
  const join = async () => {
    if (!username) { showToast('Вступить можно по пригласительной ссылке канала'); return; }
    setBusy(true);
    const r = await groupCall<{ chatId: number; requested: boolean }>('POST', '/join/@' + username);
    setBusy(false);
    if (!r.ok) { showToast(errorText(r.code)); return; }
    if (r.data.requested) showToast('Заявка отправлена — администраторы её рассмотрят');
  };
  return (
    <div class="rl-composer-wrap app-plate-wrap">
      <div class="rl-composer app-plate app-channel-bar" key={member ? 'mute' : 'join'}>
        {member ? (
          <button type="button" class="app-channel-btn" onPointerDown={ripple} onClick={() => toggleMute(chatId)}>
            <Icon name={muted ? 'bell' : 'bellOff'} size={22} /><span>{muted ? 'Включить звук' : 'Выключить звук'}</span>
          </button>
        ) : (
          <button type="button" class="app-channel-btn app-channel-join" disabled={busy} onPointerDown={ripple} onClick={() => void join()}>
            <span class={spin ? 'is-busy' : undefined}>{approval ? 'Подать заявку' : 'Подписаться'}</span>
          </button>
        )}
      </div>
    </div>
  );
}

/** «К упоминанию»: круглая «@» над «вниз» с числом непрочитанных упоминаний (как в Telegram). */
export function MentionFab({ count, raised, onClick }: { count: number; raised: boolean; onClick: () => void }) {
  return (
    <Presence show={count > 0} exitMs={160}>
      <button type="button" class={'rl-fab rl-fab-down app-mention-fab' + (raised ? ' is-raised' : '')} onPointerDown={ripple} onClick={onClick} aria-label="К непрочитанному упоминанию">
        <Icon name="at" size={24} />
        <Badge count={count} />
      </button>
    </Presence>
  );
}

/** «Кто прочитал» своё сообщение: список имён (сервер — участники, дошедшие до него), с лоадером без мигания. */
export function ReadByModal({ chatId, id, onClose }: { chatId: number; id: number | null; onClose: () => void }) {
  const [list, setList] = useState<{ id: number; name: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loading = useMinVisible(id != null && list == null && !error, { delay: 150, min: 600 });
  useEffect(() => {
    if (id == null) return;
    setList(null); setError(null);
    let live = true;
    void readBy(chatId, id).then((r) => {
      if (!live) return;
      if (r.ok) { setList(r.data); wantPeople(r.data.map((x) => x.id)); } else setError(r.code === 'forbidden' ? 'Список недоступен для этого сообщения' : errorText(r.code));
    });
    return () => { live = false; };
  }, [chatId, id]);
  return (
    <Modal open={id != null} onClose={onClose} title="Кто прочитал" size="slim"
      actions={[<button key="ok" type="button" class="rl-mdl-btn" onClick={onClose}>Закрыть</button>]}>
      <div class={'app-readby' + (list ? ' is-ready' : '')}>
        {error ? <p class="rl-mdl-text">{error}</p>
          : list ? (list.length ? (
            <div role="list">
              {list.map((p) => (
                <div key={p.id} role="listitem" class="rl-row app-readby-row">
                  <Avatar name={p.name} tone={peerTone(p.id)} size={36} {...senderAvatar(p.id)} />
                  <span class="rl-row-main"><span class="rl-row-name">{p.name}</span></span>
                </div>
              ))}
            </div>
          ) : <p class="rl-mdl-text">Пока никто не прочитал</p>)
          : <div class="app-readby-wait" aria-busy="true">{loading ? <ProgressRing size={28} /> : null}</div>}
      </div>
    </Modal>
  );
}

/** Плашка поста над тредом: «Пост» и строка его текста; клик — к посту в начале треда; удалён — «Пост удалён». */
export function ThreadBar({ header, title, onClick }: { header: Item | null; title: string; onClick: () => void }) {
  const gone = !!header?.deleted;
  const last = header && !gone ? asLast(header) : null;
  return (
    <div class="app-pins app-threadbar" role="region" aria-label="Пост">
      <button type="button" class="app-pins-main" onClick={onClick} disabled={!header || gone}>
        <span class="app-pins-track" aria-hidden="true"><span class="app-pins-segs"><i class="app-pins-on" style={{ height: '36px' }} /></span></span>
        <span class="app-pins-text">
          <b>{title || 'Пост'}</b>
          <span>{gone ? 'Пост удалён' : last ? previewBody(last, false) : '…'}</span>
        </span>
      </button>
    </div>
  );
}
