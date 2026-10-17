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
  const v = al[kind] ?? al.photo;
  const set = (field: 'contacts' | 'private' | 'groups') => (on: boolean) => setPref(`autoload.${kind}.${field}`, on);
  const idx = Math.max(0, STEPS.indexOf(al.fileMaxMb));

  return (
    <div class="rl-sidepage" aria-label={TITLE[kind]}>
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title={TITLE[kind] ?? 'Автозагрузка'} onClose={() => void back()} />
      <div class="rl-settings" ref={scroll.ref} onScroll={scroll.onScroll}>
        <Section title="Автозагрузка" footer="Без автозагрузки вложение скачивается по нажатию.">
          <CheckRow label="Контакты" checked={v.contacts} onChange={set('contacts')} />
          <CheckRow label="Личные чаты" checked={v.private} onChange={set('private')} />
          <CheckRow label="Группы" checked={v.groups} onChange={set('groups')} />
        </Section>
        {kind === 'file' ? (
          <Section footer="Файлы больше этого размера не загружаются сами.">
            <RangeRow
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
