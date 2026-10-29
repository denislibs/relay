import { CheckRow, PanelHeader, RangeRow, Section } from '@relay/ui';
import { useGlobal } from '../../global';
import { back } from '../../nav';
import { setPref } from '../../prefs';
import { useScrollMemory } from '../useScrollMemory';

type Kind = 'photo' | 'video' | 'file';
const TITLE: Record<Kind, string> = { photo: 'Фото', video: 'Видео', file: 'Файлы' };
const STEPS = [1, 5, 10, 50, 100];   // МБ; ползунок идёт по индексу шага

/** Подстраница автозагрузки одного вида медиа: в каких чатах грузить и (для файлов) до какого размера. */
export function Autoload({ path }: { path: string }) {
  const kind = path.split('/').pop() as Kind;
  const al = useGlobal((s) => s.prefs.autoload);
  const scroll = useScrollMemory(path);
  const v = al[kind];
  const set = (field: 'contacts' | 'private' | 'groups') => (on: boolean) => setPref(`autoload.${kind}.${field}`, on);
  // значение вне сетки (старые настройки) показываем на ближайшем шаге
  const idx = STEPS.reduce((best, m, i) => (Math.abs(m - al.fileMaxMb) < Math.abs(STEPS[best] - al.fileMaxMb) ? i : best), 0);

  return (
    <div class="rl-sidepage" aria-label={TITLE[kind]}>
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title={TITLE[kind]} onClose={() => void back()} />
      <div class="rl-settings" ref={scroll.ref} onScroll={scroll.onScroll}>
        <Section title="Автозагрузка" footer="Без автозагрузки вложение скачивается по нажатию.">
          <CheckRow setting="autoload.contacts" label="Контакты" checked={v.contacts} onChange={set('contacts')} />
          <CheckRow setting="autoload.private" label="Личные чаты" checked={v.private} onChange={set('private')} />
          <CheckRow setting="autoload.groups" label="Группы" checked={v.groups} onChange={set('groups')} />
        </Section>
        {kind === 'file' ? (
          <Section footer="Файлы больше этого размера не загружаются сами.">
            <RangeRow setting="autoload.maxSize"
              label="Максимальный размер файла" min={0} max={STEPS.length - 1} step={1} value={idx}
              format={(i: number) => `до ${STEPS[i]} МБ`}
              marks={STEPS.map((m, i) => ({ value: i, label: String(m) }))}
              onChange={(i: number) => setPref('autoload.fileMaxMb', STEPS[i])}
            />
          </Section>
        ) : null}
      </div>
    </div>
  );
}
