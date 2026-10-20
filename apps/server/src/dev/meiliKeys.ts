// Выпустить ключ Meilisearch «только поиск» для процесса server (MEILI_API_KEY в docker-compose.secure.yml).
// Запуск (мастер-ключ — из окружения):  MEILI_URL=… MEILI_MASTER_KEY=… bun apps/server/src/dev/meiliKeys.ts
// Ключ с постоянным uid: повторный запуск вернёт тот же ключ, а не создаст второй.
import { meili } from '../search/meili';

const UID = '6f1b0c52-5e2a-4c1e-9a7d-0000000000a1';
type Key = { uid: string; key: string; actions: string[] };

const existing = await meili<Key>(`/keys/${UID}`).catch(() => null);
const key = existing ?? await meili<Key>('/keys', { method: 'POST', body: {
  uid: UID, name: 'relay-server-search', description: 'Relay server: search only (no writes, no settings)',
  actions: ['search'], indexes: ['*'], expiresAt: null,
} });
console.log(`MEILI_API_KEY=${key.key}   # actions: ${key.actions.join(', ')}`);
