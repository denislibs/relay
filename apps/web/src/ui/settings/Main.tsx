import { ConfirmDialog, InfoRow, SettingsIcon, Menu, PanelHeader, Presence, ProfileHeader, RichText, Section, Toast, peerTone } from '@relay/ui';
import { useEffect, useRef, useState } from 'preact/hooks';
import { getGlobal, setGlobal, useGlobal } from '../../global';
import { back, go } from '../../nav';
import { sessionsView } from '@relay/sync-engine/src/sessions';
import { markSelfLogout, prefetch, prefetchAll } from '../../settingsData';
import { setPref } from '../../prefs';
import { birthdayText } from '../format';
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

/** Выход: сервер удаляет сеанс; без подтверждения сервера остаёмся в системе (иначе cookie жива и вход вернётся). */
async function logout(): Promise<boolean> {
  markSelfLogout(true);   // своё sessionTerminated после выхода — не «завершён на другом устройстве»
  try {
    const res = await fetch('/logout', { method: 'POST' });
    if (!res.ok && res.status !== 401) { markSelfLogout(false); return false; }   // 401 — сеанса уже нет, выходим локально
  } catch { markSelfLogout(false); return false; }
  const uid = getGlobal().me?.userId;
  try { localStorage.removeItem('relay.me'); localStorage.removeItem('relay.names'); } catch { /* приватный режим */ }
  if (uid != null) try { indexedDB.deleteDatabase('relay-' + uid); } catch { /* */ }
  setGlobal({ boot: 'login' });
  location.reload();   // воркеры отпускают IndexedDB, база удаляется до конца
  return true;
}

export function Main() {
  const me = useGlobal((s) => s.me)!;
  const status = useGlobal((s) => s.status);
  // число сеансов справа на строке «Активные сеансы»: появляется, только когда список уже известен (предзагрузка)
  const sessionCount = useGlobal((s) => (s.sessions ? sessionsView(s.sessions, s.opsKeys).length : null));
  const scroll = useScrollMemory('settings');
  const [menu, setMenu] = useState(false);
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

  // пять нажатий на заголовок за 2 с открывают скрытый раздел (флаг на устройстве)
  function onTitleTap(e: MouseEvent): void {
    if (!(e.target as HTMLElement).closest('h2')) return;
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
  const hasInfo = !!(phone || username || bio || birthday);

  return (
    <div class="rl-sidepage" aria-label="Настройки">
      <div class="app-contents" onClick={onTitleTap}>
      <PanelHeader
        icon="arrowLeft" closeLabel="Назад" title="Настройки" onClose={() => void back()}
        actions={[
          { icon: 'pencil', label: 'Изменить профиль', onClick: () => void go('settings/profile') },
          { icon: 'more', label: 'Ещё', popup: true, onClick: () => setMenu(true) },
        ]}
      />
      </div>
      {menu ? <div class="rl-msgmenu-scrim" onClick={() => setMenu(false)} /> : null}
      <Presence show={menu} exitMs={160}>
        <div class="app-pagemenu">
          <Menu label="Меню настроек" onClose={() => setMenu(false)} items={[{ icon: 'logout', label: 'Выйти', danger: true, onClick: () => setConfirm(true) }]} />
        </div>
      </Presence>
      <div class="rl-settings" ref={scroll.ref} onScroll={scroll.onScroll}>
        <ProfileHeader name={me.name} tone={peerTone(me.userId)} subtitle={status.phase === 'offline' ? 'нет сети' : 'в сети'} size={96} />
        {hasInfo ? (
          <Section>
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
          <InfoRow icon="info" title="Relay" subtitle={'Сборка ' + __BUILD__} />
        </Section>
      </div>
      <Presence show={toast != null} exitMs={200}>
        <div class="app-toast"><Toast>{toast ?? lastToast.current}</Toast></div>
      </Presence>
      <ConfirmDialog open={confirm} danger title="Выйти из Relay?" text="Чтобы войти снова, понадобится войти заново. Данные чатов на этом устройстве будут удалены." confirm="Выйти" cancel="Отмена" onCancel={() => setConfirm(false)} onConfirm={() => { setConfirm(false); void logout().then((ok) => { if (!ok) flash('Не удалось выйти. Проверьте подключение.'); }); }} />
    </div>
  );
}
