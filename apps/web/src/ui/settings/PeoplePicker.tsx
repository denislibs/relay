import { ConfirmDialog, ContactPicker, Fab, PanelHeader, Presence, peerTone } from '@relay/ui';
import { useEffect, useState } from 'preact/hooks';
import { useGlobal } from '../../global';
import { back, setLeaveGuard } from '../../nav';
import { setPrivacy, showToast } from '../../settingsData';
import { candidates, parseRulePath, RULE_TITLE, samePeople, withPeople, type RuleKey } from './privacyLogic';

/** Выбор людей для исключения «Всегда показывать» / «Никогда не показывать»: контакты и собеседники, поиск, ✓ — сохранить. */
export function PeoplePicker({ path }: { path: string }) {
  const parsed = parseRulePath(path);
  const key = parsed?.key ?? 'lastSeen';
  const list = parsed?.list ?? 'allow';
  const rule = useGlobal((s) => s.settings.privacy[key]);
  const loaded = useGlobal((s) => s.settings.loaded);
  const title = list === 'allow' ? 'Всегда показывать' : 'Никогда не показывать';
  return (
    <div class="rl-sidepage" aria-label={`${RULE_TITLE[key]}: ${title}`}>
      {/* ключ — по загрузке: выбор начинается с того, что уже сохранено на сервере */}
      <Picker key={String(loaded)} ruleKey={key} list={list} initial={rule[list]} title={title} />
    </div>
  );
}

function Picker({ ruleKey, list, initial, title }: { ruleKey: RuleKey; list: 'allow' | 'deny'; initial: number[]; title: string }) {
  const me = useGlobal((s) => s.me!.userId);
  const contacts = useGlobal((s) => s.contacts);
  const chats = useGlobal((s) => s.chats);
  const blocked = useGlobal((s) => s.blocked);
  const rule = useGlobal((s) => s.settings.privacy[ruleKey]);
  const [picked, setPicked] = useState<number[]>(initial);
  const [ask, setAsk] = useState<((ok: boolean) => void) | null>(null);
  const dirty = !samePeople(picked, rule[list]);
  const people = candidates(contacts, chats, me, [...initial, ...picked], blocked);

  // уход с несохранённым выбором: «Сбросить изменения?»
  const arm = () => setLeaveGuard(() => new Promise<boolean>((resolve) => setAsk(() => resolve)));
  useEffect(() => {
    if (!dirty) { setLeaveGuard(null); return; }
    arm();
    return () => setLeaveGuard(null);
  }, [dirty]);
  const answer = (leave: boolean) => { ask?.(leave); setAsk(null); };

  function save(): void {
    if (!dirty) return;
    setLeaveGuard(null);
    void setPrivacy(ruleKey, withPeople(rule, list, picked)).then(() => back(), () => { arm(); showToast('Не удалось сохранить изменения'); });
  }

  return (
    <>
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title={title} onClose={() => void back()} />
      <div class="rl-page-scroll app-people">
        <ContactPicker
          multi contacts={people.map((p) => ({ ...p, tone: peerTone(p.id) }))} selected={initial} onChange={(ids: number[]) => setPicked(ids)}
          searchLabel="Поиск людей" placeholder="Имя или @имя пользователя"
          empty="Здесь появятся ваши контакты и собеседники по личным чатам."
        />
      </div>
      <Presence show={dirty} exitMs={200}>
        <div class="rl-fab-slot"><Fab icon="check" label="Сохранить" onClick={save} /></div>
      </Presence>
      <ConfirmDialog open={!!ask} danger title="Сбросить изменения?" text="Выбранные люди не сохранятся." confirm="Сбросить" cancel="Отмена" onCancel={() => answer(false)} onConfirm={() => answer(true)} />
    </>
  );
}
