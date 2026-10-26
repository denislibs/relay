// «Для разработчиков» → «Кадры»: запись кадров (нажал → сделал действие → стоп) с графиком и списком медленных,
// анимации стикеров (проигрыватели, рендеры, кэш, воркеры) и отчёт строгого DOM (чтения и записи раскладки не в своей фазе).
import {
  Button, Section, enableStrictDom, lottieStats, requestMeasure, stickerDetail, strictDomEnabled, strictDomReport, strictDomReset, subscribeStrictDom,
} from '@relay/ui';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import {
  MAX_MS, SLOW_MS, clearRecording, currentRecording, frameTags, isRecording, startRecording, stopRecording, subscribeRecording, summarize, type Recording,
} from '../../devtools/recorder';
import { showToast } from '../../settingsData';
import { KV, bytes, num } from './devui';

const ms1 = (n: number) => `${n.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} мс`;

function useRecording(): { rec: Recording | null; on: boolean } {
  const [, bump] = useState(0);
  useEffect(() => subscribeRecording(() => bump((n) => n + 1)), []);
  return { rec: currentRecording(), on: isRecording() };
}

async function copy(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); showToast('Скопировано'); } catch { showToast('Не удалось скопировать'); }
}

/** График длины кадров: столбик на кадр, линии 16,7 и 33,3 мс; полоса снизу — где шла прокрутка ленты или тяжёлая анимация. */
function FrameChart({ rec }: { rec: Recording }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c) return;
    // цвета темы читаем в фазе measure; канвас — не раскладка, рисуем там же
    requestMeasure(() => {
      const cs = getComputedStyle(c);
      const col = (v: string, d: string) => cs.getPropertyValue(v).trim() || d;
      const ok = col('--brand', '#3c9'), bad = col('--danger', '#e53935'), grid = col('--line-strong', '#888'), band = col('--ink-muted', '#888');
      const W = c.width, H = c.height, top = 100, chartH = H - 14;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, W, H);
      const frames = rec.frames.slice(1);
      const end = Math.max(1, rec.frames.length ? rec.frames[rec.frames.length - 1].t : 1);
      const x = (t: number) => (t / end) * W;
      const y = (v: number) => chartH - (Math.min(v, top) / top) * chartH;
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = band;
      for (const f of frames) if (f.drive || f.heavy) ctx.fillRect(x(f.t - f.ms), chartH + 4, Math.max(1, x(f.ms)), 8);
      ctx.globalAlpha = 1;
      for (const f of frames) {
        ctx.fillStyle = f.ms > SLOW_MS ? bad : ok;
        const bx = x(f.t - f.ms), bw = Math.max(1, x(f.ms) - 0.5);
        ctx.fillRect(bx, y(f.ms), bw, chartH - y(f.ms));
      }
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      for (const v of [16.7, 33.3]) { ctx.beginPath(); ctx.moveTo(0, Math.round(y(v)) + 0.5); ctx.lineTo(W, Math.round(y(v)) + 0.5); ctx.stroke(); }
      ctx.setLineDash([]);
    });
  }, [rec, rec.frames.length]);
  return (
    <div class="app-perf-chart">
      <canvas ref={ref} width={880} height={240} role="img" aria-label="Длина кадров во время записи" />
      <div class="app-perf-legend"><span>пунктир — 16,7 и 33,3 мс (60 и 30 к/с)</span><span>полоса снизу — прокрутка ленты / тяжёлая анимация</span></div>
    </div>
  );
}

