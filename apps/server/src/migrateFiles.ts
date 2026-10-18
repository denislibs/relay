// Перенос вложений с прежнего тома (FILES_DIR/<id>) в бакет S3 (ключ = id).
//   docker compose --profile tools run --rm migrate-files            перенести
//   docker compose --profile tools run --rm migrate-files --dry-run  только посчитать
// Идемпотентен: объект, который уже лежит в бакете с тем же размером, пропускается, поэтому прерванный перенос
// можно запустить снова. Том не трогаем — удалить его (docker volume rm <project>_files) можно после проверки.
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from './db';
import { s3 } from './domain/files';

export interface MigrateReport { copied: number; skipped: number; missing: string[]; mismatched: string[] }

export async function migrateFiles(opts: { dir: string; dryRun?: boolean; log?: (s: string) => void }): Promise<MigrateReport> {
  const log = opts.log ?? (() => {});
  const report: MigrateReport = { copied: 0, skipped: 0, missing: [], mismatched: [] };
  // pending — новые загрузки, их файлы уже идут прямо в бакет
  const rows = await sql`select id, mime, size from attachments where status = 'ready' order by created_at`;
  for (const r of rows) {
    const id = r.id as string, size = Number(r.size);
    const path = join(opts.dir, id);
    const there = await s3().file(id).stat().catch(() => null);
    if (there && there.size === size) { report.skipped++; continue; }
    if (!existsSync(path)) { report.missing.push(id); log(`missing on disk: ${id}`); continue; }
    if (statSync(path).size !== size) { report.mismatched.push(id); log(`size differs from the database, skipped: ${id}`); continue; }
    if (opts.dryRun) { report.copied++; continue; }
    await s3().write(id, Bun.file(path), { type: r.mime as string });
    const check = await s3().file(id).stat();
    if (check.size !== size) throw new Error(`upload of ${id} came out ${check.size} bytes, expected ${size}`);
    report.copied++;
    if (report.copied % 100 === 0) log(`copied ${report.copied}…`);
  }
  return report;
}

if (import.meta.main) {
  const dryRun = process.argv.includes('--dry-run');
  const dir = process.env.FILES_DIR ?? '/data/files';
  const r = await migrateFiles({ dir, dryRun, log: console.log });
  console.log(`${dryRun ? 'would copy' : 'copied'} ${r.copied}, already in bucket ${r.skipped}, missing on disk ${r.missing.length}, size mismatch ${r.mismatched.length}`);
  await sql.end();
  if (r.mismatched.length) process.exit(1);
}
