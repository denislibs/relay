import { expect, test } from 'bun:test';
import {
  chunkCount, chunksFor, encryptedSize, FILE_HEADER, importFileKey, newFileKey, newNonceBase, openChunk, openFile,
  readHeader, sealedRange, sealedSource, sealFile, variantKey,
} from './fileCrypto';

const bytes = (n: number) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 255; return b; };
const C = 1024;   // маленький кусок — быстрые тесты на границах

test('round trip for sizes around chunk boundaries, empty file included', async () => {
  const key = await importFileKey(newFileKey());
  for (const n of [0, 1, C - 1, C, C + 1, 3 * C, 3 * C + 5]) {
    const plain = new Blob([bytes(n)]);
    const sealed = await sealFile(plain, key, C);
    expect(sealed.size).toBe(encryptedSize(n, C));
    expect(new Uint8Array(await (await openFile(sealed, key)).arrayBuffer())).toEqual(bytes(n));
  }
});

test('any byte range of the object can be produced without the whole (multipart parts cut anywhere)', async () => {
  const key = await importFileKey(newFileKey());
  const h = { chunk: C, size: 5 * C + 100, base: newNonceBase() };
  const src = sealedSource(new Blob([bytes(h.size)]), key, h);
  const whole = new Uint8Array(await (await src.slice(0, src.size)).arrayBuffer());
  for (const [a, b] of [[0, 10], [5, FILE_HEADER + 3], [FILE_HEADER + C - 2, FILE_HEADER + C + 40], [1000, 4000], [src.size - 7, src.size]]) {
    expect(new Uint8Array(await (await src.slice(a, b)).arrayBuffer())).toEqual(whole.slice(a, b));
  }
  // повтор той же части — те же байты (ключ и основа nonce те же)
  expect(new Uint8Array(await (await src.slice(1000, 4000)).arrayBuffer())).toEqual(whole.slice(1000, 4000));
});

test('a plaintext range maps to chunks; each chunk opens alone (what the SW does for Range)', async () => {
  const key = await importFileKey(newFileKey());
  const h = { chunk: C, size: 4 * C + 10, base: newNonceBase() };
  const whole = new Uint8Array(await (await sealedSource(new Blob([bytes(h.size)]), key, h).slice(0, encryptedSize(h.size, C))).arrayBuffer());
  expect(readHeader(whole)).toMatchObject({ chunk: C, size: h.size });
  const { first, last } = chunksFor(h, 2 * C + 5, 3 * C + 3);
  expect([first, last]).toEqual([2, 3]);
  const [s, e] = sealedRange(h, 4);
  expect(e - s).toBe(10 + 16);
  expect(new Uint8Array(await openChunk(key, h, 4, whole.slice(s, e)))).toEqual(bytes(h.size).slice(4 * C));
});

test('swapped chunks, a truncated file, a wrong key or a flipped bit do not open', async () => {
  const key = await importFileKey(newFileKey()), other = await importFileKey(newFileKey());
  const h = { chunk: C, size: 3 * C, base: newNonceBase() };
  const whole = new Uint8Array(await (await sealedSource(new Blob([bytes(h.size)]), key, h).slice(0, encryptedSize(h.size, C))).arrayBuffer());
  const [s0, e0] = sealedRange(h, 0), [s1, e1] = sealedRange(h, 1);
  await expect(openChunk(key, h, 1, whole.slice(s0, e0))).rejects.toThrow();            // кусок 0 на месте 1
  await expect(openChunk(key, { ...h, size: 2 * C }, 1, whole.slice(s1, e1))).rejects.toThrow();   // «последний» — обрезали
  await expect(openChunk(other, h, 0, whole.slice(s0, e0))).rejects.toThrow();
  const bad = whole.slice(s0, e0); bad[5] ^= 1;
  await expect(openChunk(key, h, 0, bad)).rejects.toThrow();
});

test('variant keys are derived, stable and distinct; files before encryption pass through openFile untouched', async () => {
  const k = newFileKey();
  expect(await variantKey(k, 'preview')).toEqual(await variantKey(k, 'preview'));
  expect(await variantKey(k, 'preview')).not.toEqual(await variantKey(k, '720'));
  const plain = new Blob([bytes(100)]);
  expect(await openFile(plain, await importFileKey(k))).toBe(plain);
  expect(chunkCount(0)).toBe(1);
});
