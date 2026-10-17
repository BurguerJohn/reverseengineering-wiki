/**
 * Exact-identifier extraction and normalization (design/03-architecture.md#index-design-mvp).
 * Agents mid-analysis search with what they have: constants, strings, magic
 * bytes, symbols, RTTI names, hashes. Those are indexed as normalized tokens.
 */

export type IdKind = 'hex' | 'bytes' | 'sha256' | 'sha1' | 'md5' | 'crc32' | 'symbol' | 'string' | 'rtti' | 'file';

/** File names worth matching exactly: executables, libraries, archives, ROMs, data files. */
const FILE_EXT = 'exe|dll|sys|com|drv|ocx|cpl|scr|efi|so|dylib|elf|bin|dat|pak|pck|cpk|awb|acb|arc|bnk|wem|big|wad|iso|cso|xex|xbe|nro|nso|nsp|xci|rom|nes|sfc|smc|z64|n64|v64|gb|gbc|gba|nds|3ds|cia|psarc|sgo|rmpa|mdb|cas|ini|cfg|sav|ttf';
const FILE_NAME = new RegExp(`\\b[\\w-]{1,64}\\.(?:${FILE_EXT})\\b`, 'gi');

export function isFileName(word: string): boolean {
  return new RegExp(`^[\\w-]{1,64}\\.(?:${FILE_EXT})$`, 'i').test(word);
}

export interface Identifier {
  kind: IdKind;
  token: string;
}

export function normalizeHex(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  if (s.startsWith('0x')) s = s.slice(2);
  else if (s.endsWith('h')) s = s.slice(0, -1);
  if (!/^[0-9a-f]+$/.test(s)) return null;
  s = s.replace(/^0+(?=.)/, '');
  return s;
}

/**
 * A constant as tokens: its magnitude (-26880, "-0x6900" → 6900), and for a value with the top bit set
 * (0xFFFF9700, as a disassembler shows -0x6900) also its negation in 32 or 64 bits. Digit-only strings are decimal.
 */
export function constantTokens(c: string | number): string[] {
  const s = String(c).trim();
  let v: bigint | null = null;
  try {
    if (/^-?\d+$/.test(s)) v = BigInt(s);
    else if (/^-?0x[0-9a-f]+$/i.test(s)) v = s.startsWith('-') ? -BigInt(s.slice(1)) : BigInt(s);
  } catch {
    v = null;
  }
  if (v === null) {
    const h = normalizeHex(s);
    return h ? [h] : [];
  }
  const out = new Set<string>([(v < 0n ? -v : v).toString(16)]);
  for (const bits of [32n, 64n]) {
    if (v >= 1n << (bits - 1n) && v < 1n << bits) out.add(((1n << bits) - v).toString(16));
  }
  return [...out];
}

/** "48 89 5C 24 ?? 57" → "48895c24..57" */
export function normalizeBytes(raw: string): string | null {
  const parts = raw.trim().split(/[\s,]+/).filter(Boolean).map((p) => p.replace(/^0x/i, '').toLowerCase());
  if (!parts.length) return null;
  const out: string[] = [];
  for (const p of parts) {
    if (p === '??' || p === '?') out.push('..');
    else if (/^[0-9a-f]{2}$/.test(p)) out.push(p);
    else if (/^[0-9a-f]{4,}$/.test(p) && p.length % 2 === 0) out.push(...(p.match(/../g) ?? []));
    else return null;
  }
  return out.join('');
}

export function normalizeSymbol(raw: string): string {
  let s = raw.trim();
  const bang = s.lastIndexOf('!');
  if (bang > 0) s = s.slice(bang + 1); // kernel32.dll!CreateFileW → CreateFileW
  return s.toLowerCase();
}

export function normalizeString(raw: string): string {
  return raw.trim().toLowerCase().slice(0, 200);
}

/** ELF symbol versions ("__libc_start_main@GLIBC_2.34", "memcpy@@GLIBC_2.14"): the name and the version node. */
export function versionedParts(token: string): string[] {
  const m = /^([a-z_][\w.$]*?)@@?([a-z_][\w.]*)$/i.exec(token);
  return m && !token.startsWith('?') ? [m[1], m[2]] : [];
}

const add = (out: Map<string, Identifier>, kind: IdKind, token: string | null) => {
  if (!token || token.length < 2) return;
  if (kind === 'hex' && token.length < 3) return; // 0x10, 0xff… are too common to be useful
  out.set(`${kind}:${token}`, { kind, token });
  if (kind === 'symbol') for (const part of versionedParts(token)) if (part.length >= 3) out.set(`symbol:${part}`, { kind, token: part });
};

