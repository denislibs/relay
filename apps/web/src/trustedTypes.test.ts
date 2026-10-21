import { expect, test } from 'bun:test';
import { sameOriginScriptUrl } from './trustedTypes';

test('script URLs: own origin passes, a foreign one is refused', () => {
  expect(sameOriginScriptUrl('/sw.js', 'https://relay.test')).toBe('https://relay.test/sw.js');
  expect(sameOriginScriptUrl('https://relay.test/main-1.js', 'https://relay.test')).toBe('https://relay.test/main-1.js');
  expect(() => sameOriginScriptUrl('https://evil.test/x.js', 'https://relay.test')).toThrow('not allowed');
  expect(() => sameOriginScriptUrl('data:text/javascript,alert(1)', 'https://relay.test')).toThrow('not allowed');
});
