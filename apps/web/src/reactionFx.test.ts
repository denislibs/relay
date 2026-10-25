import { expect, test } from 'bun:test';
import { queueReactionFx, takeReactionFx } from './reactionFx';

test('заявка на эффект забирается один раз и только для своего сообщения', () => {
  queueReactionFx('m1', '❤');
  queueReactionFx('m1', '🔥');   // последняя перекрывает
  expect(takeReactionFx('m2')).toBeUndefined();
  expect(takeReactionFx('m1')).toBe('🔥');
  expect(takeReactionFx('m1')).toBeUndefined();
});
