import { Avatar, Button, Modal, peerTone } from '@relay/ui';
import type { InvitePreview } from '@relay/protocol';
import { useEffect, useState } from 'preact/hooks';
import { groupCall, openChannel, openInner, openUserChat } from '../../data';
import { setGlobal, useGlobal } from '../../global';
import { errorText, plural } from '../../groups';
import { avatarPhoto } from '../../profilePhoto';
import { joinAction, showCardAt } from '../../joinLink';
import { resolveUser, showToast } from '../../settingsData';

// Ссылка-приглашение (/+токен) или публичное имя (/@имя), как t.me в Telegram: карточка группы → «Вступить»
// или «Подать заявку»; уже участник — сразу в чат; @имя человека — личный чат с ним; @имя канала — превью
// канала (лента для чтения с «Подписаться» внизу), без карточки.

const LINK = /^\/([+@][A-Za-z0-9_-]{1,64})$/;

/** Путь ссылки → ключ ('+токен' / '@имя') или null. */
export function linkKey(url: string): string | null {
  try {
    const u = new URL(url, location.origin);
    if (u.origin !== location.origin) return null;
    const m = LINK.exec(u.pathname);
    return m ? m[1] : null;
  } catch { return null; }
}

/** При старте: адрес — ссылка-приглашение → открыть карточку и вернуть адрес к корню. Клики по таким ссылкам в ленте — тоже. */
export function installJoinLinks(): void {
  const key = LINK.exec(location.pathname)?.[1];
  if (key) { history.replaceState(history.state, '', '/' + location.hash); setGlobal({ joinLink: key }); }
  document.addEventListener('click', (e) => {
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const k = linkKey(a.href);
    if (!k) return;
    e.preventDefault();
    setGlobal({ joinLink: k });
  }, true);
}

export function JoinLink() {
  const key = useGlobal((s) => s.joinLink);
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => { setGlobal({ joinLink: null }); setPreview(null); setError(null); };
  useEffect(() => {
    if (!key) return;
    setPreview(null); setError(null);
    let live = true;
    void groupCall<InvitePreview>('GET', '/join/' + key).then(async (r) => {
      if (!live) return;
      if (r.ok) {
        const act = joinAction(key, r.data);
        if (act === 'open') { close(); openInner(r.data.chatId); return; }   // уже в группе — открыть поверх (ссылка из чата)
        // публичный канал по @имени — сразу его лента (превью), поверх: ссылка из чата
        if (act === 'preview') { close(); void openChannel(r.data.chatId, 'inner'); return; }
        setPreview(r.data);
        return;
      }
      // @имя — не группа: может, человек
      if (key.startsWith('@') && r.code === 'not_found') {
        const u = await resolveUser(key);
        if (!live) return;
        if ('user' in u) { close(); void openUserChat(u.user.id); return; }
      }
      setError(r.code === 'not_found' ? 'Ссылка недействительна или срок её действия истёк.' : errorText(r.code));
    });
    return () => { live = false; };
  }, [key]);

  const join = async () => {
    if (!key) return;
    setBusy(true);
    const r = await groupCall<{ chatId: number; requested: boolean }>('POST', '/join/' + key);
    setBusy(false);
    if (!r.ok) { showToast(r.code === 'forbidden' ? (preview?.kind === 'channel' ? 'Вас удалили из этого канала' : 'Вас удалили из этой группы') : errorText(r.code)); return; }
    close();
    if (r.data.requested) showToast('Заявка отправлена — администраторы её рассмотрят');
    else openInner(r.data.chatId);   // ссылка из чата — поверх; при загрузке по ссылке чата нет — станет нижним
  };

  return (
    <Modal open={showCardAt(key, !!preview || !!error)} onClose={close} title={error ? 'Приглашение' : ''} size="confirm" closeButton={false}
      actions={error ? [<button key="ok" type="button" class="rl-mdl-btn" onClick={close}>Понятно</button>] : preview ? [
        <button key="no" type="button" class="rl-mdl-btn" onClick={close}>Отмена</button>,
      ] : []}>
      {error ? <p class="rl-mdl-text">{error}</p> : preview ? (
        <div class="app-join">
          <Avatar name={preview.title} tone={peerTone(preview.chatId)} size={96} {...avatarPhoto(preview.photo, true)} />
          <div class="app-join-title">{preview.title}</div>
          <div class="app-join-sub">{preview.members} {preview.kind === 'channel' ? plural(preview.members, 'подписчик', 'подписчика', 'подписчиков') : plural(preview.members, 'участник', 'участника', 'участников')}</div>
          {preview.about ? <p class="app-join-about">{preview.about}</p> : null}
          {preview.requested ? <p class="app-join-note">Вы уже подали заявку — ждите одобрения.</p> : (
            <Button variant="primary" class="app-join-btn" disabled={busy} onClick={() => void join()}>{preview.approval ? 'Подать заявку' : preview.kind === 'channel' ? 'Подписаться' : 'Вступить в группу'}</Button>
          )}
          {preview.approval && !preview.requested ? <p class="app-join-note">{preview.kind === 'channel' ? 'Администраторы канала рассматривают заявки на подписку.' : 'Администраторы группы рассматривают заявки на вступление.'}</p> : null}
        </div>
      ) : <div class="app-sm-loading" aria-busy="true" />}
    </Modal>
  );
}
