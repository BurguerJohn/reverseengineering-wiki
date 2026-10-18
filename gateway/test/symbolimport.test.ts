import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSymbolFile } from '../src/tools/symbolimport.ts';

test('splat and linker symbol lists', () => {
  const r = parseSymbolFile([
    '// symbols for the US release',
    'func_80012345 = 0x80012345; // type:func size:0x40',
    'D_80100000 = 0x80100000; // type:u32',
    'jtbl_80200000 = 0x80200000; // type:jtbl',
    'gPlayerState = 0x80300000;',
    'func_80012345_dup = 0x80012345;',
  ].join('\n'));
  assert.equal(r.format, 'linker');
  assert.deepEqual(r.symbols[0], { va: '0x80012345', name: 'func_80012345', kind: 'function', size: 0x40 });
  assert.deepEqual(r.symbols[1], { va: '0x80100000', name: 'D_80100000', kind: 'global', type: 'uint32_t' });
  assert.equal(r.symbols[2].kind, 'label');
  assert.equal(r.symbols[3].kind, 'label');
  assert.equal(r.symbols.length, 4, 'one name per address');
});

test('decomp-toolkit symbols.txt', () => {
  const r = parseSymbolFile([
    'decodeSZS__9JKRDecompFPUcPUcUlUl = .text:0x802BEE24; // type:function size:0xE4 scope:global',
    'lbl_803A1234 = .data:0x803A1234; // type:object size:0x10 scope:local data:string',
    '__OSCurrHeap = .sdata:0x803F8C20; // type:object size:0x4 scope:global',
    // CodeWarrior template names keep their commas.
    '__dt__Q24rstl48vector<11CWorldState,Q24rstl17rmemory_allocator>Fv = .text:0x80003E60; // type:function size:0x8C scope:weak',
  ].join('\n'));
  assert.equal(r.unread, 0);
  assert.equal(r.symbols[3].name, '__dt__Q24rstl48vector<11CWorldState,Q24rstl17rmemory_allocator>Fv');
  assert.equal(r.format, 'linker');
  assert.deepEqual(r.symbols[0], { va: '0x802BEE24', name: 'decodeSZS__9JKRDecompFPUcPUcUlUl', kind: 'function', size: 0xE4 });
  assert.equal(r.symbols[1].kind, 'global');
  assert.equal(r.symbols.length, 4);
});

test('nm output and address/name pairs', () => {
  const nm = parseSymbolFile('0000000000401136 0000000000000020 T main\n0000000000404028 B g_count\n                 U puts\n');
  assert.equal(nm.format, 'nm');
  assert.deepEqual(nm.symbols, [{ va: '0x401136', name: 'main', kind: 'function', size: 32 }, { va: '0x404028', name: 'g_count', kind: 'global' }]);
  const pairs = parseSymbolFile('0x80010000,Main_Init\n80010100 Main_Loop\nGame::Tick 0x80010200\n');
  assert.equal(pairs.format, 'pairs');
  assert.deepEqual(pairs.symbols.map((x) => `${x.va} ${x.name}`), ['0x80010000 Main_Init', '0x80010100 Main_Loop', '0x80010200 Game::Tick']);
  assert.equal(parseSymbolFile('nothing here\nat all').symbols.length, 0);
});

test('symbol pages keep shared values once (rewiki.symbols/2) and read back whole', async () => {
  const { serializeSymbolsDoc, parseSymbolsDoc } = await import('../src/wiki/pages.ts');
  const entry = (rva: string, name: string) => ({ rva, name, kind: 'function', absolute: true, confidence: 'high', source: 'decompilation', by: 'A', at: '2026-10-18T00:00:00Z' });
  const doc = { schema: 'rewiki.symbols/1' as const, build: 'Build:X/Y', range: { start: '0x80000000', end: '0x8003FFFF' },
    symbols: [entry('0x80000000', 'a'), entry('0x80000010', 'b'), { ...entry('0x80000020', 'c'), by: 'B', kind: 'global' }] };
  const text = serializeSymbolsDoc(doc as any);
  assert.match(text, /"schema":"rewiki.symbols\/2"/);
  assert.ok(!/"absolute"/.test(text.split('"symbols"')[1].split('\n')[1]), 'shared absolute left out of entries');
  assert.ok(!/"kind"/.test(text.split('"defaults"')[1].split('"symbols"')[0]), 'kind differs: not defaulted');
  const back = parseSymbolsDoc(text);
  assert.deepEqual(back.symbols, doc.symbols);
  assert.ok(text.length < JSON.stringify(doc).length);
});
