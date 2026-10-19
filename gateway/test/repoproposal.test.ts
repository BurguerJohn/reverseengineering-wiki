import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findEnums, findPatterns } from '../src/tools/repoproposal.ts';

test('constant tables from headers: enums with implicit values and #define runs', () => {
  const src = [
    'enum ChunkType : uint16_t {',
    '  RES_NULL_TYPE = 0x0000, // nothing',
    '  RES_STRING_POOL_TYPE = 0x0001,',
    '  RES_TABLE_TYPE,',
    '  RES_XML_TYPE = 3u',
    '};',
    'enum Tiny { A, B };',
    '#define CSMAGIC_REQUIREMENT 0xfade0c00',
    '#define CSMAGIC_REQUIREMENTS 0xfade0c01  /* set */',
    '',
    '#define CSMAGIC_CODEDIRECTORY 0xfade0c02',
    'int unrelated;',
    '#define OTHER_ONE 1',
  ].join('\n');
  const found = findEnums(src, 'include/types.h');
  assert.deepEqual(found.map((e) => [e.name, e.line, e.end, e.values]), [
    ['ChunkType', 1, 6, { '0x0': 'RES_NULL_TYPE', '0x1': 'RES_STRING_POOL_TYPE', '0x2': 'RES_TABLE_TYPE', '0x3': 'RES_XML_TYPE' }],
    ['CSMAGIC', 8, 11, { '0xFADE0C00': 'CSMAGIC_REQUIREMENT', '0xFADE0C01': 'CSMAGIC_REQUIREMENTS', '0xFADE0C02': 'CSMAGIC_CODEDIRECTORY' }],
  ]);
});

test('byte patterns as code writes them', () => {
  const src = [
    'static const char* kPlayerSig = "48 8B 05 ?? ?? ?? ?? 48 85 C0";',
    "const sig = '40 53 48 83 EC 20';",
    String.raw`BYTE patch[] = "\x90\x90\xE9\x00\x10\x00\x00";`,
    'int x = 0x1234; // not a pattern',
    '"48 8B" is too short',
  ].join('\n');
  const found = findPatterns(src, 'src/hooks.cpp');
  assert.deepEqual(found.map((f) => [f.pattern, f.line]), [
    ['48 8B 05 ?? ?? ?? ?? 48 85 C0', 1],
    ['40 53 48 83 EC 20', 2],
    ['90 90 E9 00 10 00 00', 3],
  ]);
  assert.equal(found[0].path, 'src/hooks.cpp');
});

test('struct layout problems: overlaps and fields past the size, unions left alone', async () => {
  const { structLayoutProblems } = await import('../src/wiki/pages.ts');
  assert.deepEqual(structLayoutProblems({ size: '0x10', fields: [
    { offset: '0x0', size: 8, name: 'a' }, { offset: '0x4', size: 4, name: 'b' }, { offset: '0xC', size: 8, name: 'c' },
    { offset: '0x8', size: 4, name: 'u1' }, { offset: '0x8', size: 2, name: 'u2' },
  ] }), ['a (0x0, 8 bytes) overlaps b at 0x4', 'c ends past the struct size 0x10 (a trailing array whose length comes from a count field is written with [] in its name or type, "entries[]", and then may run past the fixed size)']);
  assert.deepEqual(structLayoutProblems({ size: 8, fields: [{ offset: 0, size: 4, name: 'x' }, { offset: 4, size: 4, name: 'y' }] }), []);
});

test('Gitiles repositories: the path before "/+/" is the repository', async () => {
  const { parseRepoUrl } = await import('../src/tools/repos.ts');
  assert.deepEqual(parseRepoUrl('https://android.googlesource.com/platform/system/tools/mkbootimg/+/refs/heads/main/bootimg.py'), {
    host: 'gitiles', owner: 'platform/system/tools', repo: 'mkbootimg', url: 'https://android.googlesource.com/platform/system/tools/mkbootimg',
  });
  assert.throws(() => parseRepoUrl('https://example.com/a/b'), /Supported hosts/);
});
