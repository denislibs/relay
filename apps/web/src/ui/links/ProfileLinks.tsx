import { linkLabel, linkUrl, type ProfileLink } from '@relay/protocol';
import { Icon, SettingsIcon, reducedMotion, ripple } from '@relay/ui';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { LINK_TITLE } from './LinkEdit';
import { ServiceIcon } from './ServiceIcon';

const STACK = 3;          // сколько значков видно в свёрнутой строке; всего — в счётчике рядом
const FLY_MS = 420, STEP_MS = 70, TURN_MS = 230, SHIFT_MS = 200, EASE = 'cubic-bezier(.22, .9, .3, 1)';

/** Одна ссылка — строка как @username: значок сервиса, адрес, название сервиса; клик открывает сайт. */
function LinkRow({ link }: { link: ProfileLink }) {
  return (
    <a class="rl-inforow app-plink-row" href={linkUrl(link)} target="_blank" rel="noopener noreferrer" onPointerDown={ripple}>
      <ServiceIcon service={link.service} size={32} />
      <span class="rl-inforow-text app-plink-text"><span class="app-plink-addr">{linkLabel(link)}</span><small>{LINK_TITLE[link.service]}</small></span>
    </a>
  );
}

/**
 * Полёт значка между стопкой в заголовке и строкой списка: копия в body (список обрезан своей высотой,
 * копию это не касается), оригиналы на время полёта скрыты. Возвращает обещание конца полёта.
 */
function fly(from: HTMLElement, to: HTMLElement, delay: number, fromRect?: DOMRect): Promise<void> {
  const a = fromRect ?? from.getBoundingClientRect(), b = to.getBoundingClientRect();
  const ghost = from.cloneNode(true) as HTMLElement;
  const radius = getComputedStyle(from).borderRadius, radiusTo = getComputedStyle(to).borderRadius;
  Object.assign(ghost.style, { visibility: 'visible', position: 'fixed', left: a.left + 'px', top: a.top + 'px', width: a.width + 'px', height: a.height + 'px', margin: '0', zIndex: '1000', pointerEvents: 'none', transformOrigin: '0 0' });
  document.body.appendChild(ghost);
  const k = b.width / a.width;
  const anim = ghost.animate([
    { transform: 'translate(0, 0) scale(1)', borderRadius: radius },
    { transform: `translate(${b.left - a.left}px, ${b.top - a.top}px) scale(${k})`, borderRadius: radiusTo },
  ], { duration: FLY_MS, delay, easing: EASE, fill: 'both' });
  return anim.finished.then(() => ghost.remove(), () => ghost.remove());
}

/**
 * Ссылки профиля в карточке информации. Одна — сразу строкой с адресом. Несколько — одна строка «Ссылки»
 * со счётчиком и стопкой значков; по клику значки по очереди спускаются каждый в свою строку,
 * за ним проявляется адрес. Сворачивание — тот же путь обратно.
 */
