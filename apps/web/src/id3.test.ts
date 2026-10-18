import { expect, test } from 'bun:test';
import { parseId3 } from './id3';

const enc = new TextEncoder();
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const safe = (n: number) => [(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127];

function tag(ver: 3 | 4, frames: [string, number[]][]): Uint8Array {
  const body = frames.flatMap(([id, data]) => [...enc.encode(id), ...(ver === 4 ? safe(data.length) : be32(data.length)), 0, 0, ...data]);
  return new Uint8Array([0x49, 0x44, 0x33, ver, 0, 0, ...safe(body.length + 16), ...body, ...new Array(16).fill(0), 0xff, 0xfb]);
}
const utf8 = (s: string) => [3, ...enc.encode(s)];
const utf16 = (s: string) => { const out = [1, 0xff, 0xfe]; for (const ch of s) { const c = ch.charCodeAt(0); out.push(c & 255, c >> 8); } return out; };

test('v2.3 UTF-16 title and artist, cover picture', () => {
  const pic = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3];
  const t = parseId3(tag(3, [
    ['TIT2', utf16('Мы Сверхновая')], ['TPE1', utf16('denis1488')],
    ['APIC', [0, ...enc.encode('image/jpeg'), 0, 3, ...enc.encode('cover'), 0, ...pic]],
  ]));
  expect(t.title).toBe('Мы Сверхновая');
  expect(t.performer).toBe('denis1488');
  expect(t.cover?.mime).toBe('image/jpeg');
  expect([...t.cover!.data]).toEqual(pic);
});

test('v2.4 UTF-8 with syncsafe frame sizes; trailing zeros cut', () => {
  const t = parseId3(tag(4, [['TIT2', [...utf8('Офисный планктон'), 0]], ['TPE1', utf8('niceraudiostream479')]]));
  expect(t).toMatchObject({ title: 'Офисный планктон', performer: 'niceraudiostream479', cover: null });
});

test('no tag — empty', () => {
  expect(parseId3(new Uint8Array([0xff, 0xfb, 0x90, 0x64]))).toEqual({ title: null, performer: null, cover: null });
});
