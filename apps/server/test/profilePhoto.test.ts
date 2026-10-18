import { beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { deletePhoto, getMe, getUser, setPhoto } from '../src/domain/profile';
import { listChats } from '../src/domain/chats';
import { fileFor } from '../src/domain/files';
import { makeChat, makeUser, resetDb } from './helpers';

beforeEach(resetDb);

const THUMB = 'data:image/jpeg;base64,' + 'A'.repeat(200);

async function img(owner: number, side: number, status = 'ready') {
  const [a] = await sql`insert into attachments (owner_id, mime, name, size, width, height, kind, status)
    values (${owner}, 'image/jpeg', 'photo.jpg', 1000, ${side}, ${side}, 'photo', ${status}) returning id`;
  return a.id as string;
}

test('set a profile photo: owner, chat peers and strangers see it, journal tells viewers, blocked users do not see it', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), c = await makeUser('Вера'), d = await makeUser('Глеб');
  await makeChat([a, b]); await makeChat([a, d]);
  const big = await img(a, 640), small = await img(a, 160);
  expect(await fileFor(c, big)).toBeNull();
  const me = await setPhoto(a, { id: big, small, thumb: THUMB });
  expect(me.photo).toMatchObject({ id: big, small, thumb: THUMB });
  expect((await getMe(a)).photo?.id).toBe(big);
  expect((await getUser(b, a)).photo?.small).toBe(small);
  const [u] = await sql`select payload from updates where user_id = ${b} and type = 'userUpdated' order by seq desc limit 1`;
  expect(u.payload).toMatchObject({ type: 'userUpdated', user: { id: a, photo: { id: big } } });
  expect((await listChats(b)).find((x) => x.peer?.id === a)?.peer?.photo?.small).toBe(small);
  expect(await fileFor(c, small)).not.toBeNull();                       // аватарку видит любой
  await sql`insert into blocks (owner_id, user_id) values (${a}, ${d})`;
  expect(await fileFor(d, big)).toBeNull();
  expect((await getUser(d, a)).photo).toBeNull();
  expect((await listChats(d)).find((x) => x.peer?.id === a)?.peer?.photo).toBeNull();
  expect((await deletePhoto(a)).photo).toBeNull();
  expect(await fileFor(c, big)).toBeNull();
});

test('photo must be own ready square images of sane size with a small data-URL thumb', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const big = await img(a, 640), small = await img(a, 160);
  const bad = (p: unknown) => expect(setPhoto(a, p)).rejects.toMatchObject({ code: 'photo_invalid' });
  await bad({ id: await img(b, 640), small, thumb: THUMB });           // чужой файл
  await bad({ id: await img(a, 640, 'pending'), small, thumb: THUMB }); // не загружен
  await bad({ id: big, small: await img(a, 2000), thumb: THUMB });      // маленькое — не маленькое
  await bad({ id: big, small, thumb: 'javascript:alert(1)' });
  await bad({ id: big, small, thumb: 'data:image/jpeg;base64,' + 'A'.repeat(5000) });
  await bad({ id: 'nope', small, thumb: THUMB });
  const [r] = await sql`insert into attachments (owner_id, mime, name, size, width, height, kind, status) values (${a}, 'image/jpeg', 'x.jpg', 1, 640, 480, 'photo', 'ready') returning id`;
  await bad({ id: r.id, small, thumb: THUMB });                         // не квадрат
  expect((await setPhoto(a, { id: big, small, thumb: THUMB })).photo?.id).toBe(big);
});

test('history: every new photo is kept, main first; delete main falls back to the next; set main; strangers list, blocked get nothing', async () => {
  const { deletePhoto: del, listPhotos, setMainPhoto } = await import('../src/domain/profile');
  const a = await makeUser('Анна'), b = await makeUser('Борис'), d = await makeUser('Глеб');
  await makeChat([a, b]); await makeChat([a, d]);
  const p1 = await setPhoto(a, { id: await img(a, 640), small: await img(a, 160), thumb: THUMB });
  const p2 = await setPhoto(a, { id: await img(a, 640), small: await img(a, 160), thumb: THUMB });
  const p3 = await setPhoto(a, { id: await img(a, 640), small: await img(a, 160), thumb: THUMB });
  let l = await listPhotos(b, a);
  expect(l.total).toBe(3);
  expect(l.photos.map((x) => x.id)).toEqual([p3.photo!.id, p2.photo!.id, p1.photo!.id]);
  expect(await fileFor(b, p1.photo!.small)).not.toBeNull();             // старое фото истории тоже видно
  const m = await setMainPhoto(a, p1.photo!.pid!);
  expect(m.photo?.id).toBe(p1.photo!.id);
  l = await listPhotos(b, a);
  expect(l.photos.map((x) => x.id)).toEqual([p1.photo!.id, p3.photo!.id, p2.photo!.id]);   // главное — первым
  const after = await del(a, p1.photo!.pid!);
  expect(after.photo?.id).toBe(p3.photo!.id);                           // главным стало новейшее из оставшихся
  expect(await fileFor(b, p1.photo!.id)).toBeNull();
  await del(a, p2.photo!.pid!);
  expect((await getMe(a)).photo?.id).toBe(p3.photo!.id);               // не главное — главное не трогаем
  await sql`insert into blocks (owner_id, user_id) values (${a}, ${d})`;
  expect(await listPhotos(d, a)).toEqual({ photos: [], total: 0 });
  expect((await del(a)).photo).toBeNull();
  expect((await listPhotos(b, a)).total).toBe(0);
});

test('video avatar: own square short mp4/webm; stored with its still frame', async () => {
  const a = await makeUser('Анна');
  const vid = async (side: number, dur: number, mime = 'video/webm') => {
    const [r] = await sql`insert into attachments (owner_id, mime, name, size, width, height, kind, duration, status)
      values (${a}, ${mime}, 'v.webm', 1000, ${side}, ${side}, 'round', ${dur}, 'ready') returning id`;
    return r.id as string;
  };
  const base = async () => ({ id: await img(a, 640), small: await img(a, 160), thumb: THUMB });
  await expect(setPhoto(a, { ...(await base()), video: await vid(640, 40) })).rejects.toMatchObject({ code: 'photo_invalid' });
  await expect(setPhoto(a, { ...(await base()), video: await img(a, 640) })).rejects.toMatchObject({ code: 'photo_invalid' });
  const v = await vid(640, 6);
  const me = await setPhoto(a, { ...(await base()), video: v });
  expect(me.photo?.video).toBe(v);
});
