import { ProfileLinks } from '../links/ProfileLinks';
import { releaseMediaCache } from '../../storageInfo';
import { ConfirmDialog, InfoRow, SettingsIcon, MenuPopover, PanelHeader, Presence, ProfileHeader, RichText, Section, Toast, peerTone } from '@relay/ui';
import { useEffect, useRef, useState } from 'preact/hooks';
import { getGlobal, setGlobal, useGlobal } from '../../global';
import { back, go } from '../../nav';
import { sessionsView } from '@relay/sync-engine/src/sessions';
import { markSelfLogout, prefetch, prefetchAll } from '../../settingsData';
import { setPref } from '../../prefs';
import { dropSubscription } from '../../notify';
import { birthdayText } from '../format';
import { useScrollMemory } from '../useScrollMemory';
import { usePhotoPicker } from './usePhotoPicker';
import { avatarPhoto, useProfilePhotos } from '../../profilePhoto';
import { PhotoViewer } from '../PhotoViewer';
import { PersonalChannelBlock } from '../profile/PersonalChannelBlock';
import { useSettingsSearch } from './SettingsSearch';

declare const __BUILD__: string;

type Tile = 'blue' | 'orange' | 'red' | 'gray' | 'green' | 'purple';
interface SectionRow { path: string; icon: string; tile: Tile; title: string; subtitle: string }

// «Стикеры», «Язык» — позже, здесь не показываем
const SECTIONS: SectionRow[] = [
  { path: 'settings/profile', icon: 'account', tile: 'blue', title: 'Аккаунт', subtitle: 'Имя пользователя, о себе, день рождения' },
  { path: 'settings/general', icon: 'general', tile: 'orange', title: 'Общие настройки', subtitle: 'Обои, тема, клавиатура' },
  { path: 'settings/notifications', icon: 'bell', tile: 'red', title: 'Уведомления', subtitle: 'Звуки, типы чатов' },
  { path: 'settings/privacy', icon: 'lock', tile: 'gray', title: 'Конфиденциальность', subtitle: 'Последний визит, блокировка' },
  { path: 'settings/folders', icon: 'folder', tile: 'blue', title: 'Папки с чатами', subtitle: 'Сортировка чатов по папкам' },
  { path: 'settings/data', icon: 'storage', tile: 'green', title: 'Данные и память', subtitle: 'Автозагрузка, кэш' },
  { path: 'settings/performance', icon: 'rocket', tile: 'purple', title: 'Анимации и производительность', subtitle: 'Анимации, переходы, автовоспроизведение' },
  { path: 'settings/sessions', icon: 'devices', tile: 'blue', title: 'Активные сеансы', subtitle: 'Сеансы, автозавершение' },
];

/** Выход: сервер удаляет сеанс; без подтверждения сервера остаёмся в системе (иначе cookie жива и вход вернётся). */
async function logout(): Promise<boolean> {
  markSelfLogout(true);   // своё sessionTerminated после выхода — не «завершён на другом устройстве»
  try {
    const res = await fetch('/logout', { method: 'POST' });
    if (!res.ok && res.status !== 401) { markSelfLogout(false); return false; }   // 401 — сеанса уже нет, выходим локально
  } catch { markSelfLogout(false); return false; }
  // подписку сервер уже удалил вместе с сеансом; браузер тоже отписываем — новый вход подпишется заново
  await dropSubscription().catch(() => {});
  const uid = getGlobal().me?.userId;
  try { localStorage.removeItem('relay.me'); localStorage.removeItem('relay.thisSession'); } catch { /* приватный режим */ }
  if (uid != null) try { indexedDB.deleteDatabase('relay-' + uid); } catch { /* */ }
  await releaseMediaCache();   // вложения — как и база: на устройстве после выхода не остаются
  setGlobal({ boot: 'login' });
  location.reload();   // воркеры отпускают IndexedDB, база удаляется до конца
  return true;
}

