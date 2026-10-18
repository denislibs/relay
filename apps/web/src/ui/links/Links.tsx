import { linkLabel, MAX_LINKS, type ProfileLink } from '@relay/protocol';
import { Button, Icon, IconButton, InfoRow, PanelHeader, Section } from '@relay/ui';
import { useRef, useState } from 'preact/hooks';
import { useGlobal } from '../../global';
import { back, go } from '../../nav';
import { setLinks, showToast } from '../../settingsData';
import { LINK_TITLE } from './LinkEdit';
import { dropIndex, moveLink, shiftFor } from './linkList';
import { ServiceIcon } from './ServiceIcon';

type Drag = { from: number; to: number; dy: number; rowH: number; y0: number; id: number };

const save = (links: ProfileLink[]) => { setLinks(links).catch(() => showToast('Не удалось сохранить ссылки')); };

/** Страница «Ссылки»: пусто — рассказ и кнопка; иначе — список в порядке профиля (перетаскивание за ручку, Alt+↑/↓). */
export function Links() {
  const links = useGlobal((s) => s.me?.links) ?? [];
  const [drag, setDrag] = useState<Drag | null>(null);
  const [settling, setSettling] = useState(false);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;

  const onDown = (i: number) => (e: PointerEvent) => {
    if (e.button !== 0) return;
    const row = (e.currentTarget as HTMLElement).closest('.app-link-row') as HTMLElement;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
    setDrag({ from: i, to: i, dy: 0, rowH: row.getBoundingClientRect().height, y0: e.clientY, id: e.pointerId });
  };
  const onMove = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.id) return;
    // строка не выезжает за край списка (карточка обрезает)
    const dy = Math.max(-d.from * d.rowH, Math.min((links.length - 1 - d.from) * d.rowH, e.clientY - d.y0));
    setDrag({ ...d, dy, to: dropIndex(d.from, dy, d.rowH, links.length) });
  };
  const onUp = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.id) return;
    setDrag(null);
    if (d.to !== d.from) {
      // новый порядок встаёт без анимации: строки уже стоят на местах, иначе соседи «отъедут» обратно
      setSettling(true);
      requestAnimationFrame(() => requestAnimationFrame(() => setSettling(false)));
      save(moveLink(links, d.from, d.to));
    }
  };
  const onKey = (i: number) => (e: KeyboardEvent) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const to = i + (e.key === 'ArrowUp' ? -1 : 1);
    if (to < 0 || to >= links.length) return;
    save(moveLink(links, i, to));
    const host = (e.currentTarget as HTMLElement).parentElement?.parentElement;
    requestAnimationFrame(() => (host?.querySelectorAll<HTMLElement>('.app-link-open')[to])?.focus());
  };
  const remove = (i: number) => save(links.filter((_, k) => k !== i));

  return (
    <div class="rl-sidepage" aria-label="Ссылки">
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title="Ссылки" onClose={() => void back()} />
      <div class="rl-settings">
        {links.length === 0 ? (
          <div class="app-links-intro">
            <span class="app-links-hero" aria-hidden="true"><Icon name="link" size={44} /></span>
            <h2>Ссылки в профиле</h2>
            <p>Покажите, где ещё вас можно найти, — прямо под именем.</p>
            <ul>
              <li><Icon name="link" size={22} /><div><b>Все профили в одном месте</b><span>LinkedIn, GitHub и соцсети — кнопками в профиле.</span></div></li>
              <li><Icon name="lock" size={22} /><div><b>Только настоящие сайты</b><span>Ссылка собирается из имени пользователя, адрес нельзя подменить.</span></div></li>
              <li><Icon name="listOrdered" size={22} /><div><b>Ваш порядок</b><span>Главную ссылку — первой. Порядок меняется перетаскиванием.</span></div></li>
            </ul>
            <Button variant="primary" onClick={() => void go('settings/profile/links/new')}>Добавить ссылку</Button>
          </div>
        ) : (
          <>
            <Section footer="Ссылки показываются кнопками в профиле в этом порядке. Перетащите за ручку справа, чтобы поменять порядок.">
              <div class={'app-links-list' + (drag ? ' app-links-dragging' : '') + (settling ? ' app-links-settling' : '')} role="list" aria-label="Ссылки профиля">
                {links.map((l, i) => {
                  const dragging = drag?.from === i;
                  const shift = drag && !dragging ? shiftFor(i, drag.from, drag.to) * drag.rowH : 0;
                  return (
                    <div
                      key={l.service + ':' + l.handle} role="listitem"
                      class={'app-link-row' + (dragging ? ' app-link-row-drag' : '')}
                      style={{ transform: dragging ? `translateY(${drag!.dy}px)` : shift ? `translateY(${shift}px)` : undefined }}
                    >
                      <button type="button" class="app-link-open" onClick={() => void go('settings/profile/links/' + i)} onKeyDown={onKey(i)} aria-label={`${LINK_TITLE[l.service]}: ${linkLabel(l)}. Изменить`} aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown">
                        <ServiceIcon service={l.service} size={34} />
                        <span class="rl-inforow-text"><span>{LINK_TITLE[l.service]}</span><small>{linkLabel(l)}</small></span>
                      </button>
                      <IconButton icon="trash" label={'Удалить ' + LINK_TITLE[l.service]} onClick={() => remove(i)} />
                      <span class="app-link-grip" title="Перетащите, чтобы поменять порядок" aria-hidden="true" onPointerDown={onDown(i)} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
                        <Icon name="grip" size={22} />
                      </span>
                    </div>
                  );
                })}
              </div>
              {links.length < MAX_LINKS ? <InfoRow icon="plus" title="Добавить ссылку" onClick={() => void go('settings/profile/links/new')} /> : null}
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
