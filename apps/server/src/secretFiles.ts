// Секреты из файлов (production: docker secrets, /run/secrets/<имя> — docker-compose.secure.yml). Для каждой
// переменной X из списка ниже X_FILE — путь к файлу: прочитать (без пробелов по краям) в X до того, как остальной код
// прочтёт окружение. В `docker inspect`, `ps` и слоях образа значения нет. В dev файлов нет — X как раньше.
// Импортируется ПЕРВЫМ в точках входа (main.ts, worker.ts, keyService.ts, migrate.ts, dev/meiliKeys.ts).
//
// Пароли базы и Valkey — DATABASE_PASSWORD и VALKEY_PASSWORD: вписываются в DATABASE_URL / VALKEY_URL без пароля.
import { readFileSync } from 'node:fs';

/** Только эти: *_FILE бывает и обычным путём (KEY_SERVICE_AUDIT_FILE — журнал аудита). */
export const SECRET_VARS = [
  'DATABASE_PASSWORD', 'VALKEY_PASSWORD', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'MEILI_MASTER_KEY', 'MEILI_API_KEY',
  'KEY_SERVICE_TOKENS', 'KEY_SERVICE_TOKEN', 'KEY_SERVICE_AUDIT_KEY', 'VAULT_TOKEN', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET',
  'RELAY_TURN_SECRET', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'RELAY_MASTER_KEY',
] as const;

type Env = Record<string, string | undefined>;

export function loadSecretFiles(env: Env = process.env, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): void {
  for (const name of SECRET_VARS) {
    const path = env[`${name}_FILE`];
    if (!path) continue;
    // и файл, и значение — ошибка конфигурации: непонятно, что из двух настоящее
    if (env[name]) throw new Error(`${name} and ${name}_FILE are both set — keep one`);
    let value: string;
    try { value = read(path).trim(); } catch (e) { throw new Error(`${name}_FILE: cannot read ${path} (${(e as Error).message})`); }
    env[name] = value;
  }
  for (const [pass, urlVar] of [['DATABASE_PASSWORD', 'DATABASE_URL'], ['VALKEY_PASSWORD', 'VALKEY_URL']] as const) {
    const p = env[pass], raw = env[urlVar];
    if (!p || !raw) continue;
    const url = new URL(raw);
    if (url.password) throw new Error(`${urlVar} already has a password and ${pass} is set — keep one`);
    url.password = encodeURIComponent(p);
    env[urlVar] = url.toString();
  }
}

loadSecretFiles();
