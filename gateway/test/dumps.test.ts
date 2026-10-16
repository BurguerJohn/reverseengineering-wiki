import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeSegment, titleSegments } from '../src/dumps.ts';

test('text bundle paths: subpages become folders', () => {
  assert.deepEqual(titleSegments('Fact:Portable Executable (PE)/magic/4D 5A', 3014), ['Fact', 'Portable Executable (PE)', 'magic', '4D 5A']);
  assert.deepEqual(titleSegments('Main Page', 0), ['Main', 'Main Page']);
  assert.deepEqual(titleSegments('REWiki:Content policy', 4), ['REWiki', 'Content policy']);
});

test('text bundle paths: valid file names on every OS, reversibly escaped', () => {
  assert.equal(safeSegment('.?AV'), '.%3FAV');
  assert.equal(safeSegment('a<b>c:d"e\\f|g*h'), 'a%3Cb%3Ec%3Ad%22e%5Cf%7Cg%2Ah');
  assert.equal(safeSegment('100%'), '100%25');
  assert.equal(safeSegment('ends with dot.'), 'ends with dot%2E');
  assert.equal(safeSegment('trailing space '), 'trailing space%20');
  assert.equal(safeSegment('CON'), '%43ON');
  assert.equal(safeSegment('nul.txt'), '%6Eul.txt');
  assert.equal(safeSegment('Console'), 'Console');
  assert.equal(decodeURIComponent(safeSegment('x?y:z.')), 'x?y:z.');
});

test('robots.txt: articles indexable, dynamic URLs closed, dumps and gateway advertised', async () => {
  const { robotsTxt } = await import('../src/http/discovery.ts');
  const text = robotsTxt({ publicUrl: 'https://reverseengineering.wiki', mw: { publicUrl: 'https://reverseengineering.wiki' } } as any);
  assert.match(text, /^Allow: \/index\.php\/$/m);
  assert.match(text, /^Disallow: \/index\.php\?$/m);
  assert.match(text, /^Disallow: \/api\.php$/m);
  assert.match(text, /https:\/\/reverseengineering\.wiki\/dumps\/latest\/text\.zip/);
  assert.match(text, /https:\/\/reverseengineering\.wiki\/dumps\/latest\/pages\.xml\.gz/);
  assert.match(text, /https:\/\/reverseengineering\.wiki\/mcp/);
  assert.doesNotMatch(text, /^Disallow: \/mcp/m, 'agents whose fetchers honor robots.txt must still reach the gateway');
});
