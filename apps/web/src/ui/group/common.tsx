import { Avatar, Fab, PanelHeader, Presence, peerTone } from '@relay/ui';
import type { ProfilePhoto } from '@relay/protocol';
import type { ComponentChildren } from 'preact';
import { avatarPhoto, userPhoto } from '../../profilePhoto';

/** Экран управления группой: шапка со стрелкой, прокрутка, круглая кнопка внизу (появляется плавно). */
export function GPage({ title, onBack, children, fab, action }: {
  title: string; onBack: () => void; children: ComponentChildren;
  fab?: { show: boolean; icon: string; label: string; onClick: () => void; busy?: boolean };
  action?: { icon: string; label: string; onClick: () => void };
}) {
  return (
    <div class="rl-sidepage" aria-label={title}>
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title={title} onClose={onBack} action={action} />
      <div class="rl-settings app-gm">{children}</div>
      {fab ? (
        <Presence show={fab.show} exitMs={200}>
          <div class={'rl-fab-slot' + (fab.busy ? ' app-gm-busy' : '')}><Fab icon={fab.icon} label={fab.label} onClick={fab.busy ? () => {} : fab.onClick} /></div>
        </Presence>
      ) : null}
    </div>
  );
}

/** Строка человека: аватар, имя, подпись; справа — звание/роль или своё. */
export function PersonRow({ id, name, label, photo, subtitle, online, trailing, onClick, onContext, disabled }: {
  id: number; name: string; label?: string; photo?: ProfilePhoto | null; subtitle?: ComponentChildren; online?: boolean; trailing?: ComponentChildren;
  onClick?: () => void; onContext?: (e: MouseEvent) => void; disabled?: boolean;
}) {
  return (
    <button type="button" role="listitem" class="rl-row app-member app-gm-person" disabled={disabled} onClick={onClick}
      onContextMenu={onContext ? (e) => { e.preventDefault(); onContext(e as unknown as MouseEvent); } : undefined}>
      <Avatar name={name} tone={peerTone(id)} size={44} online={!!online} {...avatarPhoto(photo ?? userPhoto(id))} />
      <span class="rl-row-main">
        <span class="app-member-top"><span class="rl-row-name">{label ?? name}</span>{trailing ? <span class="app-member-badge">{trailing}</span> : null}</span>
        {subtitle != null ? <span class={'rl-row-preview' + (online ? ' app-online' : '')}>{subtitle}</span> : null}
      </span>
    </button>
  );
}

export function Loading() {
  return <div class="app-sm-loading" aria-busy="true" />;
}
