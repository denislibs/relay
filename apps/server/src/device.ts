import { isPrivateIp } from './geoip';
/** Грубое имя устройства по User-Agent: «Chrome 141, macOS». Только браузер, старшая версия и ОС — без точных сборок. */

// порядок важен: Edge/Opera/Яндекс тоже пишут Chrome/, Chrome пишет Safari/
const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\/(\d+)/, 'Edge'],
  [/\b(?:OPR|Opera)\/(\d+)/, 'Opera'],
  [/\bYaBrowser\/(\d+)/, 'Яндекс Браузер'],
  [/\bSamsungBrowser\/(\d+)/, 'Samsung Internet'],
  [/\b(?:Firefox|FxiOS)\/(\d+)/, 'Firefox'],
  [/\b(?:CriOS|Chrome)\/(\d+)/, 'Chrome'],
  [/\bVersion\/(\d+)[^]*\bSafari\//, 'Safari'],
];

const SYSTEMS: [RegExp, string][] = [
  [/\b(?:iPhone|iPad|iPod)\b/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bWindows\b/, 'Windows'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\b(?:Macintosh|Mac OS X)\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
];

export const UNKNOWN_DEVICE = 'Браузер';

export function parseDevice(ua: string | null | undefined): string {
  const s = String(ua ?? '').slice(0, 512);
  let browser: string | null = null;
  for (const [re, name] of BROWSERS) {
    const m = re.exec(s);
    if (m) { browser = `${name} ${m[1]}`; break; }
  }
  const os = SYSTEMS.find(([re]) => re.test(s))?.[1] ?? null;
  if (!browser) return os ? `${UNKNOWN_DEVICE}, ${os}` : UNKNOWN_DEVICE;
  return os ? `${browser}, ${os}` : browser;
}

export interface IpSource { requestIP(req: Request): { address: string } | null }

/**
 * IP клиента. За доверенным прокси (TRUST_PROXY=1, TRUST_PROXY_HOPS=N — прокси в цепочке, по умолчанию 1) —
 * N-я запись x-forwarded-for справа: её дописал наш прокси; левые записи присылает сам клиент, им верить нельзя.
 * Без доверия к прокси (по умолчанию) — адрес сокета.
 */
export function clientIp(req: Request, server: IpSource): string | null {
  let ip: string | null = null;
  const hops = Number(process.env.TRUST_PROXY_HOPS) || (process.env.TRUST_PROXY === '1' ? 1 : 0);
  if (hops > 0) {
    const chain = (req.headers.get('x-forwarded-for') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    if (chain.length >= hops) ip = chain[chain.length - hops];
  }
  if (!ip) ip = server.requestIP(req)?.address ?? null;
  if (!ip) return null;
  return ip.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1').slice(0, 64);
}

/** dev-входы: только с DEV_LOGIN=1 и только с этой машины или из частной сети (INFRA-6) — не с публичного адреса */
export function devAllowed(req: Request, server: IpSource): boolean {
  if (process.env.DEV_LOGIN !== '1') return false;
  const ip = clientIp(req, server);
  return ip === null || isPrivateIp(ip);
}
