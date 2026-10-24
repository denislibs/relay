// Копия medium (пузырь в ленте, jobs/photo.ts) для фото, загруженных до неё: ставит photo.process с redo на каждое,
// делает их воркер (свой цикл фото, малый параллелизм). Идемпотентен: готовые пропускаются, стоящие в очереди не дублируются.
//   docker compose run --rm worker bun apps/server/src/backfillPhotos.ts
import { sql } from './db';
import { backfillPhotos } from './jobs/photo';

if (import.meta.main) {
  const n = await backfillPhotos({ log: console.log });
  console.log(`photo backfill: ${n} photos queued for the medium copy`);
  await sql.end();
}
