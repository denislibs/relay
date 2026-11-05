// Тема чата (как «Изменить тему» в мобильном Telegram): id готовой темы из каталога, общий для всех участников.
// Ставится на сервере (PUT /chats/:id/theme), приходит в список (ChatSummary.theme) и журналом (chatTheme);
// открытый чат красится ею поверх своей темы — акцент, свои пузыри и обои, а светлая/тёмная — как у каждого.
import { useGlobal, findChat } from './global';
import { useBase } from './wallpapers';
import { catalogTheme, useCatalog } from './themes/catalog';
import { computePalette } from './themes/palette';
import { showToast } from './settingsData';
import type { ThemeSettings } from './themes/presets';

const ERR: Record<string, string> = { blocked: 'Нельзя: блокировка', forbidden: 'Менять тему может только администратор', not_member: 'Вы не в этом чате' };

export async function setChatTheme(chatId: number, theme: string | null): Promise<void> {
  try {
    const r = await fetch(`/chats/${chatId}/theme`, { method: 'PUT', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ theme }) });
    if (!r.ok) { const code = ((await r.json().catch(() => ({}))) as { code?: string }).code ?? ''; showToast(ERR[code] ?? 'Не удалось сменить тему'); }
  } catch { showToast('Нет сети — тема не сменилась'); }
}

/** Цвета темы открытого чата для текущей базы; null — у чата темы нет. */
export function useChatTheme(chatId: number | null): ThemeSettings | null {
  useCatalog();   // каталог ещё не пришёл — перерисуемся, когда придёт
  const id = useGlobal((s) => (chatId != null ? ((findChat(s, chatId)?.theme as string | null | undefined) ?? null) : null));
  const base = useBase();
  return catalogTheme(id)?.settings[base] ?? null;
}

/**
 * Переменные темы чата на его колонке: акцент, свои пузыри и текст в них. Всегда с theme-out-*: колонка с темой
 * сама решает, залит ли пузырь, а не наследует решение страницы (data-out-filled ставится на колонку).
 */
export function useChatThemeStyle(chatId: number | null): { style: Record<string, string>; filled: boolean } | null {
  const s = useChatTheme(chatId);
  const base = useBase();
  if (!s) return null;
  const p = computePalette(base, s);
  const keep = /^(brand|brand-strong|brand-text|on-brand|button|button-hover|fab|on-fab|accent-soft|on-accent-soft|voice-new|bubble-out|theme-out-ink|theme-out-meta|theme-out-link)$/;
  const style: Record<string, string> = {};
  for (const [k, v] of Object.entries(p)) if (keep.test(k)) style['--' + k] = v;
  return { style, filled: 'theme-out-ink' in p };
}
