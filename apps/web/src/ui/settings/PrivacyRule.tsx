import type { PrivacyMode } from '@relay/protocol';
import { ChatRowSkeleton, InfoRow, PanelHeader, Presence, RadioRow, Section, useMinVisible } from '@relay/ui';
import { useGlobal } from '../../global';
import { back, go } from '../../nav';
import { setPrivacy } from '../../settingsData';
import { DISCOVERY_TITLE, discoveryCaption, EXCEPTIONS_FOOTER, MODE_LABEL, parseRulePath, peopleCount, RULE_QUESTION, RULE_TITLE, ruleCaption } from './privacyLogic';

const MODES: PrivacyMode[] = ['everyone', 'contacts', 'nobody'];

/** Экран правила: радио «Все / Мои контакты / Никто», подпись по выбору, исключения; у номера — «Кто найдёт меня по номеру». */
export function PrivacyRule({ path }: { path: string }) {
  const parsed = parseRulePath(path);
  const key = parsed?.key ?? 'lastSeen';
  const rule = useGlobal((s) => s.settings.privacy[key]);
  const discovery = useGlobal((s) => s.settings.privacy.phoneDiscovery);
  const loaded = useGlobal((s) => s.settings.loaded);
  const phase = useGlobal((s) => s.status.phase);
  const waiting = !loaded && phase !== 'offline';
  const skeleton = useMinVisible(waiting, { delay: 150, min: 600 });

  // радио меняется сразу (очередь операций), исключения сохраняются вместе с режимом
  const pick = (mode: PrivacyMode) => { if (mode !== rule.mode) void setPrivacy(key, { mode, allow: rule.allow, deny: rule.deny }); };
  const pickDiscovery = (mode: PrivacyMode) => { if (mode !== discovery.mode) void setPrivacy('phoneDiscovery', { mode }); };

  return (
    <div class="rl-sidepage" aria-label={RULE_TITLE[key]}>
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title={RULE_TITLE[key]} onClose={() => void back()} />
      <div class="rl-settings">
        <div class="app-listwrap">
          <Presence show={skeleton} exitMs={280}>
            <div class="app-skel" aria-busy="true" aria-label="Загрузка правила">
              <Section>{[0, 1, 2].map((i) => <div key={i} style={{ '--i': i }}><ChatRowSkeleton /></div>)}</Section>
            </div>
          </Presence>
          {waiting || skeleton ? null : (
            <>
              <Section title={RULE_QUESTION[key]} role="radiogroup" footer={ruleCaption(key, rule.mode)}>
                {MODES.map((m) => <RadioRow key={m} label={MODE_LABEL[m]} checked={rule.mode === m} onClick={() => pick(m)} />)}
              </Section>
              {key === 'phone' && rule.mode !== 'everyone' ? (
                <Section title={DISCOVERY_TITLE} role="radiogroup" footer={discoveryCaption(discovery.mode)}>
                  {(['everyone', 'contacts'] as const).map((m) => <RadioRow key={m} label={MODE_LABEL[m]} checked={discovery.mode === m} onClick={() => pickDiscovery(m)} />)}
                </Section>
              ) : null}
              <Section title="Исключения" footer={rule.mode === 'contacts' ? EXCEPTIONS_FOOTER : undefined}>
                {rule.mode !== 'everyone' ? <InfoRow icon="userPlus" title="Всегда показывать" subtitle={peopleCount(rule.allow.length)} onClick={() => void go(path + '/allow')} /> : null}
                {rule.mode !== 'nobody' ? <InfoRow icon="block" title="Никогда не показывать" subtitle={peopleCount(rule.deny.length)} onClick={() => void go(path + '/deny')} /> : null}
              </Section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
