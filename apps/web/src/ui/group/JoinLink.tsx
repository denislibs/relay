import { Avatar, Button, Modal, peerTone } from '@relay/ui';
import type { InvitePreview } from '@relay/protocol';
import { useEffect, useState } from 'preact/hooks';
import { groupCall, openChannel, openInner, openUserChat } from '../../data';
import { setGlobal, useGlobal } from '../../global';
import { errorText, plural } from '../../groups';
import { avatarPhoto } from '../../profilePhoto';
import { joinAction, parseLinkKey, showCardAt } from '../../joinLink';
import { resolveUser, showToast } from '../../settingsData';

// Ссылка-приглашение (/+токен) или публичное имя (/@имя), как t.me в Telegram: карточка группы → «Вступить»
// или «Подать заявку»; уже участник — сразу в чат; @имя человека — личный чат с ним; @имя канала — превью
// канала (лента для чтения с «Подписаться» внизу), без карточки.

// ссылка на сообщение (как t.me/имя/123 и t.me/c/чат/123): публичная группа или канал — /@имя/id, закрытые — /c/чат/id
const LINK = /^\/([+@][A-Za-z0-9_-]{1,64}|@[A-Za-z0-9_-]{1,64}\/\d{1,15}|c\/\d{1,15}\/\d{1,15})$/;

/** Путь ссылки → ключ ('+токен' / '@имя' / '@имя/id' / 'c/чат/id') или null. */
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
  const link = key ? parseLinkKey(key) : null;
  const target = link?.msg != null ? { id: link.msg, sort: link.msg } : undefined;   // ссылка на сообщение — открыть на нём
  useEffect(() => {
    if (!key || !link) return;
    setPreview(null); setError(null);
    let live = true;
    // закрытая группа или канал по id: участнику — чат на сообщении, остальным — «нет доступа»
    if (link.chatId != null) {
      const chatId = link.chatId;
      void groupCall<{ member: boolean }>('GET', '/groups/' + chatId).then((r) => {
        if (!live) return;
        if (r.ok && r.data.member) { close(); openInner(chatId, target); return; }
        if (r.ok) { close(); void openChannel(chatId, 'inner', target); return; }
        setError('Сообщение недоступно: вы не состоите в этом чате, или его удалили.');
      });
      return () => { live = false; };
    }
    const base = link.base!;
    void groupCall<InvitePreview>('GET', '/join/' + base).then(async (r) => {
      if (!live) return;
      if (r.ok) {
        const act = joinAction(base, r.data);
        if (act === 'open') { close(); openInner(r.data.chatId, target); return; }   // уже в группе — открыть поверх (ссылка из чата)
        // публичный канал по @имени — сразу его лента (превью), поверх: ссылка из чата
        if (act === 'preview') { close(); void openChannel(r.data.chatId, 'inner', target); return; }
        setPreview(r.data);
        return;
      }
      // @имя — не группа: может, человек (у ссылки на сообщение — нет: сообщения людей ссылок не имеют)
      if (base.startsWith('@') && r.code === 'not_found' && link.msg == null) {
        const u = await resolveUser(key);
        if (!live) return;
        if ('user' in u) { close(); void openUserChat(u.user.id, u.user.key ? { key: u.user.key } : undefined); return; }
      }
      setError(r.code === 'not_found' ? 'Ссылка недействительна или срок её действия истёк.' : errorText(r.code));
    });
    return () => { live = false; };
  }, [key]);

  const join = async () => {
    if (!key) return;
    setBusy(true);
    const r = await groupCall<{ chatId: number; requested: boolean }>('POST', '/join/' + (link?.base ?? key));
    setBusy(false);
    if (!r.ok) { showToast(r.code === 'forbidden' ? (preview?.kind === 'channel' ? 'Вас удалили из этого канала' : 'Вас удалили из этой группы') : errorText(r.code)); return; }
    close();
    if (r.data.requested) showToast('Заявка отправлена — администраторы её рассмотрят');
    else openInner(r.data.chatId, target);   // ссылка из чата — поверх; при загрузке по ссылке чата нет — станет нижним
  };

  return (
    <Modal open={showCardAt(link ? link.base ?? '@' : null, !!preview || !!error)} onClose={close} title={error ? (link?.msg != null ? 'Ссылка на сообщение' : 'Приглашение') : ''} size="confirm" closeButton={false}
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
