import { expect, test } from 'bun:test';
import { sameOriginScriptUrl } from './trustedTypes';

test('script URLs: own origin passes, a foreign one is refused', () => {
  expect(sameOriginScriptUrl('/sw.js', 'https://relay.test')).toBe('https://relay.test/sw.js');
  expect(sameOriginScriptUrl('https://relay.test/main-1.js', 'https://relay.test')).toBe('https://relay.test/main-1.js');
  expect(() => sameOriginScriptUrl('https://evil.test/x.js', 'https://relay.test')).toThrow('not allowed');
  expect(() => sameOriginScriptUrl('data:text/javascript,alert(1)', 'https://relay.test')).toThrow('not allowed');
});

test('boot.js installs the policy first: main plugs the sanitizer into it, HTML is refused until then', async () => {
  const { installDefaultPolicy } = await import('./trustedPolicy');
  const made: Array<{ name: string; p: { createHTML(s: string): string; createScriptURL(s: string): string } }> = [];
  const scope: { trustedTypes: { createPolicy(name: string, p: never): unknown; defaultPolicy?: unknown }; __relayTT?: never } = {
    trustedTypes: { createPolicy: (name: string, p: never) => { made.push({ name, p }); return p; } },
  };
  expect(installDefaultPolicy(scope as never)).toBe(true);
  expect(() => made[0].p.createHTML('<b>x</b>')).toThrow('before the sanitizer');
  expect(installDefaultPolicy(scope as never, (s) => 'clean:' + s)).toBe(true);
  expect(made).toHaveLength(1);   // вторая политика default не создаётся
  expect(made[0].p.createHTML('<b>x</b>')).toBe('clean:<b>x</b>');
});
