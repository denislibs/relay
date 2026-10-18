/**
 * Ссылки профиля. Адрес не вводится целиком: пользователь выбирает сервис и пишет имя, а ссылку собираем сами
 * по шаблону сервиса — подменить сайт (instagram.com.evil.io, javascript:) нельзя. Правила имён — как у сервисов.
 */
export type LinkService = 'instagram' | 'x' | 'linkedin' | 'github' | 'youtube' | 'tiktok' | 'telegram' | 'dribbble' | 'behance';
export interface ProfileLink { service: LinkService; handle: string }

interface ServiceSpec { title: string; host: string; path: string; re: RegExp }
/** host + path + имя = адрес; порядок — как в списке выбора. */
export const LINK_SERVICES: Record<LinkService, ServiceSpec> = {
  linkedin: { title: 'LinkedIn', host: 'linkedin.com', path: '/in/', re: /^[A-Za-z0-9-]{3,100}$/ },
  github: { title: 'GitHub', host: 'github.com', path: '/', re: /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/ },
  instagram: { title: 'Instagram', host: 'instagram.com', path: '/', re: /^[A-Za-z0-9._]{1,30}$/ },
  x: { title: 'X', host: 'x.com', path: '/', re: /^[A-Za-z0-9_]{1,15}$/ },
  youtube: { title: 'YouTube', host: 'youtube.com', path: '/@', re: /^[A-Za-z0-9._-]{3,30}$/ },
  tiktok: { title: 'TikTok', host: 'tiktok.com', path: '/@', re: /^[A-Za-z0-9._]{2,24}$/ },
  telegram: { title: 'Telegram', host: 't.me', path: '/', re: /^[A-Za-z][A-Za-z0-9_]{4,31}$/ },
  dribbble: { title: 'Dribbble', host: 'dribbble.com', path: '/', re: /^[A-Za-z0-9_-]{2,40}$/ },
  behance: { title: 'Behance', host: 'behance.net', path: '/', re: /^[A-Za-z0-9_-]{3,40}$/ },
};
export const LINK_SERVICE_IDS = Object.keys(LINK_SERVICES) as LinkService[];
export const MAX_LINKS = 10;

const isService = (s: unknown): s is LinkService => typeof s === 'string' && Object.prototype.hasOwnProperty.call(LINK_SERVICES, s);

/** То, что видно в поле: «linkedin.com/in/» — без схемы. */
export const linkPrefix = (s: LinkService) => LINK_SERVICES[s].host + LINK_SERVICES[s].path;
export const linkUrl = (l: ProfileLink) => 'https://' + linkPrefix(l.service) + encodeURIComponent(l.handle);
export const linkLabel = (l: ProfileLink) => linkPrefix(l.service) + l.handle;

/**
 * Имя из ввода: вставленный целиком адрес этого сервиса («https://www.github.com/hoho/»), «@hoho» или просто «hoho».
 * Чужой сайт, лишний путь или запрещённые символы — null.
 */
export function parseLinkHandle(service: LinkService, raw: string): string | null {
  const spec = LINK_SERVICES[service];
  let s = raw.trim();
  const url = /^(?:https?:\/\/)?(?:www\.|m\.)?([^/?#\s]+)(\/[^?#\s]*)?(?:[?#]\S*)?$/i.exec(s);
  // адрес — когда есть схема или путь; «my.name» без них — имя (у Instagram и YouTube точки в именах)
  if (url && /\./.test(url[1]) && (/^https?:\/\//i.test(s) || url[2] !== undefined)) {
    if (url[1].toLowerCase() !== spec.host) return null;
    const path = (url[2] ?? '/').replace(/\/+$/, '');
    if (!path.toLowerCase().startsWith(spec.path.replace(/\/$/, '').toLowerCase() || '/')) return null;
    s = path.replace(new RegExp('^' + spec.path.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'), 'i'), '');
  }
  s = s.replace(/^@/, '');
  return spec.re.test(s) ? s : null;
}

/** Список от клиента: только известные сервисы и правильные имена, без повторов, не больше MAX_LINKS. Иначе null. */
export function normalizeLinks(raw: unknown): ProfileLink[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_LINKS) return null;
  const out: ProfileLink[] = [], seen = new Set<string>();
  for (const l of raw) {
    if (!l || typeof l !== 'object' || !isService((l as ProfileLink).service) || typeof (l as ProfileLink).handle !== 'string') return null;
    const service = (l as ProfileLink).service, handle = parseLinkHandle(service, (l as ProfileLink).handle);
    if (!handle) return null;
    const key = service + ':' + handle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ service, handle });
  }
  return out;
}
