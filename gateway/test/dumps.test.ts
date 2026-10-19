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
  assert.match(text, /^Sitemap: https:\/\/reverseengineering\.wiki\/sitemap\.xml$/m);
});

test('sitemap: main page first, URLs spelled as MediaWiki spells them, split past 50,000', async () => {
  const { sitemapFiles } = await import('../src/http/discovery.ts');
  const config = { publicUrl: 'https://reverseengineering.wiki', mw: { publicUrl: 'https://reverseengineering.wiki' } } as any;
  const one = sitemapFiles(config, [
    { title: "Library:Ren'Py", touched: '2026-10-19T10:00:00Z' },
    { title: 'Format:PE (Portable Executable)', touched: '2026-10-18T10:00:00Z' },
    { title: 'Fact:Zlib/enum/Flush modes, values & names', touched: '2026-10-17T10:00:00Z' },
  ]);
  assert.deepEqual(Object.keys(one), ['sitemap.xml']);
  const locs = [...one['sitemap.xml'].matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
  assert.deepEqual(locs, [
    'https://reverseengineering.wiki/index.php/Main_Page',
    'https://reverseengineering.wiki/index.php/Library:Ren%27Py',
    'https://reverseengineering.wiki/index.php/Format:PE_(Portable_Executable)',
    'https://reverseengineering.wiki/index.php/Fact:Zlib/enum/Flush_modes,_values_%26_names',
  ]);
  assert.match(one['sitemap.xml'], /<lastmod>2026-10-19T10:00:00Z<\/lastmod>/);
  const many = sitemapFiles(config, Array.from({ length: 50_000 }, (_, i) => ({ title: `Fact:X/${i}`, touched: '2026-10-19T10:00:00Z' })));
  assert.deepEqual(Object.keys(many).sort(), ['sitemap-1.xml', 'sitemap-2.xml', 'sitemap.xml']);
  assert.match(many['sitemap.xml'], /<sitemapindex[^]*<loc>https:\/\/reverseengineering\.wiki\/sitemap-2\.xml<\/loc>/);
  assert.equal([...many['sitemap-2.xml'].matchAll(/<url>/g)].length, 1);
});
