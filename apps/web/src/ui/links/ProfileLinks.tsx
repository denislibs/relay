import { linkLabel, linkUrl, type ProfileLink } from '@relay/protocol';
import { Icon, SettingsIcon, ripple } from '@relay/ui';
import { useState } from 'preact/hooks';
import { LINK_TITLE } from './LinkEdit';
import { ServiceIcon } from './ServiceIcon';

const STACK = 3;   // сколько значков видно в свёрнутой строке; всего — в счётчике рядом

/** Одна ссылка — строка как @username: значок сервиса, адрес, название сервиса; клик открывает сайт. */
function LinkRow({ link }: { link: ProfileLink }) {
  return (
    <a class="rl-inforow app-plink-row" href={linkUrl(link)} target="_blank" rel="noopener noreferrer" onPointerDown={ripple}>
      <ServiceIcon service={link.service} size={32} />
      <span class="rl-inforow-text"><span class="app-plink-addr">{linkLabel(link)}</span><small>{LINK_TITLE[link.service]}</small></span>
    </a>
  );
}

/**
 * Ссылки профиля в карточке информации. Одна — сразу строкой с адресом. Несколько — одна строка «Ссылки»
 * со счётчиком и значками сервисов; по клику под ней раскрывается список (адрес виден целиком, без наведения).
 */
export function ProfileLinks({ links }: { links: ProfileLink[] }) {
  const [open, setOpen] = useState(false);
  if (!links.length) return null;
  if (links.length === 1) return <LinkRow link={links[0]} />;
  return (
    <div class={'app-plinks' + (open ? ' is-open' : '')}>
      <button type="button" class="rl-inforow app-plinks-head" aria-expanded={open} onPointerDown={ripple} onClick={() => setOpen((v) => !v)}>
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
          {links.map((l) => <div role="listitem" key={l.service + ':' + l.handle}><LinkRow link={l} /></div>)}
        </div>
      </div>
    </div>
  );
}