export function extractFromText(text: string): Identifier[] {
  const out = new Map<string, Identifier>();
  for (const m of text.matchAll(/\b[0-9a-fA-F]{64}\b/g)) add(out, 'sha256', m[0].toLowerCase());
  for (const m of text.matchAll(FILE_NAME)) add(out, 'file', m[0].toLowerCase());
  for (const m of text.matchAll(/\b0x[0-9a-fA-F]{2,16}\b/g)) add(out, 'hex', normalizeHex(m[0]));
  for (const m of text.matchAll(/\b[0-9A-F]{4,16}h\b/g)) add(out, 'hex', normalizeHex(m[0]));
  for (const m of text.matchAll(/\b(?:[0-9A-F]{2}|\?\?)(?: (?:[0-9A-F]{2}|\?\?)){3,}\b/g)) add(out, 'bytes', normalizeBytes(m[0]));
  for (const m of text.matchAll(/\.\?A[VUW][\w@?$<>]+@@/g)) add(out, 'rtti', m[0].toLowerCase());
  for (const m of text.matchAll(/\?[\w?@$]+@@[\w@$?]*/g)) add(out, 'symbol', normalizeSymbol(m[0]));
  for (const m of text.matchAll(/\b_Z[A-Za-z0-9_]{3,}/g)) add(out, 'symbol', normalizeSymbol(m[0]));
  for (const m of text.matchAll(/`([^`\n]{3,120})`/g)) {
    const inner = m[1].trim();
    if (/^[A-Za-z_][\w:~<>$@?.]*(?:\(\))?$/.test(inner)) add(out, 'symbol', normalizeSymbol(inner.replace(/\(\)$/, '')));
    else if (/^0x[0-9a-f]+$/i.test(inner)) add(out, 'hex', normalizeHex(inner));
    else add(out, 'string', normalizeString(inner));
  }
  for (const m of text.matchAll(/"([^"\n]{4,120})"/g)) add(out, 'string', normalizeString(m[1]));
  for (const m of text.matchAll(/(?<![\w./\\-])(?:[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+|[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*){2,})(?![\w/\\-])/g)) {
    if (m[0].length >= 6) add(out, 'symbol', normalizeSymbol(m[0]));
  }
  return [...out.values()];
}

/** Identifiers from a Fact's structured data, which are the most reliable ones. */
export function extractFromFactData(data: Record<string, unknown>): Identifier[] {
  const out = new Map<string, Identifier>();
  const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? `0x${v.toString(16)}` : null);
  for (const key of ['name', 'class', 'type', 'symbol', 'export', 'import']) {
    const v = str(data[key]);
    if (v) add(out, 'symbol', normalizeSymbol(v));
  }
  for (const key of ['rva', 'offset', 'size', 'value_hex']) {
    const v = str(data[key]);
    if (v && /^0x/i.test(v)) add(out, 'hex', normalizeHex(v));
  }
  for (const key of ['signature', 'pattern', 'bytes']) {
    const v = str(data[key]);
    if (!v) continue;
    const bytes = normalizeBytes(v);
    const mask = key === 'bytes' ? normalizeBytes(str(data.mask) ?? '') : null;
    // "00 00 0D 0A" with mask "00 00 FF FF": only the bytes under FF are fixed (versioned magics).
    if (bytes && mask && mask.length === bytes.length) {
      add(out, 'bytes', (bytes.match(/../g) ?? []).map((b, i) => (mask.slice(i * 2, i * 2 + 2) === 'ff' ? b : '..')).join(''));
    } else add(out, 'bytes', bytes);
  }
  for (const key of ['value', 'indicator', 'string']) {
    const v = str(data[key]);
    if (v) add(out, 'string', normalizeString(v));
  }
  if (typeof data.indicator === 'string' && /export|import|symbol|name/i.test(String(data.method ?? ''))) {
    for (const name of data.indicator.split(/[\s,;]+/)) if (/^[A-Za-z_?@][\w:@?$<>~.*]{1,}$/.test(name) && name.replace(/\*/g, '').length >= 2) add(out, 'symbol', normalizeSymbol(name));
  }
  const address = data.address as { value?: unknown } | undefined;
  if (address && typeof address.value === 'string') {
    for (const part of address.value.split(':')) {
      const h = /^0x/i.test(part) ? normalizeHex(part) : /^[0-9a-f]{3,8}$/i.test(part) ? normalizeHex(part) : null;
      if (h) add(out, 'hex', h);
    }
  }
  const rtti = str(data.rtti);
  if (rtti) add(out, 'rtti', rtti.toLowerCase());
  // Enum values ({"-0x7000": "NAME"}, {"NAME": -28672}, [{name, value}]): names as symbols, values by magnitude
  // as identify reads constants. Small values (0, 1, 2) would match everything.
  const values = data.values;
  const pairs: Array<[unknown, unknown]> = Array.isArray(values)
    ? values.map((v) => [v && typeof v === 'object' ? (v as any).name : undefined, v && typeof v === 'object' ? (v as any).value : undefined])
    : values && typeof values === 'object' ? Object.entries(values).map(([k, v]) => (typeof v === 'string' ? [v, k] : [k, v])) : [];
  for (const [name, value] of pairs) {
    if (typeof name === 'string' && /^[A-Za-z_]\w{2,}$/.test(name)) add(out, 'symbol', normalizeSymbol(name));
    if ((typeof value === 'string' && /^-?(?:0x[0-9a-f]+|\d+)$/i.test(value.trim())) || (typeof value === 'number' && Number.isInteger(value))) {
      const magnitude = constantTokens(value as string | number)[0];
      if (magnitude && magnitude.length >= 3) add(out, 'hex', magnitude);
    }
  }
  for (const listKey of ['values', 'fields', 'slots']) {
    const list = data[listKey];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (item && typeof item === 'object' && typeof (item as any).name === 'string') {
        add(out, 'symbol', normalizeSymbol((item as any).name));
      }
    }
  }
  for (const id of extractFromText(JSON.stringify(data))) out.set(`${id.kind}:${id.token}`, id);
  return [...out.values()];
}

export interface Evidence {
  strings?: string[];
  constants?: Array<string | number>;
  magic?: string[];
  imports?: string[];
  exports?: string[];
  symbols?: string[];
  sections?: string[];
  rtti?: string[];
  patterns?: string[];
}

/** Turns identify() inputs into lookup tokens, remembering which input each came from. */
/** Section and segment names every executable has: no evidence of what the file contains. */
const STANDARD_SECTIONS = new Set(['.text', '.data', '.rdata', '.bss', '.idata', '.edata', '.pdata', '.xdata', '.reloc', '.rsrc', '.tls', '.crt', '.gfids', '.00cfg', '.didat', '.rodata', '.init', '.fini', '.plt', '.got', '.got.plt', '.dynamic', '.dynsym', '.dynstr', '.symtab', '.strtab', '.shstrtab', '.eh_frame', '.eh_frame_hdr', '.comment', '.init_array', '.fini_array', '.ctors', '.dtors', '.interp', '.hash', '.gnu.hash', '.note', '.debug', '__text', '__data', '__const', '__bss', '__text__', '__data__']);

/** C runtime and core OS names nearly every program imports or contains: no evidence of what it is. */
export const RUNTIME_NAMES = new Set(`abort abs acos asin atan atan2 atexit atof atoi atol bsearch calloc ceil cos cosh exit exp fabs fclose feof ferror fflush fgetc fgets floor fmod fopen fprintf fputc fputs fread free freopen frexp fscanf fseek ftell fwrite getc getchar getenv gmtime isalnum isalpha isdigit isspace isupper islower isxdigit labs ldexp localtime log log10 longjmp malloc memchr memcmp memcpy memmove memset mktime modf perror pow printf putc putchar puts qsort raise rand realloc remove rename rewind scanf setjmp setlocale setvbuf signal sin sinh snprintf sprintf sqrt srand sscanf strcat strchr strcmp strcoll strcpy strcspn strerror strftime strlen strncat strncmp strncpy strpbrk strrchr strspn strstr strtod strtok strtol strtoul strxfrm system tan tanh time tmpfile tolower toupper ungetc vfprintf vprintf vsnprintf vsprintf wcslen wcscmp wcscpy _errno __errno_location __acrt_iob_func __stdio_common_vfprintf __stdio_common_vsprintf _initterm _initterm_e _cexit _exit _amsg_exit __getmainargs __set_app_type __p___argc __p___argv _onexit __dllonexit __iob_func _lock _unlock __C_specific_handler __cxa_atexit __cxa_finalize __libc_start_main __stack_chk_fail __stack_chk_guard __gmon_start__ _ITM_registerTMCloneTable _ITM_deregisterTMCloneTable GetProcAddress LoadLibraryA LoadLibraryW LoadLibraryExW GetModuleHandleA GetModuleHandleW GetModuleFileNameA GetModuleFileNameW FreeLibrary GetLastError SetLastError GetCurrentProcess GetCurrentProcessId GetCurrentThreadId GetTickCount QueryPerformanceCounter GetSystemTimeAsFileTime Sleep ExitProcess TerminateProcess VirtualAlloc VirtualFree VirtualProtect VirtualQuery HeapAlloc HeapFree HeapReAlloc GetProcessHeap CloseHandle CreateFileA CreateFileW ReadFile WriteFile SetFilePointer GetFileSize InitializeCriticalSection InitializeCriticalSectionAndSpinCount EnterCriticalSection LeaveCriticalSection DeleteCriticalSection TlsAlloc TlsGetValue TlsSetValue TlsFree IsDebuggerPresent UnhandledExceptionFilter SetUnhandledExceptionFilter RtlCaptureContext RtlLookupFunctionEntry RtlVirtualUnwind IsProcessorFeaturePresent GetStartupInfoW MultiByteToWideChar WideCharToMultiByte OutputDebugStringA GetEnvironmentVariableA GetEnvironmentVariableW`.split(/\s+/).map((n) => n.toLowerCase()));

export function isStandardSection(name: string): boolean {
  return STANDARD_SECTIONS.has(name.trim().toLowerCase());
}

export function evidenceTokens(e: Evidence): Array<Identifier & { input: string; weight: number; prefix?: boolean; source?: string }> {
  const out: Array<Identifier & { input: string; weight: number; prefix?: boolean; source?: string }> = [];
  for (const s of e.strings ?? []) {
    out.push({ kind: 'string', token: normalizeString(s), input: s, weight: 2 });
    // An identifier-like string ("GLIBC_2.34", a version node or a name) is also looked up as a symbol.
    if (/^[A-Za-z_][\w.$@]{3,}$/.test(s.trim())) out.push({ kind: 'symbol', token: normalizeSymbol(s), input: s, weight: 1.5 });
  }
  for (const c of e.constants ?? []) {
    for (const token of constantTokens(c)) out.push({ kind: 'hex', token, input: String(c), weight: 1.5 });
  }
  for (const m of e.magic ?? []) {
    const token = normalizeBytes(m);
    if (token) out.push({ kind: 'bytes', token, input: m, weight: token.length > 2 ? 3 : 0.5, prefix: true });
  }
  for (const p of e.patterns ?? []) {
    const token = normalizeBytes(p);
    if (token) out.push({ kind: 'bytes', token, input: p, weight: 3 });
  }
  // A versioned name also matches the bare name ("__libc_start_main@GLIBC_2.34" and "__libc_start_main").
  const symbols = (list: string[] | undefined, weight: number, source: string) => {
    for (const s of list ?? []) {
      const token = normalizeSymbol(s);
      const [name] = versionedParts(token);
      if (RUNTIME_NAMES.has(name ?? token)) continue; // free, memcpy, GetProcAddress: every program has them
      out.push({ kind: 'symbol', token, input: s, weight, source });
      if (name) out.push({ kind: 'symbol', token: name, input: s, weight, source });
    }
  };
  // Section names (".ndata", "UPX0") are written in prose as strings or names; .text and .data say nothing.
  for (const n of e.sections ?? []) {
    if (isStandardSection(n)) continue;
    out.push({ kind: 'string', token: normalizeString(n), input: n, weight: 2.5, source: 'sections' });
    out.push({ kind: 'symbol', token: normalizeSymbol(n), input: n, weight: 2.5, source: 'sections' });
  }
  symbols(e.imports, 1, 'imports');
  symbols(e.exports, 2, 'exports');
  symbols(e.symbols, 2, 'symbols');
  for (const s of e.rtti ?? []) out.push({ kind: 'rtti', token: s.trim().toLowerCase(), input: s, weight: 3 });
  return out.filter((t) => t.token);
}

/** Tokens from a free-text query, for boosting exact identifier hits in search. */
export function queryTokens(query: string): Identifier[] {
  const ids = extractFromText(query);
  const words = query.split(/\s+/).filter(Boolean);
  for (const word of words) {
    if (isFileName(word)) ids.push({ kind: 'file', token: word.toLowerCase() });
    // A plain English word inside a phrase ("Chrono Trigger") is not a symbol lookup; a lone
    // word, or one that looks like code (WeaponTable_Parse, Foo::Bar, getHP), is.
    const codeLike = words.length === 1 || /[_:$@?]|[a-z][A-Z]/.test(word);
    if (codeLike && /^[A-Za-z_][\w:~$@?]{3,}$/.test(word)) ids.push({ kind: 'symbol', token: normalizeSymbol(word) });
    const hex = /^(?:0x[0-9a-f]+|[0-9a-f]+h)$/i.test(word) ? normalizeHex(word) : null;
    if (hex) ids.push({ kind: 'hex', token: hex });
  }
  return ids;
}
