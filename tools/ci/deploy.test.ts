import { expect, test } from 'bun:test';

// deploy/make-secrets.sh выводит MEILI_SEARCH_KEY из мастер-ключа и uid ключа, а создаёт ключ с этим uid
// apps/server/src/dev/meiliKeys.ts (deploy.sh сверяет): uid в двух местах должен совпадать
test('MEILI_SEARCH_UID in deploy/make-secrets.sh matches UID in meiliKeys.ts', async () => {
  const env = /MEILI_SEARCH_UID=([0-9a-f-]+)/.exec(await Bun.file('deploy/make-secrets.sh').text())?.[1];
  const ts = /const UID = '([0-9a-f-]+)'/.exec(await Bun.file('apps/server/src/dev/meiliKeys.ts').text())?.[1];
  expect(env).toBeTruthy();
  expect(env).toBe(ts);
});
