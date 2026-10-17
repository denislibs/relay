import { Button, Section } from '@relay/ui';
import { useEffect, useState } from 'preact/hooks';
import { clearErrors, getErrors, subscribeErrors, type ErrorSource } from '../../devtools/metrics';
import { stamp } from './devui';

const SOURCE: Record<ErrorSource, string> = { window: 'window.onerror', promise: 'unhandledrejection', engine: 'движок', host: 'хост воркера', server: 'сервер (err)', op: 'очередь операций' };

/** «Ошибки»: главный поток, движок и хост, err-кадры сервера, отказы очереди — новые сверху; стек свёрнут. */
export function DevErrors() {
  const [list, setList] = useState(getErrors());
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => subscribeErrors(() => setList(getErrors())), []);
  const rows = list.slice().reverse();
  return (
    <div class="rl-settings app-dev-scroll">
      <Section title={`Ошибки: ${list.length}`} footer="Последние 200. Ошибки главного потока собираются всегда, ошибки движка — из его журнала (2000 последних событий).">
        {rows.length ? rows.map((e) => (
          <div key={e.id} class="app-dev-err">
            <div class="app-dev-err-head">
              <span class="app-dev-ev-t">{stamp(e.t)}</span>
              <span class="app-dev-err-src">{SOURCE[e.source]}</span>
              {e.count > 1 ? <span class="app-dev-err-count">×{e.count}</span> : null}
            </div>
            <div class="app-dev-err-msg">{e.message}</div>
            {e.stack ? (
              <>
                <button type="button" class="app-dev-err-toggle" aria-expanded={open === e.id ? 'true' : 'false'} onClick={() => setOpen(open === e.id ? null : e.id)}>{open === e.id ? 'Скрыть стек' : 'Показать стек'}</button>
                {open === e.id ? <pre class="app-dev-pre">{e.stack}</pre> : null}
              </>
            ) : null}
          </div>
        )) : <p class="app-dev-empty">Ошибок нет</p>}
      </Section>
      {rows.length ? <div class="app-dev-actions app-dev-actions-pad"><Button variant="secondary" onClick={clearErrors}>Очистить список</Button></div> : null}
    </div>
  );
}
