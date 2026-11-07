import { expect, test } from 'bun:test';
import { parseCallHash } from './callNotify';

test('#call= from the call notification: id is a uuid, accept only with accept=1', () => {
  const id = '6f1c2b8e-1d2a-4c3b-9e8f-0123456789ab';
  expect(parseCallHash('#call=' + id)).toEqual({ callId: id, accept: false });
  expect(parseCallHash('#call=' + id + '&accept=1')).toEqual({ callId: id, accept: true });
  expect(parseCallHash('#chat=5')).toBeNull();
  expect(parseCallHash('#call=../../x')).toBeNull();
});