function Recorder() {
  const { rec, on } = useRecording();
  const s = rec && !on ? summarize(rec) : null;
  const elapsed = rec && rec.frames.length ? rec.frames[rec.frames.length - 1].t : 0;
  return (
    <Section title="Запись кадров">
      <p class="app-perf-hint">Начните запись, сделайте действие в приложении (отправка, прокрутка, открытие панели) и остановите. Запись сама закончится через {MAX_MS / 1000} с.</p>
      <div class="app-dev-actions">
        {on
          ? <Button onClick={() => stopRecording()}>Стоп</Button>
          : <Button onClick={() => startRecording()}>{rec ? 'Записать заново' : 'Начать запись'}</Button>}
        {on ? <span class="app-perf-live"><i aria-hidden="true" />Идёт запись: {(elapsed / 1000).toFixed(1)} с · {num(rec?.frames.length)} кадров</span> : null}
        {s && rec ? <Button variant="secondary" onClick={() => void copy(JSON.stringify({ summary: s, ...rec }, null, 1))}>Скопировать как JSON</Button> : null}
        {s ? <Button variant="secondary" onClick={() => clearRecording()}>Очистить</Button> : null}
      </div>
      {s && rec ? (
        <>
          <FrameChart rec={rec} />
          <KV label="Длительность / кадров" value={`${(s.durationMs / 1000).toFixed(1)} с · ${num(s.frames)}`} />
          <KV label="Кадров в секунду" value={num(s.fps)} warn={s.fps < 50} />
          <KV label="Кадр: медиана" value={ms1(s.p50)} />
          <KV label="Кадр: 95% / самый долгий" value={`${ms1(s.p95)} / ${ms1(s.max)}`} warn={s.max > 50} />
          <KV label={`Медленных (> ${SLOW_MS} мс) / рывков (> 50 мс)`} value={`${num(s.slow)} / ${num(s.jank)}`} warn={s.jank > 0} />
          <KV label="Долгих задач (всего)" value={s.longTasks ? `${num(s.longTasks)} (${ms1(s.longTasksMs)})` : '0'} warn={s.longTasks > 0} />
          {s.slowest.length ? (
            <div class="app-perf-slow" role="list" aria-label="Медленные кадры">
              {s.slowest.map((f) => (
                <div key={f.t} class="app-perf-row" role="listitem">
                  <b class={f.ms > 50 ? 'is-jank' : ''}>{ms1(f.ms)}</b>
                  <span class="app-perf-at">+{(f.t / 1000).toFixed(2)} с</span>
                  <span class="app-perf-tags">{frameTags(f).join(' · ') || 'ничего из отслеживаемого'}</span>
                </div>
              ))}
            </div>
          ) : <p class="app-dev-empty">Медленных кадров нет</p>}
          {rec.longTasks.length ? (
            <div class="app-perf-slow" role="list" aria-label="Долгие задачи">
              {rec.longTasks.map((t) => (
                <div key={t.t} class="app-perf-row" role="listitem"><b class="is-jank">{ms1(t.ms)}</b><span class="app-perf-at">+{(t.t / 1000).toFixed(2)} с</span><span class="app-perf-tags">долгая задача главного потока</span></div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </Section>
  );
}

/** Анимации стикеров и реакций — раз в полсекунды, пока вкладка открыта. */
function Stickers() {
  const read = () => ({ p: stickerDetail(), r: lottieStats() });
  const [st, setSt] = useState(read);
  useEffect(() => { const id = setInterval(() => setSt(read()), 500); return () => clearInterval(id); }, []);
  const { p, r } = st;
  const groups = Object.entries(p.groups as Record<string, { views: number; playing: number }>).sort((a, b) => b[1].views - a[1].views);
  return (
    <Section title="Анимации стикеров">
      <KV label="Проигрывателей / играют" value={`${num(p.players)} / ${num(p.playing)}`} />
      <KV label="Канвасов (видов) / видимых" value={`${num(p.views)} / ${num(p.visible)}`} />
      <KV label="Ждут рендерер" value={num(p.loading)} />
      {groups.map(([g, v]) => <KV key={g} label={`  группа «${g}»: видов / играют`} value={`${num(v.views)} / ${num(v.playing)}`} />)}
      <KV label="Играет только группа" value={p.exclusive ?? '—'} />
      <KV label="Автовоспроизведение / цикл" value={`${p.policy.autoplay ? 'да' : 'нет'} / ${p.policy.loop ? 'да' : 'нет'}`} />
      <KV label="Рендереров (анимация × размер)" value={num(r.renderers)} />
      <KV label="Кадров в памяти (кэш + заготовки)" value={`${num(r.cachedFrames)} + ${num(r.looseFrames)}`} />
      <KV label="Память кадров (≈ ш × в × 4)" value={bytes(r.bytes)} warn={r.bytes > 64 * 1024 * 1024} />
      <KV label="Бюджет кэша кадров" value={bytes(r.budget)} />
      <KV label="Кадров рисуется сейчас" value={num(r.pendingFrames)} />
      {(r.workers as { index: number; started: boolean; renderers: number; inflight: number }[]).map((w) => (
        <KV key={w.index} label={`  воркер ${w.index + 1}: рендереров / в работе`} value={w.started ? `${num(w.renderers)} / ${num(w.inflight)}` : 'не запущен'} />
      ))}
    </Section>
  );
}

/** Строгий DOM: места, где раскладку читали или писали не в своей фазе кадра. */
function Strict() {
  const [, bump] = useState(0);
  useEffect(() => subscribeStrictDom(() => bump((n) => n + 1)), []);
  const on = strictDomEnabled();
  const sites = on ? strictDomReport().sort((a, b) => b.count - a.count) : [];
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Section title="Строгий DOM">
      {!on ? (
        <>
          <p class="app-perf-hint">Проверка порядка «чтение раскладки → запись» в каждом кадре. В рабочей сборке выключена: перехват всех чтений и записей замедляет страницу. Можно включить до перезагрузки.</p>
          <div class="app-dev-actions"><Button variant="secondary" onClick={() => { enableStrictDom({ ignore: /twallpaper/ }); bump((n) => n + 1); showToast('Проверка включена до перезагрузки'); }}>Включить проверку</Button></div>
        </>
      ) : (
        <>
          <KV label="Мест с нарушениями" value={num(sites.length)} warn={sites.length > 0} />
          {sites.length ? (
            <div class="app-perf-slow" role="list" aria-label="Нарушения порядка DOM">
              {sites.map((v) => {
                const key = v.kind + v.prop + v.at;
                return (
                  <div key={key} class="app-perf-strict" role="listitem">
                    <button type="button" class="app-perf-row" aria-expanded={open === key ? 'true' : 'false'} onClick={() => setOpen(open === key ? null : key)}>
                      <b>×{num(v.count)}</b>
                      <span class="app-perf-tags"><em>{v.kind}</em> — {v.prop}{v.phase ? ` (фаза ${v.phase})` : ''}<br />{v.at}</span>
                    </button>
                    {open === key && v.stack ? <pre class="app-dev-pre">{v.stack}</pre> : null}
                  </div>
                );
              })}
            </div>
          ) : <p class="app-dev-empty">Нарушений нет</p>}
          <div class="app-dev-actions">
            {sites.length ? <Button variant="secondary" onClick={() => void copy(JSON.stringify(sites.map(({ stack, ...x }) => x), null, 1))}>Скопировать</Button> : null}
            {sites.length ? <Button variant="secondary" onClick={() => strictDomReset()}>Очистить</Button> : null}
          </div>
        </>
      )}
    </Section>
  );
}

export function DevPerf() {
  return (
    <div class="rl-settings app-dev-scroll">
      <Recorder />
      <Stickers />
      <Strict />
    </div>
  );
}
