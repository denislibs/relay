import { Fragment } from 'preact';
import { comboKeys, IS_APPLE, PanelHeader, RadioRow, Section } from '@relay/ui';
import { useGlobal } from '../../global';
import { back } from '../../nav';
import { setPref } from '../../prefs';
import { shortcutSections, type Shortcut } from '../../shortcuts';
import { useScrollMemory } from '../useScrollMemory';

/** Одно сочетание: клавиши-чипы через «+» (на Apple символы ⌘⇧ стоят вплотную, как в меню macOS). */
function Combo({ combo, range }: { combo: string; range?: string }) {
  const keys = comboKeys(combo);
  if (range) keys[keys.length - 1] = range;
  return (
    <span class="app-combo">
      {keys.map((k, i) => (
        <Fragment key={i}>
          {i > 0 && !IS_APPLE ? <span class="app-combo-plus" aria-hidden="true">+</span> : null}
          <kbd class="app-kbd">{k}</kbd>
        </Fragment>
      ))}
    </span>
  );
}

function Row({ s }: { s: Shortcut }) {
  const label = s.combos.map((c) => comboKeys(c).join(IS_APPLE ? '' : '+')).join(' или ');
  return (
    <div class="app-sc-row" role="listitem" data-setting={'shortcut.' + s.id} aria-label={`${s.title}: ${label}`}>
      <span class="rl-optrow-text">
        <span>{s.title}</span>
        {s.hint ? <small>{s.hint}</small> : null}
      </span>
      <span class="app-sc-keys" aria-hidden="true">
        {s.combos.map((c, i) => (
          <Fragment key={c}>
            {i > 0 ? <span class="app-combo-or">/</span> : null}
            <Combo combo={c} range={s.range} />
          </Fragment>
        ))}
      </span>
    </div>
  );
}

export function Shortcuts() {
  const sendKey = useGlobal((s) => s.prefs.sendKey);
  const scroll = useScrollMemory('settings/general/shortcuts');
  const mod = IS_APPLE ? '⌘' : 'Ctrl';
  return (
    <div class="rl-sidepage" aria-label="Сочетания клавиш">
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title="Сочетания клавиш" onClose={() => void back()} />
      <div class="rl-settings" ref={scroll.ref} onScroll={scroll.onScroll}>
        <Section title="Отправка сообщений" role="radiogroup" footer="Как отправлять сообщения и переносить строку.">
          <RadioRow label="Enter — отправить" subtitle="Shift+Enter — новая строка" checked={sendKey === 'enter'} onClick={() => setPref('sendKey', 'enter')} />
          <RadioRow label={`${mod}+Enter — отправить`} subtitle="Enter — новая строка" checked={sendKey === 'ctrlEnter'} onClick={() => setPref('sendKey', 'ctrlEnter')} />
        </Section>
        {shortcutSections(sendKey).map((sec) => (
          <Section setting={'shortcuts.' + sec.id} key={sec.id} title={sec.title} footer={sec.footer}>
            <div role="list">{sec.items.map((s) => <Row key={s.id} s={s} />)}</div>
          </Section>
        ))}
      </div>
    </div>
  );
}
