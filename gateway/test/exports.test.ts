import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportSymbols } from '../src/tools/exports.ts';
import type { Services } from '../src/tools/context.ts';

const fact = { title: 'Fact:X/function/P Random', kind: 'function', status: 'claimed', level: 'software', applies_to: 'all', data: JSON.stringify({ name: 'P_Random', signature: '48 89 5C 24 ?? 57' }) };
const s = { index: { resolveRedirect: (t: string) => t, page: () => ({ type: 'software' }), factsForSubject: () => [fact] } } as unknown as Services;

test('signature scan scripts escape bytes the way Python and Ghidra read them', () => {
  const ghidra = exportSymbols(s, { subject: 'Software:X', tool: 'ghidra' }).script;
  // Python source must say "\x" (a backslash and x), never a bare "\x" escape.
  assert.ok(ghidra.includes(String.raw`return "".join("[\\x00-\\xff]" if b == "??" else "\\x" + b for b in pattern.split())`), ghidra);
  assert.ok(ghidra.includes('("P_Random", "48 89 5C 24 ?? 57"'));
  const ida = exportSymbols(s, { subject: 'Software:X', tool: 'ida' }).script;
  assert.ok(ida.includes('pat = pattern.replace("??", "?")'));
});