export function Main() {
  const me = useGlobal((s) => s.me)!;
  const photo = usePhotoPicker(me.photo);
  const myPhotos = useProfilePhotos(me.userId, me.photo);
  const [viewer, setViewer] = useState<number | null>(null);
  const status = useGlobal((s) => s.status);
  // число сеансов справа на строке «Активные сеансы»: появляется, только когда список уже известен (предзагрузка)
  const sessionCount = useGlobal((s) => (s.sessions ? sessionsView(s.sessions, s.opsKeys).length : null));
  const scroll = useScrollMemory('settings');
  const search = useSettingsSearch();
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const lastToast = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const devOn = useGlobal((s) => s.prefs.dev.enabled);
  const taps = useRef<number[]>([]);

  useEffect(() => { prefetchAll(SECTIONS.map((s) => s.path)); }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function flash(text: string): void {
    lastToast.current = text;
    setToast(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 2000);
  }
  function copy(text: string): void {
    navigator.clipboard?.writeText(text).then(() => flash('Скопировано')).catch(() => { /* буфер недоступен */ });
  }

  // пять нажатий на версию («О приложении») за 2 с открывают скрытый раздел (флаг на устройстве), как в Telegram
  function onVersionTap(): void {
    const now = Date.now();
    taps.current = taps.current.filter((t) => now - t < 2000).concat(now);
    if (taps.current.length < 5) return;
    taps.current = [];
    if (devOn) return;
    setPref('dev.enabled', true);
    flash('Раздел для разработчиков включён');
  }

  const phone = me.phone ? (me.phone.startsWith('+') ? me.phone : '+' + me.phone) : null;
  const username = me.username ? '@' + me.username.replace(/^@/, '') : null;
  const bio = me.bio?.trim() || null;
  const birthday = me.birthday ? birthdayText(me.birthday) : null;
  const links = me.links ?? [];
  const hasInfo = !!(phone || username || bio || birthday || links.length || me.personalChannel);

  return (
    <div class={'rl-sidepage' + search.class} aria-label="Настройки">
      <div class="app-contents">
      <PanelHeader
        icon="arrowLeft" closeLabel="Назад" title="Настройки" onClose={() => void back()}
        actions={[
          { icon: 'search', label: 'Поиск по настройкам', onClick: search.toggle },
          { icon: 'write', label: 'Изменить профиль', onClick: () => void go('settings/profile') },
          { icon: 'more', label: 'Ещё', popup: true, onClick: (e: MouseEvent) => setMenu(e.currentTarget as HTMLElement) },
        ]}
      />
      </div>
      <MenuPopover open={!!menu} anchor={menu ?? undefined} placement="bottom-end" label="Меню настроек" onClose={() => setMenu(null)}
        items={[{ icon: 'logout', label: 'Выйти', danger: true, onClick: () => setConfirm(true) }]} />
      <div class="rl-settings" ref={scroll.ref} onScroll={scroll.onScroll}>
        <ProfileHeader name={me.name} tone={peerTone(me.userId)} subtitle={status.phase === 'offline' ? 'нет сети' : 'в сети'} size={96}
          {...(me.photo && !photo.busy ? { ...avatarPhoto(me.photo, true), camera: false, avatarLabel: 'Открыть фото', onAvatar: () => setViewer(0) } : photo.avatar)} />
        {photo.ui}
        {viewer != null && myPhotos.length ? (
          <PhotoViewer own photos={myPhotos} index={viewer} name={me.name} onClose={() => setViewer(null)}
            origin={(k) => (k === 0 ? document.querySelector<HTMLElement>('.rl-settings .rl-profile-ava .rl-avatar') : null)} />
        ) : null}
        {hasInfo ? (
          <Section>
            {/* свой личный канал — как его видят другие; «Настройки» — левая колонка: канал заменяет стек */}
            <PersonalChannelBlock channel={me.personalChannel} from="left" />
            {phone ? <InfoRow tile="green" icon="phone" title={phone} subtitle="Телефон" onClick={() => copy(phone)} /> : null}
            {username ? <InfoRow tile="blue" icon="at" title={username} subtitle="Имя пользователя" onClick={() => copy(username)} /> : null}
            {bio ? (
              <div
                class="rl-inforow rl-inforow-static" role="button" tabIndex={0}
                onClick={(e) => { if (!(e.target as HTMLElement).closest('a')) copy(bio); }}
                onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); copy(bio); } }}
              >
                <SettingsIcon icon="info" color="gray" />
                <span class="rl-inforow-text"><span class="rl-bio"><RichText text={bio} /></span><small>О себе</small></span>
              </div>
            ) : null}
            {birthday ? <InfoRow tile="purple" icon="cake" title={birthday} subtitle="День рождения" onClick={() => copy(birthday)} /> : null}
            <ProfileLinks links={links} />
          </Section>
        ) : null}
        <Section>
          {SECTIONS.map((s) => (
            <div key={s.path} onPointerEnter={() => prefetch(s.path)} onFocusCapture={() => prefetch(s.path)}>
              <InfoRow tile={s.tile} icon={s.icon} title={s.title} subtitle={s.subtitle} value={s.path === 'settings/sessions' && sessionCount != null ? sessionCount : undefined} onClick={() => void go(s.path)} />
            </div>
          ))}
          <Presence show={devOn} exitMs={220}>
            <div class="app-devrow" onPointerEnter={() => prefetch('settings/dev')}>
              <InfoRow tile="gray" icon="bug" title="Для разработчиков" subtitle="Синхронизация, сеть, хранилище" onClick={() => void go('settings/dev')} />
            </div>
          </Presence>
        </Section>
        <Section title="О приложении">
          <InfoRow icon="info" title="Relay" subtitle={'Сборка ' + __BUILD__} onClick={onVersionTap} />
        </Section>
      </div>
      {search.layer}
      <Presence show={toast != null} exitMs={200}>
        <div class="app-toast"><Toast>{toast ?? lastToast.current}</Toast></div>
      </Presence>
      <ConfirmDialog open={confirm} danger title="Выйти из Relay?" text="Чтобы войти снова, понадобится войти заново. Данные чатов на этом устройстве будут удалены." confirm="Выйти" cancel="Отмена" onCancel={() => setConfirm(false)} onConfirm={() => { setConfirm(false); void logout().then((ok) => { if (!ok) flash('Не удалось выйти. Проверьте подключение.'); }); }} />
    </div>
  );
}
