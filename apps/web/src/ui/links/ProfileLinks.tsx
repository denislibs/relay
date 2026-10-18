import { linkLabel, linkUrl, type ProfileLink } from '@relay/protocol';
import { SettingsIcon } from '@relay/ui';
import { LINK_TITLE } from './LinkEdit';
import { ServiceIcon } from './ServiceIcon';

/** Ссылки в профиле — строка кнопок-значков в порядке владельца; каждая открывает сайт в новой вкладке. */
export function ProfileLinks({ links }: { links: ProfileLink[] }) {
  if (!links.length) return null;
  return (
    <div class="rl-inforow rl-inforow-static app-plinks">
      <SettingsIcon icon="link" color="blue" />
      <span class="rl-inforow-text">
        <span class="app-plinks-row">
          {links.map((l) => (
            <a key={l.service + ':' + l.handle} class="app-plink" href={linkUrl(l)} target="_blank" rel="noopener noreferrer" title={linkLabel(l)} aria-label={`${LINK_TITLE[l.service]}: ${linkLabel(l)}`} onClick={(e) => e.stopPropagation()}>
              <ServiceIcon service={l.service} size={30} />
              <span>{l.handle}</span>
            </a>
          ))}
        </span>
        <small>Ссылки</small>
      </span>
    </div>
  );
}
