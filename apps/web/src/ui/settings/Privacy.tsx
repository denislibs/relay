import { ChatRowSkeleton, InfoRow, PanelHeader, Presence, Section, useMinVisible } from '@relay/ui';
import { useGlobal } from '../../global';
import { back, go } from '../../nav';
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
  const scroll = useScrollMemory('settings/privacy');

  return (
    <div class="rl-sidepage" aria-label="Конфиденциальность">
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title="Конфиденциальность" onClose={() => void back()} />
      <div class="rl-settings" ref={scroll.ref} onScroll={scroll.onScroll}>
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
      </div>
    </div>
  );
}
