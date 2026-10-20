import { expect, test } from 'bun:test';
import type { ProfilePhoto } from '@relay/protocol';
import { setGlobal, type Me } from './global';
import { userPhoto } from './profilePhoto';

const ph = (id: string): ProfilePhoto => ({ id, small: id + 's', thumb: '', at: 0 });
const chat = (peerId: number, photo: ProfilePhoto | null) => ({ key: 'c' + peerId, id: peerId, kind: 'direct', peerId, photo });
const contact = (userId: number, photo: ProfilePhoto | null) => ({ key: 'u' + userId, userId, photo });

test('userPhoto: своё, затем people (даже null), затем личный чат, затем контакт', () => {
  setGlobal({
    me: { userId: 1, name: 'Я', photo: ph('me') } as unknown as Me,
    people: { 2: { key: '2', id: 2, name: 'Анна', photo: ph('people2') }, 3: { key: '3', id: 3, name: 'Борис', photo: null } },
    chats: [chat(2, ph('chat2')), chat(3, ph('chat3')), chat(4, ph('chat4'))],
    contacts: [contact(2, ph('contact2')), contact(4, ph('contact4')), contact(5, ph('contact5'))],
  });
  expect(userPhoto(1)?.id).toBe('me');
  expect(userPhoto(2)?.id).toBe('people2');   // people свежее чата и контакта
  expect(userPhoto(3)).toBeNull();            // в people без фото — так и есть, старое фото чата не берём
  expect(userPhoto(4)?.id).toBe('chat4');     // нет в people — личный чат
  expect(userPhoto(5)?.id).toBe('contact5');  // нет ни в people, ни в чатах — контакт
  expect(userPhoto(6)).toBeNull();
  expect(userPhoto(null)).toBeNull();
});
