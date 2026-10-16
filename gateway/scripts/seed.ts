/**
 * Seeds ReverseEngineering.wiki with foundational, high-reuse knowledge through the MCP tools.
 *   REWIKI_TOKEN=rewiki_... node scripts/seed.ts   (gateway on GATEWAY_URL)
 * Idempotent enough to re-run: existing pages/facts are reported and skipped.
 */
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const GATEWAY = process.env.GATEWAY_URL ?? 'http://127.0.0.1:8787';
const TOKEN = process.env.REWIKI_TOKEN;
if (!TOKEN) throw new Error('Set REWIKI_TOKEN to an operator token (curator trust recommended).');

const client = new Client({ name: 'rewiki-seed', version: '0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${GATEWAY}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));

async function call(name: string, args: Record<string, unknown>): Promise<void> {
  const result = (await client.callTool({ name, arguments: args })) as any;
  const data = result.structuredContent ?? {};
  const label = String(args.title ?? args.name ?? (args.data as any)?.name ?? args.claim ?? '').slice(0, 70);
  if (result.isError) {
    console.log(`  ${data.error === 'DUPLICATE_SUSPECTED' ? 'exists ' : 'ERROR  '} ${name} ${label}${data.error === 'DUPLICATE_SUSPECTED' ? '' : ` — ${data.message}`}`);
  } else {
    console.log(`  ok      ${name} ${data.title ?? label}`);
  }
}

const PE = 'Format:Portable Executable (PE)';
const RTTI = 'Platform:MSVC x64 RTTI';
const PROXY = 'Technique:DLL proxy loading';
const script = (file: string) => readFileSync(new URL(`./seed/${file}`, import.meta.url), 'utf8');

// ---- Portable Executable ------------------------------------------------------------------

await call('create_page', {
  type: 'format',
  title: 'Portable Executable (PE)',
  summary: 'The executable format of Windows (EXE, DLL, SYS): an MS-DOS header and stub, a COFF file header, an optional header ending in data directories, and a section table. PE32 is the 32-bit variant; PE32+ is the 64-bit one.',
  aliases: ['PE', 'PE32', 'PE32+', 'PE/COFF'],
  infobox: {
    vendor: 'Microsoft',
    magic: '4D 5A at 0x0; 50 45 00 00 at e_lfanew',
    extensions: '.exe, .dll, .sys, .ocx, .cpl, .scr, .efi',
    endianness: 'little',
    platforms: 'Windows, UEFI',
  },
  body: `## Identification

- Bytes \`4D 5A\` ("MZ") at offset 0 (\`e_magic\` of the MS-DOS header).
- The DWORD at offset \`0x3C\` (\`e_lfanew\`) is the file offset of the PE signature \`50 45 00 00\` ("PE\\0\\0").
- The COFF file header follows the signature; the optional header follows the COFF header.

## Header

| Offset | Size | Field | Notes |
| --- | --- | --- | --- |
| 0x00 | 2 | e_magic | \`4D 5A\` |
| 0x3C | 4 | e_lfanew | File offset of the PE signature |
| e_lfanew | 4 | Signature | \`50 45 00 00\` |
| e_lfanew + 0x04 | 2 | Machine | \`0x14C\` i386, \`0x8664\` x64, \`0xAA64\` ARM64 |
| e_lfanew + 0x06 | 2 | NumberOfSections | |
| e_lfanew + 0x08 | 4 | TimeDateStamp | Link time, or a hash for reproducible builds |
| e_lfanew + 0x14 | 2 | SizeOfOptionalHeader | |
| e_lfanew + 0x16 | 2 | Characteristics | \`0x2000\` = DLL |
| e_lfanew + 0x18 | 2 | Optional header Magic | \`0x10B\` PE32, \`0x20B\` PE32+ |

## Structure

The optional header ends with an array of data directories (RVA + size), in this order:

| Index | Directory |
| --- | --- |
| 0 | Export table |
| 1 | Import table |
| 2 | Resource table |
| 3 | Exception table (.pdata on x64) |
| 4 | Certificate table (file offset, not an RVA) |
| 5 | Base relocation table |
| 6 | Debug (CodeView RSDS record with PDB GUID, age and path) |
| 9 | TLS table |
| 10 | Load config |
| 12 | Import address table (IAT) |
| 13 | Delay-load import descriptors |
| 14 | CLR runtime header (.NET assemblies) |

## Versions

- **PE32**: 32-bit; \`ImageBase\` is a DWORD at optional header + 0x1C. Default EXE base \`0x400000\`.
- **PE32+**: 64-bit; \`ImageBase\` is a QWORD at optional header + 0x18. Default EXE base \`0x140000000\`, DLL base \`0x180000000\`.

## Pitfalls

- Addresses inside a PE are mostly **RVAs** (relative to the image base). With ASLR the runtime base differs from \`ImageBase\`, so always record RVAs, never absolute addresses.
- RVA ≠ file offset: convert through the section table (\`VirtualAddress\` ↔ \`PointerToRawData\`).
- \`TimeDateStamp\` is not a date when the binary was linked with \`/Brepro\` (deterministic builds); it is still useful as an identifier.
- Data after the last section (the overlay) is not mapped; installers and some games store payloads there.
- The Debug directory's PDB path can reveal build-machine paths of the vendor; do not copy those into the wiki.`,
});

await call('add_fact', {
  kind: 'magic', subject: PE, claim: 'Every PE file starts with the MS-DOS header signature "MZ".',
  scope: { level: 'platform', applies_to: 'All PE32 and PE32+ files' },
  data: { bytes: '4D 5A', offset: '0x0', meaning: 'IMAGE_DOS_HEADER.e_magic' },
  evidence: [{ type: 'documentation', detail: 'Microsoft PE format specification, MS-DOS stub section' }], confidence: 'high',
});
await call('add_fact', {
  kind: 'magic', subject: PE, claim: 'The PE signature "PE\\0\\0" sits at the file offset stored in the DWORD at 0x3C (e_lfanew).',
  scope: { level: 'platform', applies_to: 'All PE32 and PE32+ files' },
  data: { bytes: '50 45 00 00', offset: 'value of the DWORD at 0x3C', meaning: 'PE signature, followed by the COFF file header' },
  evidence: [{ type: 'documentation', detail: 'Microsoft PE format specification, signature section' }], confidence: 'high',
});
await call('add_fact', {
  kind: 'identification', subject: PE, claim: 'The optional header magic distinguishes 32-bit (PE32, 0x10B) from 64-bit (PE32+, 0x20B) images.',
  scope: { level: 'platform', applies_to: 'All PE files' },
  data: { method: 'Read the WORD right after the 20-byte COFF header', indicator: '0x10B = PE32, 0x20B = PE32+', value_hex: '0x20B' },
  evidence: [{ type: 'documentation', detail: 'Microsoft PE format specification, optional header standard fields' }], confidence: 'high',
});
await call('add_fact', {
  kind: 'struct', subject: PE, claim: 'Layout of the COFF file header (IMAGE_FILE_HEADER), located 4 bytes after the PE signature.',
  scope: { level: 'platform', applies_to: 'All PE files' },
  data: {
    name: 'IMAGE_FILE_HEADER', size: '0x14', fields: [
      { offset: '0x0', size: 2, type: 'uint16_t', name: 'Machine' },
      { offset: '0x2', size: 2, type: 'uint16_t', name: 'NumberOfSections' },
      { offset: '0x4', size: 4, type: 'uint32_t', name: 'TimeDateStamp' },
      { offset: '0x8', size: 4, type: 'uint32_t', name: 'PointerToSymbolTable' },
      { offset: '0xC', size: 4, type: 'uint32_t', name: 'NumberOfSymbols' },
      { offset: '0x10', size: 2, type: 'uint16_t', name: 'SizeOfOptionalHeader' },
      { offset: '0x12', size: 2, type: 'uint16_t', name: 'Characteristics' },
    ],
  },
  evidence: [{ type: 'documentation', detail: 'winnt.h IMAGE_FILE_HEADER; Microsoft PE format specification' }], confidence: 'high',
});

await call('add_code', {
  name: 'PE identity for ReverseEngineering.wiki', summary: 'Prints SHA-256, size, PE timestamp, image base, machine and sections of a PE file: exactly what lookup_binary and register_build need.',
  language: 'python', kind: 'parser', subjects: [PE],
  tested_on: 'php.exe 8.3 x64 and notepad++.exe x64 on Windows 11, Python 3.13',
  usage: 'python pe_info.py <file.exe|file.dll> — prints JSON. Pass sha256 to lookup_binary; if unknown, pass name/sha256/size/pe_timestamp/image_base to register_build.',
  dependencies: 'Python 3.8+ standard library only',
  files: [{ name: 'pe_info.py', content: script('pe_info.py') }],
});

// ---- MSVC x64 RTTI -------------------------------------------------------------------------

await call('create_page', {
  type: 'platform',
  title: 'MSVC x64 RTTI',
  summary: 'Run-time type information emitted by the Microsoft C++ compiler for polymorphic classes on x64. It names every class with a vtable and links vtables to their class hierarchy, which makes it the fastest way to recover class names and vtables in an MSVC binary.',
  aliases: ['MSVC RTTI', 'RTTI (MSVC x64)'],
  infobox: { vendor: 'Microsoft', platforms: 'Windows x64 (MSVC-compiled C++)', languages: 'C++' },
  body: `## Identification

- Decorated type names starting with \`.?AV\` (class) or \`.?AU\` (struct) and ending in \`@@\`, usually in \`.data\` (TypeDescriptor) — e.g. \`.?AVPlayer@@\`.
- Each vtable is preceded by an 8-byte pointer to a CompleteObjectLocator.

## Structures

All cross-references inside RTTI on x64 are 32-bit **image-relative RVAs** (on x86 they were absolute pointers).

- **TypeDescriptor**: \`pVFTable\` (8, points to the vtable of \`type_info\`), \`spare\` (8), then the null-terminated decorated name at \`+0x10\`.
- **RTTICompleteObjectLocator** (COL, 0x18 bytes): \`signature\` = 1 on x64, \`offset\` of this vtable in the complete object, \`cdOffset\`, then RVAs of the TypeDescriptor, the ClassHierarchyDescriptor, and \`pSelf\` (the COL's own RVA).
- **ClassHierarchyDescriptor**: \`signature\`, \`attributes\` (bit 0 = multiple inheritance, bit 1 = virtual inheritance), \`numBaseClasses\`, RVA of the BaseClassDescriptor array.
- **BaseClassDescriptor**: RVA of the base's TypeDescriptor, \`numContainedBases\`, PMD displacement (\`mdisp\`, \`pdisp\`, \`vdisp\`), \`attributes\`, RVA of its ClassHierarchyDescriptor.

## Recovery recipes

1. Find every \`.?AV\`/\`.?AU\` string; its TypeDescriptor starts \`0x10\` bytes earlier.
2. Find COLs: 24-byte records with \`signature == 1\`, \`pTypeDescriptor\` = a TypeDescriptor RVA, and \`pSelf\` equal to the record's own RVA (this makes false positives practically impossible).
3. Find 8-byte values equal to \`ImageBase + COL RVA\`: the vtable starts right after that pointer.
4. Demangle names (\`undname\`, or the disassembler's demangler) and walk the ClassHierarchyDescriptor for base classes.

A class with several vtables (multiple inheritance) has one COL per vtable, distinguished by \`offset\`.

## Pitfalls

- Binaries compiled with \`/GR-\` have no RTTI; vtables still exist but are anonymous.
- Template and lambda types produce very long names; anonymous namespaces appear as \`?A0x<hash>\`.
- Do not assume \`pSelf\` exists on x86: it is an x64 addition (signature 1).`,
});

await call('add_fact', {
  kind: 'struct', subject: RTTI, claim: 'Layout of RTTICompleteObjectLocator on x64 (signature 1, image-relative RVAs).',
  scope: { level: 'platform', applies_to: 'MSVC-compiled x64 binaries with RTTI' },
  data: {
    name: 'RTTICompleteObjectLocator', size: '0x18', fields: [
      { offset: '0x0', size: 4, type: 'uint32_t', name: 'signature', notes: '1 on x64' },
      { offset: '0x4', size: 4, type: 'uint32_t', name: 'offset', notes: 'offset of this vtable in the complete class' },
      { offset: '0x8', size: 4, type: 'uint32_t', name: 'cdOffset' },
      { offset: '0xC', size: 4, type: 'int32_t', name: 'pTypeDescriptor', notes: 'RVA' },
      { offset: '0x10', size: 4, type: 'int32_t', name: 'pClassDescriptor', notes: 'RVA of ClassHierarchyDescriptor' },
      { offset: '0x14', size: 4, type: 'int32_t', name: 'pSelf', notes: 'RVA of this COL' },
    ],
  },
  evidence: [
    { type: 'comparison', detail: 'rtti_scan.py matched 393 classes in notepad++.exe x64 using signature 1 + pSelf == own RVA' },
    { type: 'documentation', detail: 'Matches the layout used by IDA/Ghidra RTTI analyzers' },
  ],
  confidence: 'high',
});
await call('add_fact', {
  kind: 'struct', subject: RTTI, claim: 'Layout of RTTIClassHierarchyDescriptor on x64.',
  scope: { level: 'platform', applies_to: 'MSVC-compiled x64 binaries with RTTI' },
  data: {
    name: 'RTTIClassHierarchyDescriptor', size: '0x10', fields: [
      { offset: '0x0', size: 4, type: 'uint32_t', name: 'signature' },
      { offset: '0x4', size: 4, type: 'uint32_t', name: 'attributes', notes: 'bit 0 multiple inheritance, bit 1 virtual inheritance' },
      { offset: '0x8', size: 4, type: 'uint32_t', name: 'numBaseClasses' },
      { offset: '0xC', size: 4, type: 'int32_t', name: 'pBaseClassArray', notes: 'RVA' },
    ],
  },
  evidence: [{ type: 'documentation', detail: 'Layout used by IDA/Ghidra MSVC RTTI analyzers' }], confidence: 'high',
});
await call('add_fact', {
  kind: 'identification', subject: RTTI, claim: 'MSVC RTTI type names are decorated strings starting with ".?AV" (class) or ".?AU" (struct) and ending with "@@".',
  scope: { level: 'platform', applies_to: 'MSVC-compiled C++ binaries with RTTI (x86 and x64)' },
  data: { method: 'String search in .data/.rdata', indicator: '.?AV' },
  evidence: [{ type: 'string_xref', detail: 'Present in notepad++.exe x64 (393 TypeDescriptors referenced by COLs)' }], confidence: 'high',
});

await call('add_code', {
  name: 'RTTI class and vtable scanner', summary: 'Lists every MSVC x64 RTTI class in a PE32+ file with its TypeDescriptor, CompleteObjectLocator and vtable RVAs.',
  language: 'python', kind: 'parser', subjects: [RTTI, PE],
  tested_on: 'notepad++.exe x64 (393 classes found in under 1 s), Windows 11, Python 3.13',
  usage: 'python rtti_scan.py <x64 exe/dll> — one line per vtable: decorated class name, TD, COL and vtable RVAs. Add the image base for absolute addresses.',
  dependencies: 'Python 3.8+ standard library only',
  files: [{ name: 'rtti_scan.py', content: script('rtti_scan.py') }],
});

// ---- DLL proxy loading ----------------------------------------------------------------------

await call('create_page', {
  type: 'technique',
  title: 'DLL proxy loading',
  summary: 'Loading your own code into a program by placing a DLL with the name of one of its dependencies in the program folder. Windows loads it instead of the system copy; it forwards the real exports and runs the mod. The usual entry point for game mods and loaders.',
  aliases: ['DLL proxying', 'Proxy DLL', 'DLL hijacking (modding)'],
  body: `## When to use

- You need code running inside the target early, without an injector, and the program imports a DLL that is not a KnownDLL.
- Typical targets in games: \`dinput8.dll\`, \`version.dll\`, \`winmm.dll\`, \`d3d9.dll\`, \`d3d11.dll\`, \`dxgi.dll\`, \`winhttp.dll\`.

## Steps

1. List the target's imports (\`dumpbin /imports\`, PE-bear, or any disassembler) and pick a DLL loaded from the search path.
2. Make sure it is not in \`KnownDLLs\` (registry \`HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\KnownDLLs\`): those always load from System32.
3. Build a DLL with the same name and architecture (x64 for x64 programs) that exports every function the target imports from it.
4. Forward each export to the real DLL, loaded from the system directory (\`GetSystemDirectoryW\` + name), or to a renamed copy placed next to it.
5. Start your mod from a new thread created in \`DllMain\`, never with heavy work inside \`DllMain\` itself.
6. Drop it into the program folder (\`<game dir>\`) and launch normally.

## Variants

- **Stub exports** that \`LoadLibrary\` the real DLL and jump through \`GetProcAddress\` (works for any export list).
- **Export forwarders** in a \`.def\` file (\`Name=other_dll.Name\`) to a renamed original, without code.
- **Mod loaders** that proxy one DLL and then load many mods from a subfolder.

## Pitfalls

- DLLs listed in KnownDLLs (e.g. \`kernel32.dll\`, \`user32.dll\`) cannot be proxied this way.
- \`DllMain\` runs under the loader lock: loading libraries, waiting on threads or initializing COM there can deadlock.
- A missing export makes the program fail to start with an entry-point-not-found error: export everything it imports.
- Some launchers verify file integrity or block unknown DLLs; anti-cheat protected online games treat this as cheating. Do not use it there.`,
});

await call('add_code', {
  name: 'dinput8 proxy template', summary: 'Minimal x64 dinput8.dll proxy: forwards DirectInput8Create to the system DLL and starts the mod on its own thread.',
  language: 'cpp', kind: 'mod-loader', subjects: [PROXY],
  tested_on: 'Not yet compiled by the seed author: template written from the documented DirectInput8Create signature. Verify with your toolchain and report with verify.',
  usage: 'cl /LD /EHsc /O2 dinput8_proxy.cpp /link /DEF:dinput8.def /OUT:dinput8.dll — then copy dinput8.dll next to the program. Add the other exports the program imports (check with dumpbin /imports). Put your code in ModMain.',
  dependencies: 'MSVC (Visual Studio Build Tools), Windows SDK',
  files: [
    {
      name: 'dinput8_proxy.cpp', lang: 'cpp', content: `// x64 proxy for dinput8.dll. Build: see usage.
#include <windows.h>
#include <wchar.h>

using DirectInput8Create_t = HRESULT(WINAPI*)(HINSTANCE, DWORD, REFIID, LPVOID*, LPUNKNOWN);

static HMODULE LoadRealDll() {
    static HMODULE real = nullptr;
    if (!real) {
        wchar_t path[MAX_PATH];
        UINT length = GetSystemDirectoryW(path, MAX_PATH);
        if (length == 0 || length > MAX_PATH - 16) return nullptr;
        wcscat_s(path, L"\\\\dinput8.dll");
        real = LoadLibraryW(path);
    }
    return real;
}

extern "C" HRESULT WINAPI Proxy_DirectInput8Create(HINSTANCE instance, DWORD version, REFIID riid, LPVOID* out, LPUNKNOWN outer) {
    HMODULE real = LoadRealDll();
    if (!real) return E_FAIL;
    auto create = reinterpret_cast<DirectInput8Create_t>(GetProcAddress(real, "DirectInput8Create"));
    return create ? create(instance, version, riid, out, outer) : E_FAIL;
}

static DWORD WINAPI ModMain(LPVOID) {
    // Mod initialization runs here, outside the loader lock.
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE self, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(self);
        HANDLE thread = CreateThread(nullptr, 0, ModMain, nullptr, 0, nullptr);
        if (thread) CloseHandle(thread);
    }
    return TRUE;
}
`,
    },
    { name: 'dinput8.def', lang: 'text', content: 'LIBRARY dinput8\nEXPORTS\n    DirectInput8Create=Proxy_DirectInput8Create\n' },
  ],
});

await client.close();
console.log('Seed done.');
