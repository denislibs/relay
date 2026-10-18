import { LINK_SERVICE_IDS, LINK_SERVICES, linkPrefix, linkUrl, parseLinkHandle, type LinkService } from '@relay/protocol';
import { Fab, Icon, InfoRow, PanelHeader, Presence, Section } from '@relay/ui';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useGlobal } from '../../global';
import { back } from '../../nav';
import { setLinks, showToast } from '../../settingsData';
import { putLink } from './linkList';
import { ServiceIcon } from './ServiceIcon';

export const LINK_TITLE = Object.fromEntries(LINK_SERVICE_IDS.map((s) => [s, LINK_SERVICES[s].title])) as Record<LinkService, string>;

/** Вставили целиком адрес другого сервиса — переключаемся на него («https://github.com/hoho» при выбранном LinkedIn). */
function serviceOf(raw: string): LinkService | null {
  const m = /^(?:https?:\/\/)?(?:www\.|m\.)?([^/?#\s]+)\//i.exec(raw.trim());
  if (!m) return null;
  return LINK_SERVICE_IDS.find((s) => LINK_SERVICES[s].host === m[1].toLowerCase()) ?? null;
}

/** «Новая ссылка» / правка: имя пользователя с префиксом сервиса и выбор сервиса. Адрес собирается сам. */
export function LinkEdit({ path }: { path: string }) {
  const links = useGlobal((s) => s.me?.links) ?? [];
  const item = path.split('/').pop()!;
  const at = item === 'new' ? null : Number(item);
  const cur = at === null ? null : links[at] ?? null;
  const [service, setService] = useState<LinkService>(cur?.service ?? 'linkedin');
  const [raw, setRaw] = useState(cur?.handle ?? '');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (at === null) input.current?.focus({ preventScroll: true }); }, []);

  const handle = raw.trim() ? parseLinkHandle(service, raw) : null;
  const changed = !cur || cur.service !== service || cur.handle !== handle;
  const ok = !!handle && changed;

  const onInput = (e: Event) => {
    const v = (e.currentTarget as HTMLInputElement).value;
    const other = serviceOf(v);
    if (other && other !== service) {
      const h = parseLinkHandle(other, v);
      if (h) { setService(other); setRaw(h); (e.currentTarget as HTMLInputElement).value = h; return; }
    }
    setRaw(v);
  };
  const save = () => {
    if (!handle) return;
    setLinks(putLink(links, at, { service, handle })).catch(() => showToast('Не удалось сохранить ссылку'));
    void back();
  };
  const remove = () => {
    if (at === null) return;
    setLinks(links.filter((_, i) => i !== at)).catch(() => showToast('Не удалось удалить ссылку'));
    void back();
  };

  return (
    <div class="rl-sidepage" aria-label={cur ? 'Ссылка' : 'Новая ссылка'}>
      <PanelHeader icon="close" closeLabel="Отмена" title={cur ? 'Ссылка' : 'Новая ссылка'} onClose={() => void back()} />
      <div class="rl-settings">
        <Section title="Имя пользователя" footer={<span aria-live="polite">{raw.trim() && !handle ? `Такое имя не подходит для ${LINK_TITLE[service]}.` : handle ? <>Ссылка откроет <b>{linkUrl({ service, handle }).replace('https://', '')}</b></> : `Ссылка откроет ${linkPrefix(service)}…`}</span>}>
          <label class={'app-link-field' + (raw.trim() && !handle ? ' app-link-field-bad' : '')}>
            <span class="app-link-prefix">{linkPrefix(service)}</span>
            <input
              ref={input} value={raw} onInput={onInput} placeholder="username" spellcheck={false} autoComplete="off" autoCapitalize="off"
              aria-label={'Имя пользователя ' + LINK_TITLE[service]} aria-invalid={raw.trim() && !handle ? 'true' : undefined}
              onKeyDown={(e) => { if (e.key === 'Enter' && ok) save(); }}
            />
          </label>
        </Section>
        <Section title="Сервис" role="radiogroup">
          {LINK_SERVICE_IDS.map((s) => (
            <button
              key={s} type="button" role="radio" aria-checked={s === service ? 'true' : 'false'} tabIndex={s === service ? 0 : -1}
              class="app-link-service" onClick={() => { setService(s); input.current?.focus({ preventScroll: true }); }}
            >
              <ServiceIcon service={s} size={34} />
              <span class="rl-inforow-text"><span>{LINK_SERVICES[s].title}</span><small>{linkPrefix(s)}</small></span>
              {s === service ? <span class="rl-check-mark" aria-hidden="true"><Icon name="check" size={22} /></span> : null}
            </button>
          ))}
        </Section>
        {cur ? <Section><InfoRow icon="trash" danger title="Удалить ссылку" onClick={remove} /></Section> : null}
      </div>
      <Presence show={ok} exitMs={200}>
        <div class="rl-fab-slot"><Fab icon="check" label="Сохранить" onClick={save} /></div>
      </Presence>
    </div>
  );
}
