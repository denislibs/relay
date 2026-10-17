import type { ClientFrame, ServerFrame } from '@relay/protocol';
import type { DevTools, TransportView } from './devlog';
import { lost, oneWay } from './devsim';

export interface TransportHandlers {
  onOpen(): void;
  onFrame(f: ServerFrame): void;
  onClose(): void;
}

/** код закрытия «обрыв» (dev: «Разорвать сокет», запрос без ответа) */
export const DROP_CODE = 4000;

/**
 * WebSocket с переподключением: задержка растёт от backoff[0] до backoff[1] с разбросом ±25%.
 * dev (devlog.ts) — журнал кадров и имитатор: офлайн, задержка/джиттер/потери/полоса, выброс кадра.
 * Без медленной сети кадры идут синхронно, как без имитатора; с ней — по очереди на направление, порядок сохраняется.
 */
export class WsTransport {
  wanted = false;
  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextDelay: number | null = null;
  private nextAt: number | null = null;
  private inAt = 0;      // когда доставится последний задержанный кадр направления
  private outAt = 0;
  private inQueued = 0;
  private outQueued = 0;

  constructor(private url: string, private h: TransportHandlers, private backoff: [number, number] = [250, 5000], private dev?: DevTools) {}

  start(): void {
    if (this.wanted) return;
    this.wanted = true;
    this.open();
  }

  stop(): void {
    this.wanted = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.nextAt = this.nextDelay = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.close();
      this.dev?.log.closed();
      this.h.onClose();
    }
  }

  /** Сеть вернулась: не ждём конца паузы перед следующей попыткой. */
  retryNow(): void {
    if (!this.wanted || this.ws || !this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.attempt = 0;
    this.open();
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(f: ClientFrame): boolean {
    if (!this.isOpen() || this.dev?.sim.offline) return false;   // dev: офлайн — новым кадрам отказ, пока сокет дожидается ответов
    const s = JSON.stringify(f);
    this.dev?.log.frameOut(f, s.length);
    const p = this.dev?.sim.profile ?? null;
    if (!p && !this.outQueued) { this.ws!.send(s); return true; }
    if (f.op !== 'hello' && lost(p)) { this.dev!.sim.losses++; this.dev!.log.record('engine', 'lost', { dir: 'out', op: f.op }); return true; }
    const ws = this.ws!;
    this.outQueued++;
    this.later('out', p ? oneWay(p, s.length) : 0, () => { this.outQueued--; if (ws.readyState === WebSocket.OPEN) ws.send(s); });
    return true;
  }

  /** Закрыть как обрыв (код 4000): дальше обычное переподключение. */
  drop(): void {
    const ws = this.ws;
    if (!ws) return;
    try { ws.close(DROP_CODE, 'drop'); } catch { ws.close(); }
  }

  /** dev: офлайн — закрыть сокет и не переподключаться (новые кадры send уже не берёт); выключили — подключиться сразу. */
  setOffline(on: boolean): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.nextAt = this.nextDelay = null;
    if (on) { this.ws?.close(); return; }
    if (!this.wanted || this.ws) return;
    this.attempt = 0;
    this.open();
  }

  view(): TransportView {
    const rs = this.ws?.readyState;
    const state = rs === WebSocket.OPEN ? 'open' : rs === WebSocket.CONNECTING ? 'connecting' : this.dev?.sim.offline ? 'offline' : this.timer ? 'waiting' : 'closed';
    return { state, attempt: this.attempt, nextDelay: this.nextDelay, nextAt: this.nextAt };
  }

  /** Задержанная доставка: не раньше предыдущего кадра того же направления (как в TCP — без перестановок). */
  private later(dir: 'in' | 'out', delay: number, fn: () => void): void {
    const now = Date.now();
    const at = Math.max(dir === 'in' ? this.inAt : this.outAt, now + delay);
    if (dir === 'in') this.inAt = at; else this.outAt = at;
    setTimeout(fn, at - now);
  }

  /** Событие сокета — сразу или в очередь медленной сети (тогда и open/close встают за кадрами). */
  private deliver(ws: WebSocket, size: number, fn: () => void): void {
    const p = this.dev?.sim.profile ?? null;
    if (!p && !this.inQueued) { fn(); return; }
    this.inQueued++;
    this.later('in', p ? oneWay(p, size) : 0, () => { this.inQueued--; if (this.ws === ws) fn(); });
  }

  private receive(raw: string): void {
    let f: ServerFrame;
    try { f = JSON.parse(raw); } catch { return; }
    const dev = this.dev;
    if (dev) {
      const sim = dev.sim;
      // потери — любые кадры, кроме hello и sessionTerminated: без них сеанс не начать и не закончить, восстановиться нечем
      if (f.op !== 'hello' && f.op !== 'sessionTerminated' && lost(sim.profile)) { sim.losses++; dev.log.frameIn(f, raw.length, 'lost'); return; }
      if (f.op === 'updates' && sim.dropNextUpdates) { sim.dropNextUpdates = false; sim.losses++; dev.log.frameIn(f, raw.length, 'dropped'); return; }
      if (f.op === 'updates' && sim.forceTooLong) { sim.forceTooLong = false; dev.log.frameIn(f, raw.length, 'asTooLong'); f = { op: 'tooLong', seq: f.to }; }
      dev.log.frameIn(f, raw.length);
    }
    this.h.onFrame(f);
  }

  private open(): void {
    if (this.dev?.sim.offline) return;   // dev: офлайн — ждём setOffline(false)
    this.nextAt = this.nextDelay = null;
    this.dev?.log.record('engine', 'connect', { attempt: this.attempt });
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => this.deliver(ws, 0, () => { this.attempt = 0; this.dev?.log.record('engine', 'open', null); this.h.onOpen(); });
    ws.onmessage = (e) => {
      const raw = String(e.data);
      // без медленной сети — сразу, без замыкания на кадр
      if (!this.inQueued && !this.dev?.sim.profile) this.receive(raw);
      else this.deliver(ws, raw.length, () => this.receive(raw));
    };
    ws.onerror = () => {};
    ws.onclose = (e) => this.deliver(ws, 0, () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.dev?.log.closed();
      this.dev?.log.record('engine', 'close', { code: (e as CloseEvent | undefined)?.code ?? null });
      this.h.onClose();
      if (!this.wanted || this.dev?.sim.offline) return;
      const base = Math.min(this.backoff[1], this.backoff[0] * 2 ** this.attempt++);
      const delay = Math.round(base * (0.75 + Math.random() * 0.5));
      this.nextDelay = delay;
      this.nextAt = Date.now() + delay;
      this.dev?.log.record('engine', 'backoff', { attempt: this.attempt, delay });
      this.timer = setTimeout(() => { this.timer = null; if (this.wanted) this.open(); }, delay);
    });
  }
}
