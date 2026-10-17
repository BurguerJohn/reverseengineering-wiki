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

test('wasm-names writes a valid name section', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const facts = [{ title: 'Fact:W/function/run @ 1', kind: 'function', status: 'claimed', level: 'build', applies_to: 'Build:W/1', data: JSON.stringify({ name: 'run', address: { kind: 'wasm', value: 'func:1' } }) }];
  const map = [{ rva: 2, name: 'Game::Tick', kind: 'function', confidence: 'medium', title: 'Build:W/1/symbols/0', overlay: 'wasm:func', absolute: 0 }];
  const b = { index: { resolveRedirect: (t: string) => t, page: () => ({ type: 'build' }), factsForBuild: () => facts, symbolsForBuild: () => map } } as unknown as Services;
  const out = exportSymbols(b, { build: 'Build:W/1', tool: 'wasm-names' }) as any;
  assert.equal(out.wasm_functions, 2);
  assert.equal(out.symbols, 0, 'function indexes are not addresses');
  // A module: one imported function (index 0) and two defined ones (1, 2).
  const leb = (n: number) => { const o: number[] = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
  const str = (t: string) => [...leb(t.length), ...Buffer.from(t)];
  const sec = (id: number, body: number[]) => [id, ...leb(body.length), ...body];
  const body = [0, 0x0b];
  const wasm = Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...sec(1, [1, 0x60, 0, 0]), ...sec(2, [1, ...str('env'), ...str('log'), 0, 0]),
    ...sec(3, [2, 0, 0]), ...sec(10, [2, body.length, ...body, body.length, ...body])]);
  const dir = mkdtempSync(join(tmpdir(), 'rewiki-wasm-'));
  writeFileSync(join(dir, 'wasm_names.py'), out.script);
  writeFileSync(join(dir, 'in.wasm'), wasm);
  const py = spawnSync('python', ['-I', join(dir, 'wasm_names.py'), join(dir, 'in.wasm'), join(dir, 'out.wasm')]);
  if (py.error) return; // no Python here
  assert.equal(py.status, 0, String(py.stderr));
  const WebAssembly = (globalThis as any).WebAssembly;
  const named = readFileSync(join(dir, 'out.wasm'));
  assert.ok(WebAssembly.validate(named));
  const section = Buffer.from(WebAssembly.Module.customSections(new WebAssembly.Module(named), 'name')[0]).toString('latin1');
  assert.ok(section.includes('run') && section.includes('Game::Tick'), section);
});
