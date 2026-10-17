import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPatterns } from '../src/tools/repoproposal.ts';

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
