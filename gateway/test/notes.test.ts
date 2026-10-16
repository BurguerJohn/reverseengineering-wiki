import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildArticle, checkAddress, checkFactData, factKey, shortLabel, suggestedSections, EMPTY } from '../src/wiki/pages.ts';
import { findSection, headingKey, parseSections } from '../src/wiki/wikitext.ts';
import { markdownToWikitext } from '../src/wiki/markdown.ts';
import { tidyArticle } from '../src/wiki/tidy.ts';
import { extractFromText, isFileName, queryTokens } from '../src/index/identifiers.ts';
import { SearchIndex } from '../src/index/index.ts';

test('headings with & are one section, however they were written', () => {
  assert.equal(headingKey('Engine &amp; libraries used'), headingKey('Engine & libraries used'));
  const sections = parseSections('Lead\n== Engine &amp; libraries used ==\nx\n');
  assert.ok(findSection(sections, 'Engine & libraries used'));
  assert.match(markdownToWikitext('## Engine & libraries used\n\nA & B, a < b'), /A & B, a &lt; b/, 'a lone & stays readable; < is still escaped');
  assert.match(markdownToWikitext('## Engine & libraries used'), /== Engine & libraries used ==/);
});

test('new pages only get the sections that were written; read suggests the rest', () => {
  const text = buildArticle({ type: 'software', title: 'Software:SkiFree', summary: 'A 1991 skiing game.', infobox: {}, bodyWikitext: '== Controls ==\nArrow keys.' });
  const headings = parseSections(text).filter((s) => s.level > 0).map((s) => s.heading);
  assert.deepEqual(headings, ['Controls']);
  assert.doesNotMatch(text, /Nothing documented yet/);
  const suggested = suggestedSections('software', parseSections(text));
  assert.ok(suggested.includes('Identification') && suggested.includes('Modding entry points') && !suggested.includes('Controls'));
});

test('tidy-pages merges the &amp; duplicates and drops empty placeholders', () => {
  const before = [
    'Lead', '== Identification ==', 'Strings.', `== Scope ==`, EMPTY,
    '== Engine &amp; libraries used ==', EMPTY, '== Vehicles ==', 'Tanks.',
    '== Engine & libraries used ==', 'Uses CRIWARE.', '== Facts ==', '{{Fact list|EDF5}}',
    '== Evidence &amp; references ==', '* a source', '== Evidence & references ==', '* another source', '',
  ].join('\n');
  const { text, changes } = tidyArticle(before);
  const headings = parseSections(text).filter((s) => s.level > 0).map((s) => s.heading);
  assert.deepEqual(headings, ['Identification', 'Engine & libraries used', 'Vehicles', 'Evidence & references']);
  assert.match(text, /== Engine & libraries used ==\nUses CRIWARE\./);
  assert.match(text, /\* a source\n\* another source/);
  assert.ok(changes.length >= 4);
  assert.equal(tidyArticle(text).changes.length, 0, 'idempotent');
});

test('fact titles: explicit key, per-kind field, or a clean first clause', () => {
  assert.equal(shortLabel('The camera keeps the player at (window width / 2, 1/3 of the height) while scrolling.'), 'The camera keeps the player');
  assert.doesNotMatch(shortLabel('SkiFree draws random numbers with the Microsoft C runtime rand() seeded from the clock'), /\($/);
  const base = { subject: 'Software:SkiFree', claim: 'Bitmaps are stored as resources in the NE file.', scope: { level: 'software' as const, applies_to: 'all', observed_in: [] }, evidence: [], confidence: 'low' as const, related: [] };
  assert.equal(factKey({ ...base, kind: 'behavior', data: {}, key: 'Bitmap storage' }), 'Bitmap storage');
  assert.equal(factKey({ ...base, kind: 'identification', data: { method: 'resources', indicator: 'NE resource type 2 with 60+ bitmaps' } }), 'NE resource type 2 with 60+ bitmaps');
  assert.equal(factKey({ ...base, kind: 'behavior', data: {} }), 'Bitmaps are stored as resources in the NE file');
});

test('addresses beyond RVA: segmented, banked, va, file offset', () => {
  assert.equal(checkAddress({ kind: 'segmented', value: 'DS:00CC' }), null);
  assert.equal(checkAddress({ kind: 'segmented', value: 'CS:5AFA' }), null);
  assert.equal(checkAddress({ kind: 'segmented', value: '1000:5AFA' }), null);
  assert.equal(checkAddress({ kind: 'banked', value: '03:8000' }), null);
  assert.equal(checkAddress({ kind: 'va', value: '0x80012345' }), null);
  assert.match(String(checkAddress({ kind: 'rva', value: '0x10' })), /data\.rva/);
  assert.deepEqual(checkFactData('function', { name: 'DrawSkier', address: { kind: 'segmented', value: 'CS:5AFA' } }), []);
  assert.match(checkFactData('function', { name: 'DrawSkier' }).join(' '), /data\.address/);
});

test('file names are exact identifiers, not loose words', () => {
  assert.equal(isFileName('ski.exe'), true);
  assert.equal(isFileName('e.g.'), false);
  assert.ok(queryTokens('ski.exe').some((t) => t.kind === 'file' && t.token === 'ski.exe'));
  assert.ok(extractFromText('Run EDF5.exe from <game dir>').some((t) => t.kind === 'file' && t.token === 'edf5.exe'));
});

test('renamed builds: facts citing any older title still find them', () => {
  const index = new SearchIndex(':memory:');
  const json = (o: unknown) => JSON.stringify(o);
  index.indexPage({ title: 'Build:Game/1.0 (snes, cartridge)', revid: 3, timestamp: 't', user: 'u', content: json({ schema: 'rewiki.build/1', software: 'Software:Game', version: '1.0', platform: 'snes', distribution: 'cartridge', files: [] }) });
  index.indexPage({ title: 'Fact:Game/function/Main @ x', revid: 4, timestamp: 't', user: 'u', content: json({ kind: 'function', subject: 'Software:Game', claim: 'c', status: 'claimed', scope: { level: 'build', applies_to: 'Build:Game/USA Cartridge SNES', observed_in: [] }, data: { name: 'Main', rva: '0x10' } }) });
  index.recordMove('Build:Game/USA Cartridge SNES', 'Build:Game/USA (snes)');
  index.recordMove('Build:Game/USA (snes)', 'Build:Game/1.0 (snes, cartridge)');
  assert.equal(index.resolveRedirect('Build:Game/USA Cartridge SNES'), 'Build:Game/1.0 (snes, cartridge)');
  assert.deepEqual(index.namesOf('Build:Game/1.0 (snes, cartridge)').sort(), ['Build:Game/1.0 (snes, cartridge)', 'Build:Game/USA (snes)', 'Build:Game/USA Cartridge SNES']);
  assert.equal(index.factsForBuild('Build:Game/1.0 (snes, cartridge)').length, 1);
});

test('search stems words: "import thunk" finds a page about imports and thunks', () => {
  const index = new SearchIndex(':memory:');
  index.indexPage({ title: 'Format:PE/Imports and the IAT', revid: 1, timestamp: 't', user: 'u', content: 'Lead about imports.\n== Thunks ==\nThe IAT holds import thunks that the loader patches.' });
  assert.equal(index.search({ query: 'IAT import thunk' }).total, 1);
  assert.equal(index.search({ query: 'imports thunks' }).total, 1);
  assert.equal(index.search({ query: 'IAT relocation' }).total, 0, 'all terms must still match');
});
