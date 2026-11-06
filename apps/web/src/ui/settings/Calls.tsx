import { CheckRow, InfoRow, PanelHeader, RangeRow, Section, SelectRow } from '@relay/ui';
import { useEffect, useRef, useState } from 'preact/hooks';
import { failureOf, getCamera, getMic, levelMeter, listDevices, canPickSpeaker, type MediaFailure } from '../../calls/media';
import { soundSink, sounds } from '../../calls/sounds';
import { useGlobal } from '../../global';
import { back, go } from '../../nav';
import { RINGTONES, setPrefs } from '../../prefs';
import { refreshSettings, registerPrefetch } from '../../settingsData';
import { useScrollMemory } from '../useScrollMemory';
import { ruleSubtitle } from './privacyLogic';

registerPrefetch('settings/calls', () => { void refreshSettings(); });

const RING_LABEL: Record<string, string> = { classic: 'Классическая', chime: 'Колокольчики', pulse: 'Пульс' };
const IDLE_MS = 60_000;   // проверка камеры или микрофона без действий — выключить

type Lists = Awaited<ReturnType<typeof listDevices>>;

/**
 * «Звонки» (на этом устройстве): микрофон с индикатором, динамик с проверкой, камера с предпросмотром, приём звонков,
 * мелодия. Камера и микрофон включаются только кнопкой и гаснут при уходе со страницы, скрытии вкладки или через
 * минуту без действий — страница настроек не держит их «на всякий случай».
 */
