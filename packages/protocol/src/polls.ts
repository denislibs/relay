/* ---------- опросы и викторины (как messageMediaPoll в Telegram) ---------- */

/** Вариант ответа: id — номер внутри опроса (1..N по порядку). */
export interface PollOption { id: number; text: string }

/**
 * Опрос глазами читателя. Определение — общее; счётчики и «мои» голоса сервер подставляет для каждого читателя.
 * В викторине правильный ответ и пояснение приходят, только когда читатель проголосовал или опрос закрыт.
 */
export interface Poll {
  question: string;
  options: PollOption[];
  multiple: boolean;        // можно выбрать несколько (у викторины — никогда)
  quiz: boolean;            // викторина: один правильный ответ
  anonymous: boolean;       // голоса без имён; неанонимный — список проголосовавших по вариантам
  closed: boolean;
  closesAt: string | null;  // ISO: опрос закроется сам
  voters: number;           // сколько людей проголосовало
  counts: number[];         // голосов за каждый вариант, в порядке options
  my?: number[];            // мои варианты (id); нет или пусто — я не голосовал
  correct?: number;         // викторина: id правильного варианта (когда раскрыт)
  solution?: string;        // викторина: пояснение к ответу (когда раскрыт)
}

/** Что присылает клиент при создании: варианты — текстом, правильный — индексом в options. */
export interface PollInput {
  question: string;
  options: string[];
  multiple: boolean;
  quiz: boolean;
  anonymous: boolean;
  correct?: number | null;      // индекс в options (только у викторины)
  solution?: string | null;
  closesIn?: number | null;     // секунд до автозакрытия
}

/** Пределы как у Telegram: вопрос 255, вариантов 2–10 по 100, пояснение 200, автозакрытие 5 с – 10 мин. */
export const POLL_QUESTION_MAX = 255;
export const POLL_OPTIONS_MIN = 2;
export const POLL_OPTIONS_MAX = 10;
export const POLL_OPTION_MAX = 100;
export const POLL_SOLUTION_MAX = 200;
export const POLL_CLOSE_MIN = 5;
export const POLL_CLOSE_MAX = 600;

const glyphs = (s: string) => [...s].length;
const line = (v: unknown) => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';

/** Проверка опроса от клиента. null — не опрос (пусто, за пределами, повтор варианта, викторина без ответа). */
export function normalizePoll(raw: unknown): PollInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const question = line(r.question);
  if (!question || glyphs(question) > POLL_QUESTION_MAX || !Array.isArray(r.options)) return null;
  const options = r.options.map(line).filter(Boolean);
  if (options.length < POLL_OPTIONS_MIN || options.length > POLL_OPTIONS_MAX) return null;
  if (options.some((o) => glyphs(o) > POLL_OPTION_MAX)) return null;
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) return null;   // одинаковые варианты путают
  const quiz = r.quiz === true;
  const correct = quiz ? r.correct : null;
  if (quiz && !(Number.isInteger(correct) && (correct as number) >= 0 && (correct as number) < options.length)) return null;
  const solution = quiz ? (typeof r.solution === 'string' ? r.solution.trim() : '') : '';
  if (glyphs(solution) > POLL_SOLUTION_MAX) return null;
  const closesIn = r.closesIn == null ? null : Number(r.closesIn);
  if (closesIn != null && !(Number.isInteger(closesIn) && closesIn >= POLL_CLOSE_MIN && closesIn <= POLL_CLOSE_MAX)) return null;
  return {
    question, options, quiz, multiple: !quiz && r.multiple === true, anonymous: r.anonymous !== false,
    ...(quiz ? { correct: correct as number } : {}), ...(solution ? { solution } : {}), ...(closesIn != null ? { closesIn } : {}),
  };
}

/** Доли вариантов в процентах, в сумме ровно 100 (метод наибольших остатков, как в Telegram); без голосов — нули. */
export function pollPercents(counts: number[]): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return counts.map(() => 0);
  const raw = counts.map((c) => (c * 100) / total);
  const out = raw.map(Math.floor);
  let left = 100 - out.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => [v - Math.floor(v), i] as const).filter(([, i]) => counts[i] > 0).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) { if (left <= 0) break; out[i]++; left--; }
  return out;
}
