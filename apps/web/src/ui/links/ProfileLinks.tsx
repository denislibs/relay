import { linkLabel, linkUrl, type ProfileLink } from '@relay/protocol';
import { Icon } from '@relay/ui';
import { useState } from 'preact/hooks';
import { LINK_TITLE } from './LinkEdit';
import { ServiceIcon } from './ServiceIcon';

/**
 * Ссылки под профилем — одна полоска: значки внахлёст в порядке владельца (каждый открывает сайт),
 * справа — кнопка-скрепка, раскрывающая список с адресами.
 */
export function ProfileLinks({ links }: { links: ProfileLink[] }) {
  const [open, setOpen] = useState(false);
  if (!links.length) return null;
  const key = (l: ProfileLink) => l.service + ':' + l.handle;
  return (
    <div class={'app-plinks' + (open ? ' app-plinks-open' : '')}>
      <div class="app-plinks-bar">
        <div class="app-plinks-stack" role="list" aria-label="Ссылки">
          {links.map((l, i) => (
            <a
              key={key(l)} role="listitem" class="app-plink-dot" style={{ zIndex: links.length - i }}
              href={linkUrl(l)} target="_blank" rel="noopener noreferrer" title={linkLabel(l)} aria-label={`${LINK_TITLE[l.service]}: ${linkLabel(l)}`}
            >
              <ServiceIcon service={l.service} size={36} mono />
            </a>
          ))}
        </div>
        <button type="button" class="app-plinks-more" aria-expanded={open} aria-label={open ? 'Скрыть адреса ссылок' : 'Показать адреса ссылок'} onClick={() => setOpen(!open)}>
          <Icon name="link" size={22} />
        </button>
      </div>
      <div class="app-plinks-list" inert={!open}>
        <div>
          {links.map((l) => (
            <a key={key(l)} class="app-plink-row" href={linkUrl(l)} target="_blank" rel="noopener noreferrer">
              <ServiceIcon service={l.service} size={32} />
              <span class="rl-inforow-text"><span>{LINK_TITLE[l.service]}</span><small>{linkLabel(l)}</small></span>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
