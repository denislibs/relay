import type { LinkService } from '@relay/protocol';

/**
 * Значки сервисов — свои упрощённые рисунки (не файлы логотипов) на фирменном цвете сервиса:
 * узнаются с первого взгляда, как в списке ссылок Telegram.
 */
const BG: Record<LinkService, string> = {
  instagram: 'linear-gradient(45deg, #f9a03f, #e1306c 50%, #833ab4)',
  x: '#000',
  linkedin: '#0a66c2',
  github: '#24292f',
  youtube: '#ff0033',
  tiktok: '#000',
  telegram: '#2aabee',
  dribbble: '#ea4c89',
  behance: '#1769ff',
};

const GLYPH: Record<LinkService, preact.JSX.Element> = {
  instagram: <g fill="none" stroke="#fff" stroke-width="1.9"><rect x="4.5" y="4.5" width="15" height="15" rx="4.5" /><circle cx="12" cy="12" r="3.4" /><circle cx="16.6" cy="7.4" r=".6" fill="#fff" stroke="none" /></g>,
  x: <g stroke="#fff" stroke-width="2" stroke-linecap="round"><path d="M6 5.5l12 13" /><path d="M18 5.5l-12 13" /></g>,
  linkedin: <g fill="#fff"><circle cx="7.4" cy="7" r="1.6" /><rect x="6" y="9.6" width="2.8" height="8.4" rx=".4" /><path d="M11 9.6h2.6v1.2c.6-.9 1.6-1.4 2.8-1.4 2 0 3.2 1.3 3.2 3.8V18h-2.8v-4.4c0-1.1-.5-1.7-1.4-1.7-1 0-1.6.7-1.6 1.8V18H11z" /></g>,
  github: <path fill="#fff" d="M12 3.6a8.4 8.4 0 0 0-2.66 16.37c.42.08.57-.18.57-.4v-1.5c-2.34.5-2.83-1-2.83-1-.38-.97-.93-1.23-.93-1.23-.76-.52.06-.5.06-.5.84.06 1.28.86 1.28.86.75 1.28 1.97.91 2.45.7.08-.54.29-.91.53-1.12-1.87-.21-3.83-.93-3.83-4.15 0-.92.33-1.67.86-2.26-.09-.21-.37-1.07.08-2.22 0 0 .7-.23 2.31.86a7.9 7.9 0 0 1 4.2 0c1.6-1.09 2.31-.86 2.31-.86.46 1.15.17 2.01.08 2.22.54.59.86 1.34.86 2.26 0 3.23-1.97 3.94-3.84 4.15.3.26.57.77.57 1.55v2.3c0 .22.15.48.58.4A8.4 8.4 0 0 0 12 3.6z" />,
  youtube: <path fill="#fff" d="M10 8.6v6.8l5.6-3.4z" />,
  tiktok: <path fill="#fff" d="M13.4 4.5h2.5c.2 1.7 1.4 3 3.1 3.2v2.6a5.7 5.7 0 0 1-3.1-1v5.4a4.6 4.6 0 1 1-4.6-4.6h.5v2.6h-.5a2 2 0 1 0 2.1 2z" />,
  telegram: <path fill="#fff" d="M5 11.6l12.6-4.9c.6-.2 1.1.1.9 1l-2.1 10c-.2.7-.6.9-1.2.5l-3.3-2.4-1.6 1.5c-.2.2-.3.3-.6.3l.2-3.4 6.1-5.5c.3-.2-.1-.4-.4-.2l-7.5 4.7-3.2-1c-.7-.2-.7-.7.1-1.1z" />,
  dribbble: <g fill="none" stroke="#fff" stroke-width="1.6"><circle cx="12" cy="12" r="7.5" /><path d="M7 6.6c3.6 3.6 6.4 8.6 7.4 12.4" /><path d="M4.6 10.6c4.4.3 9-.5 12.6-3" /><path d="M8.2 18.4c1.8-3.4 5.6-5.5 11.2-4.5" /></g>,
  behance: <text x="12" y="16.3" fill="#fff" font-family="Arial, sans-serif" font-size="11.5" font-weight="700" text-anchor="middle">Bē</text>,
};

export function ServiceIcon({ service, size = 32 }: { service: LinkService; size?: number }) {
  return (
    <span class="app-svc" style={{ width: size, height: size, background: BG[service] }} aria-hidden="true">
      <svg viewBox="0 0 24 24" width={size * 0.75} height={size * 0.75}>{GLYPH[service]}</svg>
    </span>
  );
}
