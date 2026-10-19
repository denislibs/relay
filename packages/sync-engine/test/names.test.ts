import { expect, test } from 'bun:test';
import type { PublicUser } from '@relay/protocol';
import { openDb } from '../src/idb';
import { displayName, personView } from '../src/names';
import { Store } from '../src/store';

const user = (id: number, name: string): PublicUser =>
  ({ id, name, publicName: name, firstName: name, lastName: '', username: null, bio: null, birthday: null, phone: null, links: [] }) as PublicUser;
const contact = (id: number, firstName: string, u: PublicUser, seq = 1) => ({ userId: id, firstName, lastName: '', note: '', user: u, seq });
const open = async () => Store.open(await openDb('names-' + crypto.randomUUID()), 1);

test('no contact: own public name; contact name wins; rename keeps the users row; removal returns the public name', async () => {
  const s = await open();
  const u = user(2, 'Мария Иванова');
  s.profile.applyUser(u);
  expect(displayName(s, 2)).toBe('Мария Иванова');

  s.contacts.applyContact(contact(2, 'Мама', u, 1));
  expect(displayName(s, 2)).toBe('Мама');
  const uv = s.users.get(2)!.v;
  const sig1 = personView(s, 2).sig;

  s.contacts.applyContact(contact(2, 'Мамочка', u, 2));
  expect(displayName(s, 2)).toBe('Мамочка');
  expect(s.users.get(2)!.v).toBe(uv);
  expect(personView(s, 2).sig).not.toBe(sig1);

  s.contacts.applyRemoved(2, 3);
  expect(displayName(s, 2)).toBe('Мария Иванова');
});

test('unconfirmed contact edit changes the name and sig at once; unknown user gives empty name', async () => {
  const s = await open();
  const u = user(3, 'Борис');
  s.profile.applyUser(u);
  s.contacts.applyContact(contact(3, 'Боб', u, 1));
  const before = personView(s, 3).sig;
  s.contactOf = (id) => (id === 3 ? { firstName: 'Боря', lastName: '', pending: true } : undefined);
  expect(displayName(s, 3)).toBe('Боря');
  expect(personView(s, 3).sig).not.toBe(before);
  expect(displayName(s, 99)).toBe('');
  expect(personView(s, 99)).toEqual({ name: '', photo: null, sig: '0:0:' });
});