export function Calls() {
  const p = useGlobal((s) => s.prefs.calls);
  const privacy = useGlobal((s) => s.settings.privacy);
  const scroll = useScrollMemory('settings/calls');
  const [lists, setLists] = useState<Lists>({ mic: [], speaker: [], camera: [] });
  const [micOn, setMicOn] = useState(false), [camOn, setCamOn] = useState(false);
  const [level, setLevel] = useState(0);
  const [fail, setFail] = useState<{ mic?: MediaFailure; camera?: MediaFailure }>({});
  const [camShown, setCamShown] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const live = useRef<{ mic?: MediaStreamTrack; cam?: MediaStreamTrack; meter?: { stop(): void }; idle?: ReturnType<typeof setTimeout> }>({});

  const refresh = () => void listDevices().then(setLists);
  const stopMic = () => { live.current.meter?.stop(); live.current.mic?.stop(); live.current.mic = undefined; live.current.meter = undefined; setMicOn(false); setLevel(0); };
  const stopCam = () => { live.current.cam?.stop(); live.current.cam = undefined; setCamOn(false); setCamShown(false); if (video.current) video.current.srcObject = null; };
  const stopAll = () => { stopMic(); stopCam(); if (live.current.idle) clearTimeout(live.current.idle); };
  const touch = () => { if (live.current.idle) clearTimeout(live.current.idle); live.current.idle = setTimeout(stopAll, IDLE_MS); };

  useEffect(() => {
    refresh();
    navigator.mediaDevices?.addEventListener('devicechange', refresh);
    const hide = () => { if (document.visibilityState === 'hidden') stopAll(); };
    document.addEventListener('visibilitychange', hide);
    return () => { navigator.mediaDevices?.removeEventListener('devicechange', refresh); document.removeEventListener('visibilitychange', hide); stopAll(); };
  }, []);

  const startMic = async () => {
    stopMic();
    try {
      const { track } = await getMic(p);
      live.current.mic = track;
      live.current.meter = levelMeter(track, setLevel);
      setMicOn(true); setFail((f) => ({ ...f, mic: undefined }));
      refresh();   // после разрешения браузер отдаёт названия устройств
      touch();
    } catch (e) { setFail((f) => ({ ...f, mic: failureOf(e) })); }
  };
  const startCam = async () => {
    stopCam();
    try {
      const { track } = await getCamera(p);
      live.current.cam = track;
      setCamOn(true); setFail((f) => ({ ...f, camera: undefined }));
      const el = video.current;
      if (el) {
        el.srcObject = new MediaStream([track]);
        // показываем после первого кадра — без чёрной вспышки
        el.onloadeddata = () => setCamShown(true);
      }
      refresh();
      touch();
    } catch (e) { setFail((f) => ({ ...f, camera: failureOf(e) })); }
  };
  // выбрали другое устройство, пока идёт проверка, — перезапустить на нём
  useEffect(() => { if (micOn) void startMic(); }, [p.mic, p.noise, p.agc]);
  useEffect(() => { if (camOn) void startCam(); }, [p.camera, p.video]);

  const name = (d: MediaDeviceInfo, i: number, what: string) => d.label || `${what} ${i + 1}`;
  const deviceRow = (key: 'mic' | 'speaker' | 'camera', label: string, what: string) => (
    <SelectRow setting={'calls.' + key} label={label} value={p[key] ?? ''}
      options={[{ value: '', label: 'Как в системе' }, ...lists[key].map((d, i) => ({ value: d.deviceId, label: name(d, i, what) }))]}
      onChange={(v: string | number) => { setPrefs({ ['calls.' + key]: v === '' ? null : String(v) }); touch(); }} />
  );
  const failText = (f: MediaFailure | undefined, what: 'микрофону' | 'камере') => !f ? undefined
    : f === 'denied' ? `Нет доступа к ${what}: разрешите его в настройках браузера (значок слева от адреса)`
      : f === 'missing' ? 'Устройство не найдено' : f === 'busy' ? 'Устройство занято другим приложением' : f === 'insecure' ? 'Нужно защищённое соединение (https)' : 'Не удалось включить';

  return (
    <div class="rl-sidepage" aria-label="Звонки">
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title="Звонки" onClose={() => void back()} />
      <div class="rl-settings" ref={scroll.ref} onScroll={scroll.onScroll}>
        <Section setting="calls.mic" title="Микрофон" footer={failText(fail.mic, 'микрофону') ?? 'Эхоподавление включено всегда.'}>
          {deviceRow('mic', 'Микрофон', 'Микрофон')}
          <div class="app-calls-meter" aria-label="Уровень микрофона" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
            <i style={{ transform: `scaleX(${micOn ? level : 0})` }} />
          </div>
          <InfoRow icon={micOn ? 'micOff' : 'mic'} title={micOn ? 'Остановить проверку' : 'Проверить микрофон'} onClick={() => void (micOn ? stopMic() : startMic())} />
          <CheckRow setting="calls.noise" label="Шумоподавление" checked={p.noise} onChange={(on: boolean) => setPrefs({ 'calls.noise': on })} />
          <CheckRow setting="calls.agc" label="Автоматическая громкость" checked={p.agc} onChange={(on: boolean) => setPrefs({ 'calls.agc': on })} />
        </Section>
        {canPickSpeaker() ? (
          <Section setting="calls.speaker" title="Динамики">
            {deviceRow('speaker', 'Динамики', 'Динамик')}
            <InfoRow icon="volume" title="Проверить звук" onClick={() => { void soundSink(p.speaker).then(() => sounds.test(p.volume)); }} />
          </Section>
        ) : null}
        <Section setting="calls.camera" title="Камера" footer={failText(fail.camera, 'камере')}>
          {deviceRow('camera', 'Камера', 'Камера')}
          {/* один <video> всегда в DOM: поток ставится до перерисовки, а кадр показывается после первого кадра камеры */}
          <div class={'app-calls-preview' + (camOn ? ' is-open' : '')}><video ref={video} class={camShown ? 'is-on' : ''} autoplay playsInline muted aria-label="Предпросмотр камеры" /></div>
          <InfoRow icon={camOn ? 'videoOff' : 'video'} title={camOn ? 'Выключить камеру' : 'Показать камеру'} onClick={() => void (camOn ? stopCam() : startCam())} />
          <SelectRow setting="calls.video" label="Качество видео" value={p.video}
            options={[{ value: 'auto', label: 'Обычное' }, { value: 'saver', label: 'Экономия трафика' }, { value: 'high', label: 'Высокое' }]}
            onChange={(v: string | number) => setPrefs({ 'calls.video': v })} />
        </Section>
        <Section setting="calls.ring" title="Входящие" footer="Если выключить, это устройство не будет звонить; пропущенные звонки останутся в чате.">
          <CheckRow setting="calls.accept" label="Принимать звонки на этом устройстве" checked={p.accept} onChange={(on: boolean) => setPrefs({ 'calls.accept': on })} />
          <SelectRow setting="calls.ringtone" label="Мелодия" value={p.ringtone}
            options={RINGTONES.map((r) => ({ value: r, label: RING_LABEL[r] ?? r }))}
            onChange={(v: string | number) => { setPrefs({ 'calls.ringtone': String(v) }); void soundSink(p.speaker).then(() => sounds.preview(String(v), p.volume)); }} />
          <RangeRow setting="calls.volume" label="Громкость звонка" min={0} max={100} step={1} value={Math.round(p.volume * 100)} format={(v: number) => v + ' %'}
            onChange={(v: number) => setPrefs({ 'calls.volume': v / 100 })}
            onCommit={(v: number) => { void soundSink(p.speaker).then(() => sounds.preview(p.ringtone, v / 100)); }} />
        </Section>
        <Section title="Конфиденциальность" footer="Звонки защищены сквозным шифрованием: сверьте 4 эмодзи с собеседником.">
          <InfoRow tile="green" icon="phone" title="Кто может мне звонить" subtitle={ruleSubtitle(privacy.calls)} onClick={() => void go('settings/privacy/rule/calls')} />
          <InfoRow tile="blue" icon="shield" title="Пиринговые соединения" subtitle={ruleSubtitle(privacy.p2p)} onClick={() => void go('settings/privacy/rule/p2p')} />
        </Section>
      </div>
    </div>
  );
}
