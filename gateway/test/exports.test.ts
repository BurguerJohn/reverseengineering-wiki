import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportSymbols } from '../src/tools/exports.ts';
import type { Services } from '../src/tools/context.ts';

const fact = { title: 'Fact:X/function/P Random', kind: 'function', status: 'claimed', level: 'software', applies_to: 'all', data: JSON.stringify({ name: 'P_Random', signature: '48 89 5C 24 ?? 57' }) };
const s = { index: { resolveRedirect: (t: string) => t, page: () => ({ type: 'software' }), factsForSubject: () => [fact], generalNeighbors: () => [] } } as unknown as Services;

test('signature scan scripts escape bytes the way Python and Ghidra read them', () => {
  const ghidra = exportSymbols(s, { subject: 'Software:X', tool: 'ghidra' }).script;
  // Python source must say "\x" (a backslash and x), never a bare "\x" escape.
  assert.ok(ghidra.includes(String.raw`return "".join("[\\x00-\\xff]" if b == "??" else "\\x" + b for b in pattern.split())`), ghidra);
  assert.ok(ghidra.includes('("P_Random", "48 89 5C 24 ?? 57"'));
  const ida = exportSymbols(s, { subject: 'Software:X', tool: 'ida' }).script;
  assert.ok(ida.includes('pat = pattern.replace("??", "?")'));
});

test('prototypes become declarations that name the function', async () => {
  const { functionDecl } = await import('../src/tools/exports.ts');
  assert.equal(functionDecl('Player::TakeDamage', 'void __fastcall(Player*, float)'), 'void __fastcall Player__TakeDamage(Player*, float)');
  assert.equal(functionDecl('main', 'int __cdecl main(int argc, char **argv)'), 'int __cdecl main(int argc, char **argv)');
  assert.equal(functionDecl('FT_Init_FreeType', 'FT_Error FT_Init_FreeType(FT_Library *alibrary);'), 'FT_Error FT_Init_FreeType(FT_Library *alibrary)');
  assert.equal(functionDecl('f', 'Entity *(int id)'), 'Entity * f(int id)');
  assert.equal(functionDecl('f', 'not a prototype'), null);
});

test('build scripts carry types and stay valid Python', async () => {
  const { spawnSync } = await import('node:child_process');
  const facts = [
    { title: 'Fact:X/function/Tick @ 1', kind: 'function', status: 'claimed', level: 'build', applies_to: 'Build:X/1', data: JSON.stringify({ name: 'Game::Tick', rva: '0x1000', prototype: 'void __thiscall(Game *this, float dt)' }) },
    { title: 'Fact:X/global/g_name @ 1', kind: 'global', status: 'claimed', level: 'build', applies_to: 'Build:X/1', data: JSON.stringify({ name: 'g_name', type: 'char[16]', rva: '0x2000' }) },
    { title: 'Fact:X/global/g_table @ 1', kind: 'global', status: 'claimed', level: 'build', applies_to: 'Build:X/1', data: JSON.stringify({ name: 'g_table', type: 'mystery', size: 64, rva: '0x3000' }) },
  ];
  const b = { index: { resolveRedirect: (t: string) => t, page: () => ({ type: 'build' }), factsForBuild: () => facts, symbolsForBuild: () => [] } } as unknown as Services;
  for (const tool of ['ghidra', 'ida'] as const) {
    const out = exportSymbols(b, { build: 'Build:X/1', tool }) as any;
    assert.equal(out.typed, 3, tool);
    assert.ok(out.script.includes('"void __thiscall Game__Tick(Game *this, float dt)"'), out.script);
    assert.ok(out.script.includes(tool === 'ida' ? '"char g_name[16]"' : '"char[16]"'), out.script);
    const py = spawnSync('python', ['-I', '-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: out.script });
    if (py.error) continue; // no Python here
    assert.equal(py.status, 0, `${tool}: ${py.stderr}`);
  }
});
