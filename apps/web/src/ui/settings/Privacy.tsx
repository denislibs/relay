import { CheckRow, ChatRowSkeleton, InfoRow, PanelHeader, Presence, Section, SelectRow, useMinVisible } from '@relay/ui';
import { useEffect, useState } from 'preact/hooks';
import { getPassword, listPasskeys } from '../../authSettings';
import { useGlobal } from '../../global';
import { back, go } from '../../nav';
import { setPref } from '../../prefs';
import { prefetch, refreshSettings, registerPrefetch } from '../../settingsData';
import { useScrollMemory } from '../useScrollMemory';
import { RULE_KEYS, RULE_TITLE, ruleSubtitle } from './privacyLogic';

// предзагрузка: правила приходят вместе с настройками аккаунта, чёрный список движок держит сам
registerPrefetch('settings/privacy', () => { void refreshSettings(); });
for (const k of RULE_KEYS) registerPrefetch('settings/privacy/rule/' + k, () => { void refreshSettings(); });

const ICON: Record<string, [string, 'green' | 'blue' | 'gray' | 'purple']> = {
  phone: ['phone', 'green'], lastSeen: ['clock', 'blue'], bio: ['info', 'gray'], birthday: ['cake', 'purple'],
};

/** «Конфиденциальность»: правила (подпись — режим и исключения) и чёрный список. */
export function Privacy() {
  const privacy = useGlobal((s) => s.settings.privacy);
  const loaded = useGlobal((s) => s.settings.loaded);
  const blocked = useGlobal((s) => s.blocked.length);
  const phase = useGlobal((s) => s.status.phase);
  // первый визит: правила с сервера ещё не пришли — скелет, без перескока с умолчаний
  const waiting = !loaded && phase !== 'offline';
  const skeleton = useMinVisible(waiting, { delay: 150, min: 600 });
  const screen = useGlobal((s) => s.prefs.screen);
  const scroll = useScrollMemory('settings/privacy');
  // вход: облачный пароль и паскеи — с сервера при каждом заходе (меняются редко, но могли смениться на другом устройстве)
  const [pw, setPw] = useState<boolean | null>(null);
  const [keys, setKeys] = useState<number | null>(null);
  useEffect(() => {
    void getPassword().then((r) => { if (r.ok) setPw(r.data.enabled); });
    void listPasskeys().then((r) => { if (r.ok) setKeys(r.data.passkeys.length); });
  }, []);

  return (
    <div class="rl-sidepage" aria-label="Конфиденциальность">
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title="Конфиденциальность" onClose={() => void back()} />
      <div class="rl-settings" ref={scroll.ref} onScroll={scroll.onScroll}>
        <Section title="Вход">
          <InfoRow tile="green" icon="lock" title="Облачный пароль" value={pw == null ? undefined : pw ? 'Вкл.' : 'Выкл.'} onClick={() => void go('settings/privacy/password')} />
          <InfoRow tile="blue" icon="key" title="Паскеи" value={keys ? keys : undefined} onClick={() => void go('settings/privacy/passkeys')} />
        </Section>
        <Section>
          <div onPointerEnter={() => prefetch('settings/privacy/blocked')}>
            <InfoRow tile="red" icon="block" title="Заблокированные" value={blocked || undefined} onClick={() => void go('settings/privacy/blocked')} />
          </div>
        </Section>
        <div class="app-listwrap">
          <Presence show={skeleton} exitMs={280}>
            <div class="app-skel" aria-busy="true" aria-label="Загрузка правил">
              <Section>{[0, 1, 2, 3].map((i) => <div key={i} style={{ '--i': i }}><ChatRowSkeleton /></div>)}</Section>
            </div>
          </Presence>
          {waiting || skeleton ? null : (
            <Section title="Конфиденциальность">
              {RULE_KEYS.map((k) => (
                <div key={k} onPointerEnter={() => prefetch('settings/privacy/rule/' + k)}>
                  <InfoRow tile={ICON[k][1]} icon={ICON[k][0]} title={RULE_TITLE[k]} subtitle={ruleSubtitle(privacy[k])} onClick={() => void go('settings/privacy/rule/' + k)} />
                </div>
              ))}
            </Section>
          )}
        </div>
        <Section setting="privacy.screen" title="Экран" footer="Эти настройки действуют только на этом устройстве.">
          <CheckRow setting="privacy.screen.blur" label="Размывать, когда вкладка не в фокусе" checked={screen.blur} onChange={(on: boolean) => setPref('screen.blur', on)} />
          <Presence show={screen.blur} exitMs={200}>
            <SelectRow
              label="Задержка" value={screen.blurDelay} onChange={(v: number | string) => setPref('screen.blurDelay', Number(v))}
              options={[{ value: 0, label: 'Сразу' }, { value: 5, label: '5 секунд' }, { value: 30, label: '30 секунд' }]}
            />
          </Presence>
          <CheckRow setting="privacy.screen.title" label="Не показывать чат в заголовке вкладки" checked={screen.hideChatInTitle} onChange={(on: boolean) => setPref('screen.hideChatInTitle', on)} />
          <CheckRow setting="privacy.screen.unread" label="Не показывать непрочитанные в заголовке и значке" checked={screen.hideUnreadInTitle} onChange={(on: boolean) => setPref('screen.hideUnreadInTitle', on)} />
          <CheckRow setting="privacy.screen.notifyText" label="Скрывать текст в уведомлениях" checked={screen.hideNotifyText} onChange={(on: boolean) => setPref('screen.hideNotifyText', on)} />
        </Section>
      </div>
    </div>
  );
}
