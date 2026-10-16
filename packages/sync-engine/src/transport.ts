import type { ClientFrame, ServerFrame } from '@relay/protocol';

export interface TransportHandlers {
  onOpen(): void;
  onFrame(f: ServerFrame): void;
  onClose(): void;
}

/** WebSocket с переподключением: задержка растёт от backoff[0] до backoff[1] с разбросом ±25%. */
export class WsTransport {
  wanted = false;
  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private url: string, private h: TransportHandlers, private backoff: [number, number] = [250, 5000]) {}

  start(): void {
    if (this.wanted) return;
    this.wanted = true;
    this.open();
  }

  stop(): void {
    this.wanted = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.close();
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
    if (!this.isOpen()) return false;
    this.ws!.send(JSON.stringify(f));
    return true;
  }

  private open(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => { this.attempt = 0; this.h.onOpen(); };
    ws.onmessage = (e) => {
      let f: ServerFrame;
      try { f = JSON.parse(String(e.data)); } catch { return; }
      this.h.onFrame(f);
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.h.onClose();
      if (!this.wanted) return;
      const base = Math.min(this.backoff[1], this.backoff[0] * 2 ** this.attempt++);
      this.timer = setTimeout(() => { this.timer = null; if (this.wanted) this.open(); }, base * (0.75 + Math.random() * 0.5));
    };
  }
}
