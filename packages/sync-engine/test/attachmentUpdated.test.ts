import { expect, test } from 'bun:test';
import { openDb } from '../src/idb';
import { Store } from '../src/store';
import { msg } from './fixtures';

// attachmentUpdated (копии фото/видео готовы) правит размер и копии поверх вложения, которое уже знаем: имя,
// миниатюра и ключ файла в событии могут отсутствовать (сервер старой сборки слал вложение без текста) — своё не теряем

const ME = 1, PEER = 2, CH = 7;
const fresh = async () => Store.open(await openDb('au-' + crypto.randomUUID()), ME);
const att = { id: 'p', kind: 'photo', mime: 'image/jpeg', name: 'a.jpg', size: 10, w: 100, h: 50, thumb: 'data:image/jpeg;base64,AAAA' } as const;

test('attachmentUpdated: copies and size come on top, name and thumb the event lacks stay', async () => {
  const s = await fresh();
  s.applyHistory(CH, [msg({ id: 1, chatId: CH, senderId: PEER, kind: 'photo', attachment: att as never })], true, null);
  s.applyUpdate({ type: 'attachmentUpdated', chatId: CH, id: 1, attachment: { id: 'p', kind: 'photo', mime: 'image/jpeg', size: 12, w: 100, h: 50, preview: { name: 'preview', w: 48, h: 24, size: 1 }, variants: [{ name: 'medium', w: 80, h: 40, size: 2 }] } as never });
  expect(s.messageById(CH, 1)!.attachment).toMatchObject({ name: 'a.jpg', thumb: 'data:image/jpeg;base64,AAAA', size: 12, preview: { name: 'preview' }, variants: [{ name: 'medium' }] });
});

test('attachmentUpdated: a full attachment in the event wins field by field', async () => {
  const s = await fresh();
  s.applyHistory(CH, [msg({ id: 1, chatId: CH, senderId: PEER, kind: 'photo', attachment: att as never })], true, null);
  s.applyUpdate({ type: 'attachmentUpdated', chatId: CH, id: 1, attachment: { ...att, size: 12, thumb: 'data:image/jpeg;base64,BBBB' } as never });
  expect(s.messageById(CH, 1)!.attachment).toMatchObject({ name: 'a.jpg', thumb: 'data:image/jpeg;base64,BBBB', size: 12 });
});
