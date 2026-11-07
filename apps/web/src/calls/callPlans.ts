import type { GroupCallPlan } from '@relay/protocol';
import { getGlobal, subscribeGlobal } from '../global';

/**
 * Запланированный звонок группы (этап 7 docs/plans/2026-11-07-relay-calls-features.md): план приходит с чатом
 * (groupCallPlan), «напомнить мне» — свой у каждого (GET /groups/:id/call-plan). Открытая вкладка напоминает сама в
 * срок (уведомление, если вкладка скрыта; плашка — всегда); закрытые получают пуш от сервера (groupcall.remind).
 */

export type PlanState = { plan: GroupCallPlan | null; remind: boolean };

const json = async <T>(r: Response): Promise<T> => { if (!r.ok) throw new Error(String(r.status)); return r.json() as Promise<T>; };
const opts = (method: string, body?: unknown): RequestInit => ({ method, credentials: 'include', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

export const fetchPlan = (chatId: number) => fetch(`/groups/${chatId}/call-plan`, { credentials: 'include' }).then((r) => json<PlanState>(r));
export const planCall = (chatId: number, at: number, title: string) => fetch(`/groups/${chatId}/call-plan`, opts('POST', { at, title })).then((r) => json<GroupCallPlan>(r));
export const cancelPlan = (chatId: number) => fetch(`/groups/${chatId}/call-plan`, opts('DELETE')).then((r) => json<{ ok: true }>(r));
export async function setPlanRemind(chatId: number, on: boolean): Promise<boolean> {
  const r = await fetch(`/groups/${chatId}/call-plan/remind`, opts('POST', { on })).then((x) => json<{ remind: boolean }>(x));
  known.set(planKey(chatId), r.remind);
  arm();
  return r.remind;
}

// ---------------------------------------------------------------------------------------------------------------
// Напоминание в открытой вкладке

const known = new Map<string, boolean>();               // «чат:план» → напомнить ли (с сервера или после переключения)
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const planOf = (chatId: number): GroupCallPlan | null => (getGlobal().chats.find((c) => c.id === chatId)?.groupCallPlan as GroupCallPlan | null | undefined) ?? null;
const planKey = (chatId: number) => chatId + ':' + (planOf(chatId)?.id ?? '');
let notify: (chatId: number, title: string, body: string) => void = () => {};

/** Расставить таймеры по планам групп из списка чатов (без лишних запросов: «напомнить ли» — один раз на план). */
function arm(): void {
  const plans = getGlobal().chats.filter((c) => c.groupCallPlan).map((c) => ({ chatId: c.id as number, title: String(c.title ?? ''), plan: c.groupCallPlan as GroupCallPlan }));
  const live = new Set(plans.map((p) => p.chatId + ':' + p.plan.id));
  for (const [k, t] of timers) if (!live.has(k)) { clearTimeout(t); timers.delete(k); }
  for (const p of plans) {
    const k = p.chatId + ':' + p.plan.id;
    const wait = p.plan.at - Date.now();
    if (timers.has(k) || wait < -60_000 || wait > 24 * 3600_000) continue;   // далеко — поставим, когда приблизится
    if (!known.has(k)) { known.set(k, false); void fetchPlan(p.chatId).then((s) => { if (s.plan?.id === p.plan.id) { known.set(k, s.remind); arm(); } }).catch(() => known.delete(k)); continue; }
    if (!known.get(k)) continue;
    timers.set(k, setTimeout(() => {
      timers.delete(k);
      if (planOf(p.chatId)?.id !== p.plan.id || !known.get(k)) return;
      notify(p.chatId, p.title || 'Группа', p.plan.title ? `Начинается звонок «${p.plan.title}»` : 'Начинается звонок');
    }, Math.max(0, wait)));
  }
}

/** Старт приложения: следить за планами в списке чатов. */
export function bindCallPlans(show: (chatId: number, title: string, body: string) => void): void {
  notify = show;
  let last = '';
  subscribeGlobal(() => {
    const sig = getGlobal().chats.filter((c) => c.groupCallPlan).map((c) => c.id + ':' + (c.groupCallPlan as GroupCallPlan).id).join(',');
    if (sig !== last) { last = sig; arm(); }
  });
  // далёкие планы (больше суток) — проверить снова через час
  setInterval(arm, 3600_000);
}
