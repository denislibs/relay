// Личный канал в профиле, как в Telegram: строка «Канал · N подписчиков» и под ней ячейка канала с последним постом.
// Строка рисуется сразу из снимка профиля (PublicUser.personalChannel), пост доезжает кроссфейдом; сервер канал
// не показывает (удалён, стал приватным, зритель в бане) — блок плавно схлопывается.
import type { PersonalChannel } from '@relay/protocol';
import { ChatRow, peerTone } from '@relay/ui';
import { openChannel } from '../../data';
import { subscribersText } from '../../channelText';
import { avatarPhoto } from '../../profilePhoto';
import { useChannelPost, type ChannelPostState } from '../../personalChannel';
import { Expand } from '../Expand';
import { chatTime } from '../format';
import { previewBody, previewThumb } from '../preview';

/** Ячейка канала как в списке чатов: аватар, название, последний пост, время — без бейджей и «печатает». */
export function PersonalChannelRow({ channel, post, onClick }: { channel: PersonalChannel; post: ChannelPostState; onClick: () => void }) {
  const last = post.state === 'known' ? post.last : null;
  const thumb = last ? previewThumb(last) : null;
  const a = avatarPhoto(channel.photo);
  // пока поста нет — @имя канала; пришёл — меняется мягким проявлением (key: новый узел, анимация появления)
  const preview = <span class="app-pc-preview" key={last ? 'p' + last.id : post.state}>{last ? previewBody(last, !!thumb) : post.state === 'known' ? 'Нет публикаций' : '@' + channel.username}</span>;
  return (
    <ChatRow class="app-pc-row" name={channel.title || '@' + channel.username} avatarTone={peerTone(channel.id)} avatarSrc={a.src} avatarThumb={a.thumb}
      thumb={thumb} preview={preview} time={last ? chatTime(last.createdAt) : ''} onClick={onClick} />
  );
}

/** Блок в «Информации» и в своей карточке на «Настройках». from — правило стека (docs/navigation-rules.md):
 *  правая панель — поверх (inner), левая колонка (свои «Настройки») — замена (left). */
export function PersonalChannelBlock({ channel, from }: { channel: PersonalChannel | null | undefined; from: 'left' | 'inner' }) {
  const post = useChannelPost(channel?.id);
  const show = !!channel && post.state !== 'gone';
  const open = () => {
    if (!channel) return;
    const last = post.state === 'known' ? post.last : null;
    void openChannel(channel.id, from, last ? { id: last.id, sort: last.id } : undefined);
  };
  return (
    <Expand show={show}>{channel ? (
      <div class="app-pc">
        <div class="app-pc-head"><span>Канал</span><span>{subscribersText(channel.members)}</span></div>
        <PersonalChannelRow channel={channel} post={post} onClick={open} />
      </div>
    ) : null}</Expand>
  );
}
