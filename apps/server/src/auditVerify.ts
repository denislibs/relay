// Проверка журнала аудита сервиса ключей: bun apps/server/src/auditVerify.ts <файл>, ключ — KEY_SERVICE_AUDIT_KEY.
// Код выхода 0 — цепочка цела; 1 — разрыв (номер строки и причина).
import { auditKeyFromEnv, verifyAuditLog } from './auditLog';

const file = process.argv[2];
if (!file) { console.error('usage: bun apps/server/src/auditVerify.ts <audit.log>'); process.exit(2); }
if (!process.env.KEY_SERVICE_AUDIT_KEY) { console.error('KEY_SERVICE_AUDIT_KEY is not set'); process.exit(2); }
const r = verifyAuditLog(await Bun.file(file).text(), auditKeyFromEnv());
if (r.ok) console.log(`audit log ok: ${r.count} entries`);
else { console.error(`audit log BROKEN at line ${r.line}: ${r.reason}`); process.exit(1); }
