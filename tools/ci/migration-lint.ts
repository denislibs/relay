// Проверка новых миграций в CI (.github/workflows/ci.yml). Миграции не откатываются (deploy/deploy.sh), а прежний
// код работает и во время выката, и после отката — поэтому схема меняется только совместимо:
//   drop      — DROP чего угодно (кроме ослабляющих DROP NOT NULL / DROP DEFAULT): прежний код ещё читает;
//   rename    — RENAME: прежний код ходит по старому имени;
//   not-null  — ADD COLUMN … NOT NULL без DEFAULT и SET NOT NULL: прежний код не пишет новую колонку;
//   edited    — правка, удаление или переименование уже существующего файла: применённая миграция не перезапускается.
// Осознанно разрешить — комментарий в самом файле миграции, с причиной:
//   -- migration-lint: allow drop, rename — колонка не читается с версии …
//
//   bun tools/ci/migration-lint.ts <base-ref>    — файлы apps/server/migrations, изменённые после base-ref
//   bun tools/ci/migration-lint.ts --all         — все файлы (справка: сколько исторических нарушило бы правила)
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Rule = 'drop' | 'rename' | 'not-null' | 'edited';
export type Problem = { rule: Rule; statement: string };

const MIGRATIONS = 'apps/server/migrations';

/** Разрешённые правила из комментария `-- migration-lint: allow a, b`. */
export function allowed(sql: string): Set<Rule> {
  const out = new Set<Rule>();
  for (const m of sql.matchAll(/--\s*migration-lint:\s*allow\s+([a-z,\s-]+)/gi)) {
    for (const r of m[1]!.split(/[\s,]+/)) if (r) out.add(r.toLowerCase() as Rule);
  }
  return out;
}

/** SQL без комментариев, строк и тел функций ($$…$$): правила смотрят только на сами команды. */
function strip(sql: string): string {
  return sql
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

/** Части через запятую верхнего уровня (не внутри скобок): действия одного ALTER TABLE. */
function topLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

/** Нарушения в тексте одной миграции (без учёта разрешений). */
export function lintSql(sql: string): Problem[] {
  const problems: Problem[] = [];
  for (const raw of strip(sql).split(';')) {
    const st = raw.replace(/\s+/g, ' ').trim();
    if (!st) continue;
    const lower = st.toLowerCase();
    if (/\bdrop\b(?!\s+(not\s+null|default)\b)/.test(lower)) problems.push({ rule: 'drop', statement: st });
    if (/\brename\b/.test(lower)) problems.push({ rule: 'rename', statement: st });
    if (/\bset\s+not\s+null\b/.test(lower)) problems.push({ rule: 'not-null', statement: st });
    const alter = /^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?\S+\s+(.*)$/s.exec(lower);
    if (alter) {
      for (const action of topLevel(alter[1]!).map((a) => a.trim())) {
        if (!/^add\b/.test(action) || /^add\s+(constraint|primary|unique|foreign|check|exclude)\b/.test(action)) continue;
        if (/\bnot\s+null\b/.test(action) && !/\b(default|generated)\b/.test(action)) problems.push({ rule: 'not-null', statement: st });
      }
    }
  }
  return problems;
}

/** Нарушения в файле с учётом его разрешений. */
export function lintFile(sql: string, edited = false): Problem[] {
  const allow = allowed(sql);
  const problems = edited ? [{ rule: 'edited' as const, statement: '(existing migration changed)' }] : [];
  return [...problems, ...lintSql(sql)].filter((p) => !allow.has(p.rule));
}

async function changedSince(base: string): Promise<{ file: string; status: string }[]> {
  const out = await Bun.$`git diff --name-status --no-renames ${base}...HEAD -- ${MIGRATIONS}`.text();
  return out.split('\n').filter(Boolean).map((l) => {
    const [status, file] = l.split('\t');
    return { status: status!, file: file! };
  }).filter((c) => c.file.endsWith('.sql'));
}

if (import.meta.main) {
  const arg = process.argv[2];
  if (!arg) { console.error('usage: bun tools/ci/migration-lint.ts <base-ref> | --all'); process.exit(2); }
  const files = arg === '--all'
    ? readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).map((f) => ({ status: 'A', file: join(MIGRATIONS, f) }))
    : await changedSince(arg);
  let bad = 0;
  for (const { status, file } of files) {
    if (status === 'D') { console.log(`✗ ${file}: [edited] migration deleted`); bad++; continue; }
    const problems = lintFile(readFileSync(file, 'utf8'), status !== 'A');
    for (const p of problems) console.log(`✗ ${file}: [${p.rule}] ${p.statement.slice(0, 160)}`);
    if (problems.length) bad++;
  }
  if (bad) {
    console.log(`\n${bad} migration file(s) are not backward compatible. Make the change additive, or allow it explicitly ` +
      `in the file with a reason:  -- migration-lint: allow <drop|rename|not-null|edited> — <why it is safe>`);
    process.exit(1);
  }
  console.log(`migration lint: ${files.length} file(s) ok`);
}
