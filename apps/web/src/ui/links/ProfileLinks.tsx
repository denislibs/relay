import { linkLabel, linkUrl, type ProfileLink } from '@relay/protocol';
import { Icon, SettingsIcon, reducedMotion, ripple } from '@relay/ui';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { LINK_TITLE } from './LinkEdit';
import { ServiceIcon } from './ServiceIcon';

const STACK = 3;          // сколько значков видно в свёрнутой строке; всего — в счётчике рядом
const FLY_MS = 420, STEP_MS = 70, CLOSE_TURN_MS = 70, CLOSE_FLY_MS = 300, SHIFT_MS = 160, EASE = 'cubic-bezier(.22, .9, .3, 1)';

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
function fly(from: HTMLElement, to: HTMLElement, delay: number, fromRect?: DOMRect, opts: { duration?: number; fade?: boolean } = {}): Promise<void> {
  const a = fromRect ?? from.getBoundingClientRect(), b = to.getBoundingClientRect();
  const ghost = from.cloneNode(true) as HTMLElement;
  const radius = getComputedStyle(from).borderRadius, radiusTo = getComputedStyle(to).borderRadius;
  Object.assign(ghost.style, { visibility: 'visible', position: 'fixed', left: a.left + 'px', top: a.top + 'px', width: a.width + 'px', height: a.height + 'px', margin: '0', zIndex: '1000', pointerEvents: 'none', transformOrigin: '0 0' });
  document.body.appendChild(ghost);
  const k = b.width / a.width;
  const anim = ghost.animate([
    { transform: 'translate(0, 0) scale(1)', borderRadius: radius, opacity: 1 },
    { transform: `translate(${b.left - a.left}px, ${b.top - a.top}px) scale(${k})`, borderRadius: radiusTo, opacity: opts.fade ? 0 : 1 },   // fade — растворяется в стопке
  ], { duration: opts.duration ?? FLY_MS, delay, easing: EASE, fill: 'both' });
  return anim.finished.then(() => ghost.remove(), () => ghost.remove());
}

/**
 * Ссылки профиля в карточке информации. Одна — сразу строкой с адресом. Несколько — одна строка «Ссылки»
 * со счётчиком и стопкой значков; по клику значки слетают каждый в свою строку, за ним проявляется адрес.
 * Сворачивание — по одному сверху: значок улетает в стопку, строки ниже поднимаются на его место.
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
    if (dir !== 'open' || !el) return;
    const stack = [...el.querySelectorAll<HTMLElement>('.app-plinks-stack .app-svc')];
    const rows = [...el.querySelectorAll<HTMLElement>('.app-plinks-item')];
    const icon = (r: HTMLElement) => r.querySelector<HTMLElement>('.app-svc')!;
    const text = (r: HTMLElement) => r.querySelector<HTMLElement>('.app-plink-text')!;
    busy.current = true;
    const flights: Promise<void>[] = [];
    // открытие: значки разом (с лёгкой лесенкой) слетают из стопки каждый в свою строку, за ним — адрес
    stack.forEach((s) => { s.style.visibility = 'hidden'; });
    rows.forEach((r, i) => {
      const delay = i * STEP_MS;
      const ic = icon(r), tx = text(r);
      if (i < stack.length) {
        ic.style.visibility = 'hidden';
        flights.push(fly(stack[i], ic, delay).then(() => { ic.style.visibility = ''; }));
      } else {
        ic.animate([{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'none' }], { duration: 260, delay: delay + FLY_MS * 0.5, easing: EASE, fill: 'backwards' });
      }
      tx.animate([{ opacity: 0, transform: 'translateX(-10px)' }, { opacity: 1, transform: 'none' }], { duration: 280, delay: delay + FLY_MS * 0.6, easing: EASE, fill: 'backwards' });
    });
    void Promise.all(flights).then(() => { stack.forEach((s) => { s.style.visibility = ''; }); busy.current = false; });
  }, [open]);

  if (!links.length) return null;
  if (links.length === 1) return <LinkRow link={links[0]} />;

  /**
   * Сворачивание по очереди сверху: улетает в стопку первый значок (его адрес тает), строки ниже
   * поднимаются на его место, улетает следующий — и так до конца; потом список схлопывается.
   */
  const close = () => {
    const el = root.current;
    if (!el) { setOpen(false); return; }
    const stack = [...el.querySelectorAll<HTMLElement>('.app-plinks-stack .app-svc')];
    const rows = [...el.querySelectorAll<HTMLElement>('.app-plinks-item')];
    const icon = (r: HTMLElement) => r.querySelector<HTMLElement>('.app-svc')!;
    const text = (r: HTMLElement) => r.querySelector<HTMLElement>('.app-plink-text')!;
    const rowH = rows.length > 1 ? rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top : 0;
    const first = icon(rows[0]).getBoundingClientRect();
    const anims: Animation[] = [];
    const flights: Promise<void>[] = [];
    busy.current = true;
    stack.forEach((s) => { s.style.visibility = 'hidden'; });
    rows.forEach((r, i) => {
      const at = i * CLOSE_TURN_MS;
      const ic = icon(r);
      anims.push(text(r).animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, delay: at, easing: 'ease', fill: 'forwards' }));
      // не поместившиеся в стопку летят под последний её значок и растворяются там
      const slot = Math.min(i, stack.length - 1), extra = i >= stack.length;
      flights.push(new Promise((done) => setTimeout(() => {
        void fly(ic, stack[slot], 0, first, { duration: CLOSE_FLY_MS, fade: extra }).then(() => { if (!extra) stack[slot].style.visibility = 'visible'; done(); });
        ic.style.visibility = 'hidden';
      }, at)));
      // строки ниже поднимаются на освободившееся место
      for (let j = i + 1; j < rows.length; j++) {
        anims.push(rows[j].animate([{ transform: `translateY(${-rowH * i}px)` }, { transform: `translateY(${-rowH * (i + 1)}px)` }], { duration: SHIFT_MS, delay: at + 30, easing: EASE, fill: 'forwards' }));
      }
    });
    // список схлопывается, пока последний значок ещё в полёте (строки к этому времени уже уехали)
    setTimeout(() => { rows.forEach((r) => { r.style.opacity = '0'; }); setOpen(false); }, (rows.length - 1) * CLOSE_TURN_MS + 60);
    void Promise.all(flights).then(() => {
      setTimeout(() => {
        anims.forEach((a) => a.cancel());
        rows.forEach((r) => { r.style.opacity = ''; icon(r).style.visibility = ''; });
        stack.forEach((s) => { s.style.visibility = ''; });
        busy.current = false;
      }, 200);
    });
  };

  const toggle = () => {
    if (busy.current) return;
    if (reducedMotion()) { setOpen((v) => !v); return; }
    if (open) { close(); return; }
    pending.current = 'open';
    setOpen(true);
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