export function ProfileLinks({ links }: { links: ProfileLink[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const busy = useRef(false);
  const pending = useRef<'open' | 'close' | null>(null);

  // после смены состояния строки уже на своих местах — можно лететь
  useLayoutEffect(() => {
    const dir = pending.current, el = root.current;
    pending.current = null;
    if (!dir || !el) return;
    const stack = [...el.querySelectorAll<HTMLElement>('.app-plinks-stack .app-svc')];
    const rows = [...el.querySelectorAll<HTMLElement>('.app-plinks-item')];
    const icon = (r: HTMLElement) => r.querySelector<HTMLElement>('.app-svc')!;
    const text = (r: HTMLElement) => r.querySelector<HTMLElement>('.app-plink-text')!;
    busy.current = true;
    const flights: Promise<void>[] = [];
    if (dir === 'open') {
      // по очереди с первого места стопки: улетел первый — остальные съезжают на шаг влево, следующий летит оттуда же
      const slot0 = stack[0].getBoundingClientRect();
      const step = stack.length > 1 ? stack[1].getBoundingClientRect().left - slot0.left : 0;
      const shifts: Animation[] = [];
      stack.forEach((s) => { s.style.visibility = 'visible'; });   // контейнер стопки уже скрыт (is-open) — значки показываем сами
      rows.forEach((r, i) => {
        const delay = i * TURN_MS;
        const ic = icon(r), tx = text(r);
        if (i < stack.length) {
          ic.style.visibility = 'hidden';
          setTimeout(() => {
            stack[i].style.visibility = 'hidden';
            for (let j = i + 1; j < stack.length; j++) {
              shifts.push(stack[j].animate([{ transform: `translateX(${-step * i}px)` }, { transform: `translateX(${-step * (i + 1)}px)` }], { duration: SHIFT_MS, easing: EASE, fill: 'forwards' }));
            }
          }, delay);
          flights.push(fly(stack[i], ic, delay, slot0).then(() => { ic.style.visibility = ''; }));
        } else {
          ic.animate([{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'none' }], { duration: 260, delay: delay + FLY_MS * 0.5, easing: EASE, fill: 'backwards' });
        }
        tx.animate([{ opacity: 0, transform: 'translateX(-10px)' }, { opacity: 1, transform: 'none' }], { duration: 280, delay: delay + FLY_MS * 0.6, easing: EASE, fill: 'backwards' });
      });
      void Promise.all(flights).then(() => { shifts.forEach((a) => a.cancel()); stack.forEach((s) => { s.style.visibility = ''; }); busy.current = false; });
    } else {
      stack.forEach((s) => { s.style.visibility = 'hidden'; });
      const back = rows.slice(0, stack.length).reverse();
      back.forEach((r, j) => {
        const i = rows.indexOf(r);
        const ic = icon(r);
        flights.push(fly(ic, stack[i], j * STEP_MS).then(() => { stack[i].style.visibility = ''; }));
        ic.style.visibility = 'hidden';
      });
      void Promise.all(flights).then(() => { rows.forEach((r) => { icon(r).style.visibility = ''; }); busy.current = false; });
    }
  }, [open]);

  if (!links.length) return null;
  if (links.length === 1) return <LinkRow link={links[0]} />;

  const toggle = () => {
    if (busy.current) return;
    if (reducedMotion()) { setOpen((v) => !v); return; }
    if (open) {
      // сначала тают адреса, потом значки летят обратно и список сворачивается
      const texts = [...(root.current?.querySelectorAll<HTMLElement>('.app-plink-text') ?? [])];
      texts.forEach((t) => t.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: 'forwards' }).finished.then(() => setTimeout(() => t.getAnimations().forEach((a) => a.cancel()), FLY_MS + 400)));
      pending.current = 'close';
      setTimeout(() => setOpen(false), 90);
    } else {
      pending.current = 'open';
      setOpen(true);
    }
  };

  return (
    <div ref={root} class={'app-plinks' + (open ? ' is-open' : '')}>
      <button type="button" class="rl-inforow app-plinks-head" aria-expanded={open} onPointerDown={ripple} onClick={toggle}>
        <SettingsIcon icon="link" color="blue" />
        <span class="rl-inforow-text"><span>Ссылки</span><small>{links.map((l) => LINK_TITLE[l.service]).join(', ')}</small></span>
        <span class="app-plinks-stack" aria-hidden="true">
          {links.slice(0, STACK).map((l) => <ServiceIcon key={l.service + ':' + l.handle} service={l.service} size={26} />)}
        </span>
        <span class="rl-inforow-count">{links.length}</span>
        <span class="app-plinks-chev" aria-hidden="true"><Icon name="chevronDown" size={20} /></span>
      </button>
      <div class="app-expand" data-state={open ? 'open' : 'closed'}>
        <div class="app-expand-inner" role="list" aria-label="Ссылки">
          {links.map((l) => <div role="listitem" class="app-plinks-item" key={l.service + ':' + l.handle}><LinkRow link={l} /></div>)}
        </div>
      </div>
    </div>
  );
}
