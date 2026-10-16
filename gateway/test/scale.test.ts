import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTopicPage, subjectRoot, symbolsPageTitle, typeOfTitle } from '../src/wiki/titles.ts';
import { emptySymbolsDoc, mergeSymbols, wordCount, type SymbolInput } from '../src/wiki/pages.ts';
import { parseSections, sectionBlock } from '../src/wiki/wikitext.ts';

const BUILD = 'Build:Game/1.0 steam windows-x64';
const sym = (rva: string, name: string, confidence: SymbolInput['confidence'] = 'medium', extra: Partial<SymbolInput> = {}): SymbolInput =>
  ({ rva, name, kind: 'function', confidence, source: 'manual', ...extra });

test('titles: symbol map pages and topic subpages', () => {
  assert.equal(symbolsPageTitle(BUILD, 0x141230), `${BUILD}/symbols/00140000`);
  assert.equal(symbolsPageTitle(BUILD, 0x3ffff), `${BUILD}/symbols/00000000`);
  assert.equal(typeOfTitle(`${BUILD}/symbols/00140000`), 'symbols');
  assert.equal(typeOfTitle(BUILD), 'build');
  assert.equal(typeOfTitle(`${BUILD}/symbols/notes`), 'build');
  assert.equal(subjectRoot('Software:Earth Defense Force 5/Weapons'), 'Software:Earth Defense Force 5');
  assert.equal(isTopicPage('Software:Earth Defense Force 5/Weapons'), true);
  assert.equal(isTopicPage('Software:Earth Defense Force 5'), false);
  assert.equal(subjectRoot('Fact:PE/magic/4D 5A'), 'Fact:PE/magic/4D 5A');
});

test('symbol maps: add, confirm, conflict, replace by confidence', () => {
  const doc = emptySymbolsDoc(BUILD, 0x140000, 0x40000);
  let r = mergeSymbols(doc, [sym('0x141230', 'Weapon::Fire'), sym('0x140010', 'Init')], 'alice', 't1');
  assert.deepEqual([r.added, r.updated, r.conflicts.length], [2, 0, 0]);
  assert.deepEqual(doc.symbols.map((x) => x.rva), ['0x140010', '0x141230'], 'sorted by RVA, upper-case hex');

  r = mergeSymbols(doc, [sym('0x141230', 'Weapon::Fire', 'high', { type: 'void __fastcall(Weapon *)' })], 'bob', 't2');
  assert.deepEqual([r.added, r.updated], [0, 1]);
  const fire = doc.symbols[1];
  assert.equal(fire.confidence, 'high');
  assert.equal(fire.type, 'void __fastcall(Weapon *)');
  assert.deepEqual(fire.seen_by, ['bob'], 'an independent operator confirming the same name is counted');
  assert.equal(fire.by, 'alice');

  r = mergeSymbols(doc, [sym('0x141230', 'Weapon::Shoot', 'medium')], 'carol', 't3');
  assert.equal(r.conflicts.length, 1, 'lower confidence never overwrites');
  assert.equal(doc.symbols[1].name, 'Weapon::Fire');

  r = mergeSymbols(doc, [sym('0x140010', 'GameInit', 'high')], 'carol', 't4');
  assert.equal(r.updated, 1, 'higher confidence replaces');
  assert.equal(doc.symbols[0].name, 'GameInit');
  assert.deepEqual(doc.symbols[0].previous, [{ name: 'Init', by: 'alice', confidence: 'medium' }]);

  r = mergeSymbols(doc, [sym('0x141230', 'Weapon::Shoot', 'low')], 'curator', 't5', true);
  assert.equal(doc.symbols[1].name, 'Weapon::Shoot', 'force replaces');

  r = mergeSymbols(doc, [sym('0x141230', 'Weapon::Shoot', 'low')], 'curator', 't6');
  assert.equal(r.unchanged, 1);
});

test('sections: a block includes its subsections; word counts', () => {
  const sections = parseSections('Lead\n== A ==\none two\n=== A1 ===\nthree\n== B ==\nfour\n');
  const a = sections.findIndex((x) => x.heading === 'A');
  assert.deepEqual(sectionBlock(sections, a), [a, a + 2]);
  assert.equal(wordCount('Weapon::Fire at 0x141230, then return'), 6);
});
