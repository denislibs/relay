import { ConfirmDialog, InfoRow, Menu, PanelHeader, Presence, ProfileHeader, RichText, Section, Toast } from '@relay/ui';
import { useEffect, useRef, useState } from 'preact/hooks';
import { getGlobal, setGlobal, useGlobal } from '../../global';
import { back, go } from '../../nav';
import { prefetch, prefetchAll } from '../../settingsData';
import { useScrollMemory } from '../useScrollMemory';

declare const __BUILD__: string;

type Tile = 'blue' | 'orange' | 'red' | 'gray' | 'green' | 'purple';
interface SectionRow { path: string; icon: string; tile: Tile; title: string; subtitle: string }

// «Папки», «Стикеры», «Язык» — позже, здесь не показываем
const SECTIONS: SectionRow[] = [
  { path: 'settings/profile', icon: 'account', tile: 'blue', title: 'Аккаунт', subtitle: 'Имя пользователя, о себе, день рождения' },
  { path: 'settings/general', icon: 'general', tile: 'orange', title: 'Общие настройки', subtitle: 'Обои, тема, клавиатура' },
  { path: 'settings/notifications', icon: 'bell', tile: 'red', title: 'Уведомления', subtitle: 'Звуки, типы чатов' },
  { path: 'settings/privacy', icon: 'lock', tile: 'gray', title: 'Конфиденциальность', subtitle: 'Последний визит, блокировка' },
  { path: 'settings/data', icon: 'storage', tile: 'green', title: 'Данные и память', subtitle: 'Автозагрузка, кэш' },
  { path: 'settings/performance', icon: 'rocket', tile: 'purple', title: 'Анимации и производительность', subtitle: 'Анимации, переходы, автовоспроизведение' },
  { path: 'settings/sessions', icon: 'devices', tile: 'blue', title: 'Активные сеансы', subtitle: 'Сеансы, автозавершение' },
];

// число сеансов подключит B9; пока значение не показываем
const sessionCount: number | null = null;

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
function birthdayText(v: string): string {
  const m = ISO_DAY.exec(v);
  if (!m) return v;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: +m[1] > 1 ? 'numeric' : undefined, timeZone: 'UTC' });
}

/** Выход: сервер удаляет сеанс, локальные данные пользователя чистим. */
async function logout(): Promise<void> {
  const uid = getGlobal().me?.userId;
  try { await fetch('/logout', { method: 'POST' }); } catch { /* нет сети — всё равно выходим локально */ }
  try { localStorage.removeItem('relay.me'); } catch { /* приватный режим */ }
  if (uid != null) try { indexedDB.deleteDatabase('relay-' + uid); } catch { /* */ }
  setGlobal({ boot: 'login' });
  location.reload();   // воркеры отпускают IndexedDB, база удаляется до конца
}

export function Main() {
  const me = useGlobal((s) => s.me)!;
  const status = useGlobal((s) => s.status);
  const scroll = useScrollMemory('settings');
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [toast, setToast] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { prefetchAll(SECTIONS.map((s) => s.path)); }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function copy(text: string): void {
    navigator.clipboard?.writeText(text).then(() => {
      setToast(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setToast(false), 2000);
    }).catch(() => { /* буфер недоступен */ });
  }

  const phone = me.phone ? (me.phone.startsWith('+') ? me.phone : '+' + me.phone) : null;
  const username = me.username ? '@' + me.username.replace(/^@/, '') : null;
  const bio = me.bio?.trim() || null;
  const birthday = me.birthday ? birthdayText(me.birthday) : null;
  const hasInfo = !!(phone || username || bio || birthday);

  return (
    <div class="rl-sidepage" aria-label="Настройки">
      <PanelHeader
        icon="arrowLeft" closeLabel="Назад" title="Настройки" onClose={() => void back()}
        actions={[
          { icon: 'pencil', label: 'Изменить профиль', onClick: () => void go('settings/profile') },
          { icon: 'more', label: 'Ещё', popup: true, onClick: () => setMenu(true) },
        ]}
      />
      {menu ? <div class="rl-msgmenu-scrim" onClick={() => setMenu(false)} /> : null}
      <Presence show={menu} exitMs={160}>
        <div class="app-pagemenu">
          <Menu label="Меню настроек" onClose={() => setMenu(false)} items={[{ icon: 'logout', label: 'Выйти', danger: true, onClick: () => setConfirm(true) }]} />
        </div>
      </Presence>
      <div class="rl-settings" ref={scroll.ref} onScroll={scroll.onScroll}>
        <ProfileHeader name={me.name} subtitle={status.phase === 'offline' ? 'нет сети' : 'в сети'} size={96} />
        {hasInfo ? (
          <Section>
            {phone ? <InfoRow icon="phone" title={phone} subtitle="Телефон" onClick={() => copy(phone)} /> : null}
            {username ? <InfoRow icon="at" title={username} subtitle="Имя пользователя" onClick={() => copy(username)} /> : null}
            {bio ? (
              <div class="rl-inforow rl-inforow-static" onClick={(e) => { if (!(e.target as HTMLElement).closest('a')) copy(bio); }}>
                <span class="rl-inforow-icon"><svg class="rl-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 11v5M12 8h.01" /><circle cx="12" cy="12" r="9" /></svg></span>
                <span class="rl-inforow-text"><span class="rl-bio"><RichText text={bio} /></span><small>О себе</small></span>
              </div>
            ) : null}
            {birthday ? <InfoRow icon="cake" title={birthday} subtitle="День рождения" onClick={() => copy(birthday)} /> : null}
          </Section>
        ) : null}
        <Section>
          {SECTIONS.map((s) => (
            <div key={s.path} onPointerEnter={() => prefetch(s.path)} onFocusCapture={() => prefetch(s.path)}>
              <InfoRow tile={s.tile} icon={s.icon} title={s.title} subtitle={s.subtitle} value={s.path === 'settings/sessions' && sessionCount != null ? sessionCount : undefined} onClick={() => void go(s.path)} />
            </div>
          ))}
        </Section>
        <Section title="О приложении">
          <InfoRow icon="info" title="Relay" subtitle={'Сборка ' + __BUILD__} />
        </Section>
      </div>
      <Presence show={toast} exitMs={200}>
        <div class="app-toast"><Toast>Скопировано</Toast></div>
      </Presence>
      <ConfirmDialog open={confirm} danger title="Выйти из Relay?" text="Чтобы войти снова, понадобится войти заново. Данные чатов на этом устройстве будут удалены." confirm="Выйти" cancel="Отмена" onCancel={() => setConfirm(false)} onConfirm={() => { setConfirm(false); void logout(); }} />
    </div>
  );
}
