import { linkLabel, linkUrl, type ProfileLink } from '@relay/protocol';
import { LINK_TITLE } from './LinkEdit';
import { ServiceIcon } from './ServiceIcon';

/**
 * Ссылки под именем профиля — ряд круглых кнопок сервисов в порядке владельца.
 * Каждая открывает сайт; при наведении над кнопкой всплывает адрес.
 */
export function ProfileLinks({ links }: { links: ProfileLink[] }) {
  if (!links.length) return null;
  return (
    <div class="app-plinks" role="list" aria-label="Ссылки">
      {links.map((l) => (
        <a
          key={l.service + ':' + l.handle} role="listitem" class="app-plink"
          href={linkUrl(l)} target="_blank" rel="noopener noreferrer" aria-label={`${LINK_TITLE[l.service]}: ${linkLabel(l)}`}
        >
          <ServiceIcon service={l.service} size={40} />
          <span class="app-plink-tip" aria-hidden="true">{linkLabel(l)}</span>
        </a>
      ))}
    </div>
  );
}
