import { expect, test } from 'bun:test';
import { linkUrl, normalizeLinks, parseLinkHandle } from './links';

test('handle from a name, an @name or a pasted address of the same service', () => {
  expect(parseLinkHandle('github', 'hoho')).toBe('hoho');
  expect(parseLinkHandle('github', ' @hoho ')).toBe('hoho');
  expect(parseLinkHandle('github', 'https://www.github.com/hoho/')).toBe('hoho');
  expect(parseLinkHandle('linkedin', 'linkedin.com/in/momo?trk=x')).toBe('momo');
  expect(parseLinkHandle('youtube', 'https://youtube.com/@chan.name')).toBe('chan.name');
  expect(parseLinkHandle('instagram', 'my.name')).toBe('my.name');
});

test('foreign sites, extra paths and bad characters are refused', () => {
  expect(parseLinkHandle('github', 'https://github.com.evil.io/hoho')).toBeNull();
  expect(parseLinkHandle('github', 'gitlab.com/hoho')).toBeNull();
  expect(parseLinkHandle('github', 'github.com/hoho/repo')).toBeNull();
  expect(parseLinkHandle('linkedin', 'linkedin.com/company/acme')).toBeNull();
  expect(parseLinkHandle('instagram', 'javascript:alert(1)')).toBeNull();
  expect(parseLinkHandle('x', 'a'.repeat(16))).toBeNull();
  expect(parseLinkHandle('github', '-bad')).toBeNull();
  expect(parseLinkHandle('telegram', 'abc')).toBeNull();
});

test('list: known services only, duplicates dropped, limit kept; url is built from the template', () => {
  expect(normalizeLinks([{ service: 'github', handle: 'hoho' }, { service: 'github', handle: 'HOHO' }, { service: 'x', handle: '@xixi' }]))
    .toEqual([{ service: 'github', handle: 'hoho' }, { service: 'x', handle: 'xixi' }]);
  expect(normalizeLinks([{ service: 'myspace', handle: 'a' }])).toBeNull();
  expect(normalizeLinks([{ service: 'github', handle: 'a b' }])).toBeNull();
  expect(normalizeLinks(Array.from({ length: 11 }, (_, i) => ({ service: 'github', handle: 'u' + i })))).toBeNull();
  expect(normalizeLinks('x')).toBeNull();
  expect(linkUrl({ service: 'linkedin', handle: 'momo' })).toBe('https://linkedin.com/in/momo');
  expect(linkUrl({ service: 'tiktok', handle: 'a.b' })).toBe('https://tiktok.com/@a.b');
});
