/**
 * Page formats (design/02-knowledge-model.md): article skeletons, Fact and Build
 * JSON documents, Code pages and field notes.
 */
import { z } from 'zod';
import { codeBlock, escapeText } from './markdown.ts';
import { parseSections, joinSections, renderInfobox, headingKey, type Infobox, type Section } from './wikitext.ts';
import { baseName, NAMESPACES, type SubjectType } from './titles.ts';

// ---- articles ----------------------------------------------------------------

/** Standard sections every article ends up with, and the order of the trailing ones. */
export const LEADING_SECTIONS = ['Identification', 'Scope'];
export const TRAILING_SECTIONS = ['Facts', 'Code & repositories', 'Pitfalls', 'Open questions', 'Evidence & references', 'See also'];
export const TYPE_SECTIONS: Record<SubjectType, string[]> = {
  software: ['Builds', 'Engine & libraries used', 'Formats', 'Architecture overview', 'Modding entry points'],
  library: ['Versions', 'API overview', 'Core data structures', 'Version differences'],
  format: ['Magic & endianness', 'Header', 'Structure', 'Versions', 'Tools'],
  platform: ['Conventions', 'Structures', 'Recovery recipes'],
  technique: ['When to use', 'Steps', 'Variants', 'Known to work on'],
  tool: ['Setup for RE work', 'Scripts'],
};

/** Placeholder older pages carry in empty standard sections. */
export const EMPTY = "''Nothing documented yet.''";

/**
 * Builds a new article: infobox, summary lead and the agent's own sections, nothing
 * else. Standard sections are suggested by read (suggestedSections), never created
 * empty; the infobox links the subject's facts and code.
 */
export function buildArticle(opts: {
  type: SubjectType; title: string; summary: string; infobox: Infobox; bodyWikitext: string;
}): string {
  const lead = `${renderInfobox(NAMESPACES[opts.type].name, opts.infobox)}\n${opts.summary.trim()}`;
  return joinSections(parseSections(`${lead}\n\n${opts.bodyWikitext.trim()}\n`));
}

/** Standard sections of a subject type that a page does not have yet, in canonical order. */
export function suggestedSections(type: SubjectType, sections: Section[]): string[] {
  const have = sections.filter((s) => s.level > 0).map((s) => headingKey(s.heading));
  const covered = (h: string) => have.some((k) => k === h || (Math.min(k.length, h.length) >= 6 && (k.endsWith(h) || h.endsWith(k))));
  return [...LEADING_SECTIONS, ...TYPE_SECTIONS[type], 'Pitfalls', 'Open questions', 'Evidence & references']
    .filter((h) => !covered(headingKey(h)));
}

export function redirectText(target: string): string {
  return `#REDIRECT [[${target}]]\n`;
}

// ---- facts -------------------------------------------------------------------

export const FACT_KINDS = [
  'function', 'global', 'struct', 'vtable', 'enum', 'typedef', 'magic', 'string', 'signature', 'identification', 'behavior',
] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export const STATUSES = ['claimed', 'verified', 'disputed', 'rejected', 'deprecated'] as const;
export type FactStatus = (typeof STATUSES)[number];

const hex = z.string().regex(/^0x[0-9A-Fa-f]+$/, 'hex like 0x1A2B30');
const bytePattern = z.string().regex(/^(?:[0-9A-Fa-f]{2}|\?\?|\?)(?: (?:[0-9A-Fa-f]{2}|\?\?|\?))*$/, 'uppercase hex pairs separated by spaces, ?? for wildcards');

/**
 * Where something is in a build, for binaries where an RVA means nothing: 16-bit and DOS
 * executables (segment:offset), console ROMs (bank:address), fixed-address images (va),
 * or raw positions in a file (file offset). PE builds keep using data.rva.
 */
export const ADDRESS_KINDS = ['va', 'file', 'segmented', 'banked', 'hardware'] as const;
const ADDRESS_FORMAT: Record<(typeof ADDRESS_KINDS)[number], { re: RegExp; example: string }> = {
  va: { re: /^0x[0-9A-Fa-f]+$/, example: '0x80012345' },
  file: { re: /^0x[0-9A-Fa-f]+$/, example: '0x1A2B0' },
  segmented: { re: /^(?:[0-9A-Fa-f]{1,4}|[CDEFGS]S|seg\d{1,4}):[0-9A-Fa-f]{1,4}$/, example: '1000:5AFA, DS:00CC or seg2:00CC' },
  banked: { re: /^[0-9A-Fa-f]{1,4}:[0-9A-Fa-f]{1,8}$/, example: '03:8000' },
  // Fixed for every program of a platform: memory-mapped I/O, interrupt vectors, BIOS entry points.
  hardware: { re: /^0x[0-9A-Fa-f]+$/, example: '0xFF46' },
};

export function checkAddress(address: unknown): string | null {
  if (!address || typeof address !== 'object') return 'data.address must be {kind, value}';
  const { kind, value } = address as { kind?: string; value?: string };
  const format = ADDRESS_FORMAT[kind as keyof typeof ADDRESS_FORMAT];
  if (!format) return `data.address.kind must be one of ${ADDRESS_KINDS.join(', ')} (PE builds use data.rva instead)`;
  if (typeof value !== 'string' || !format.re.test(value.trim())) return `data.address.value for kind "${kind}" looks like ${format.example}`;
  return null;
}

export const evidenceSchema = z.object({
  type: z.enum(['string_xref', 'byte_pattern', 'rtti', 'symbol', 'xref', 'runtime_test', 'documentation', 'debugger', 'comparison', 'source', 'other']),
  detail: z.string().min(3).max(1000),
  // A source citation that can be checked again: repository, commit, file and lines.
  repo: z.string().max(300).optional(),
  commit: z.string().regex(/^[0-9a-fA-F]{7,40}$/, 'a commit hash (7-40 hex digits), not a tag or branch: name the tag in detail').optional(),
  path: z.string().max(300).regex(/^(?![^\n]*[,;]\s+\S*[./]\S)/, 'one file per evidence entry: give each file its own entry with its lines').optional(),
  lines: z.string().regex(/^\d+(?:-\d+)?(?:\s*,\s*\d+(?:-\d+)?)*$/).optional(),
});

export const verificationSchema = z.object({
  operator: z.string(),
  date: z.string(),
  result: z.enum(['confirmed', 'refuted', 'partial']),
  method: z.string(),
  build: z.string().optional(),
  notes: z.string().optional(),
});

export const factInputSchema = z.object({
  kind: z.enum(FACT_KINDS),
  subject: z.string().min(3).describe('Subject page, e.g. "Library:CRIWARE ADX2" or "Software:Earth Defense Force 5"; a topic subpage ("Format:X/Header") stores the fact on the subject page and lists it on the topic'),
  claim: z.string().min(10).max(2000).describe('One-sentence claim in plain English'),
  scope: z.object({
    level: z.enum(['technique', 'platform', 'format', 'library', 'tool', 'software', 'build']),
    applies_to: z.string().min(2).describe('What the claim holds for, e.g. "CRIWARE ADX2 2.x" or a Build: page title'),
    observed_in: z.array(z.string()).default([]).describe('Build: pages or products where it was actually observed'),
  }),
  data: z.record(z.string(), z.unknown()).describe('Kind-specific fields, see design/02-knowledge-model.md#fact-kinds'),
  evidence: z.array(evidenceSchema).min(1),
  confidence: z.enum(['low', 'medium', 'high']),
  related: z.array(z.string()).default([]),
  key: z.string().min(2).max(60).optional().describe('Short title for the fact page, e.g. "RNG seed" (default: the name, value or bytes, else the start of the claim)'),
});
export type FactInput = z.infer<typeof factInputSchema>;

export interface FactDoc extends FactInput {
  schema: 'rewiki.fact/1';
  status: FactStatus;
  created_by: string;
  created_at: string;
  verifications: Array<z.infer<typeof verificationSchema>>;
  /** Corrections (edit_fact): who changed the claim, data or scope, and why. */
  revisions?: Array<{ by: string; date: string; summary: string; changed: string[] }>;
  /** The topic subpage the fact is about ("Format:PE/Rich header"): stored on the subject page, listed on the topic too. */
  topic?: string;
  /** Verifications of an earlier version, kept when a correction reset the status. */
  earlier_verifications?: Array<z.infer<typeof verificationSchema> & { of_revision: number }>;
}

/**
 * The data fields of each fact kind: required ones, alternatives (at least one of), optional
 * ones. Published in tools.json and the add_fact description; fields outside it get a warning.
 */
export const FACT_DATA: Record<FactKind, { required: string[]; one_of?: string[]; optional: string[]; example: Record<string, unknown> }> = {
  function: { required: ['name'], one_of: ['rva', 'address', 'signature'], optional: ['prototype', 'calling_convention', 'size', 'rva_end', 'signature_offset', 'multiple'], example: { name: 'Player::TakeDamage', rva: '0x141230', signature: '48 89 5C 24 ?? 57 48 83 EC 20', prototype: 'void __fastcall(Player*, float)' } },
  global: { required: ['name', 'type'], one_of: ['rva', 'address', 'signature'], optional: ['size', 'signature_offset', 'multiple'], example: { name: 'g_GameState', type: 'GameState*', rva: '0x2F1A80' } },
  struct: { required: ['name', 'fields'], one_of: ['size', 'size_min'], optional: ['size_max', 'alignment', 'abi'], example: { name: 'Weapon', size: '0x88', fields: [{ offset: '0x0', size: 8, type: 'void*', name: 'vtable' }, { offset: '0x8', size: 1, type: 'uint8_t', name: 'kind', notes: '0 = rifle, 1 = shotgun' }, { offset: '0x9', size: 1, type: 'uint8_t', name: 'flags', bits: [{ bit: '0', name: 'is_loaded' }, { bit: '4-5', name: 'palette', notes: 'CGB only' }] }] } },
  vtable: { required: ['class', 'slots'], one_of: ['rva', 'address', 'rtti'], optional: [], example: { class: 'Weapon', rtti: '.?AVWeapon@@', rva: '0x1D3E00', slots: [{ index: 0, name: '~Weapon' }] } },
  enum: { required: ['name', 'values'], optional: ['underlying_type'], example: { name: 'WeaponClass', values: { 0: 'AssaultRifle', 1: 'Shotgun' } } },
  typedef: { required: ['name', 'type'], optional: ['abi'], example: { name: 'FT_Long', type: 'int32_t', abi: 'win64' } },
  magic: { required: ['bytes', 'offset', 'meaning'], optional: ['mask', 'relative_to'], example: { bytes: '52 41 42 00', offset: '0x0', meaning: 'RAB archive header' } },
  string: { required: ['value', 'meaning'], optional: ['encoding', 'rva', 'address'], example: { value: 'EDF5_SAVE', meaning: 'Save file tag', encoding: 'ascii' } },
  signature: { required: ['pattern', 'matches'], optional: ['name', 'offset', 'multiple'], example: { pattern: '48 8B 05 ?? ?? ?? ?? 48 85 C0', matches: 'load of g_GameState' } },
  identification: { required: ['method', 'indicator'], optional: ['table'], example: { method: 'string', indicator: 'CRI Middleware' } },
  behavior: { required: [], optional: ['trigger', 'effect', 'condition', 'rva', 'rva_end', 'address', 'signature', 'function', 'setting'], example: { trigger: 'the Witch is shot by another survivor', effect: 'she switches target after a 5 s timer', function: 'Witch::OnTakeDamage', rva: '0x2A41C0', rva_end: '0x2A4230', setting: { name: 'z_witch_retarget_time', default: '5' } } },
};

/** "0x88", "136" or 136 → 136; anything else (ranges, words) → null. */
export function sizeValue(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
  if (typeof v === 'string' && /^(0x[0-9a-f]+|\d+)$/i.test(v.trim())) return Number(v.trim());
  return null;
}

/** Fields of data that are not standard for the kind: published with a warning, not refused. */
export function unknownFactFields(kind: FactKind, data: Record<string, unknown>): string[] {
  const spec = FACT_DATA[kind];
  // On every kind: test vectors (input → expected output) and public sample files (url + sha256).
  const known = new Set([...spec.required, ...(spec.one_of ?? []), ...spec.optional, 'notes', 'test_vectors', 'samples']);
  return Object.keys(data).filter((k) => !known.has(k));
}

/** Kind-specific required data fields. Returns a list of problems. */
export function checkFactData(kind: FactKind, data: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const need = (field: string) => {
    if (data[field] === undefined || data[field] === '') problems.push(`data.${field} is required for kind "${kind}"`);
  };
  const str = (field: string, schema: z.ZodType) => {
    if (data[field] !== undefined && !schema.safeParse(data[field]).success) {
      problems.push(`data.${field} is malformed (${field === 'signature' || field === 'pattern' || field === 'bytes' ? 'uppercase hex pairs, ?? wildcards' : '0x-prefixed hex'})`);
    }
  };
  str('rva', hex);
  if (data.address !== undefined) {
    const problem = checkAddress(data.address);
    if (problem) problems.push(problem);
  }
  const located = data.rva !== undefined || data.address !== undefined;
  str('signature', bytePattern);
  str('pattern', bytePattern);
  str('bytes', bytePattern);
  switch (kind) {
    case 'function':
      need('name');
      if (!located && data.signature === undefined) problems.push('function facts need data.rva (PE), data.address {kind, value} (other binaries) or data.signature; an address plus a signature is best');
      break;
    case 'global':
      need('name'); need('type');
      if (!located && data.signature === undefined) problems.push('global facts need data.rva, data.address or an access data.signature');
      break;
    case 'struct': {
      need('name'); need('fields');
      if (data.fields !== undefined && !Array.isArray(data.fields)) problems.push('data.fields must be an array of {offset, size, type, name}');
      const ranged = data.size_min !== undefined || data.size_max !== undefined;
      if (data.size === 'variable') {
        // Variable-length records (a count field followed by entries): fine, say how long in notes.
        if (ranged) problems.push('give either data.size "variable" or data.size_min + data.size_max, not both');
      } else if (data.size !== undefined) {
        if (sizeValue(data.size) === null) problems.push('data.size must be a number or hex string (136 or "0x88"), or "variable" for records whose length depends on a count field; if the exact size is unknown, leave size out and give both size_min and size_max');
        if (ranged) problems.push('give either data.size or data.size_min + data.size_max, not both');
      } else if (!ranged) {
        problems.push('data.size is required for kind "struct" (if it is not known exactly: data.size_min and data.size_max)');
      } else {
        // size_min alone: "at least"; size_max alone: "at most".
        const lo = data.size_min === undefined ? 0 : sizeValue(data.size_min);
        const hi = data.size_max === undefined ? Infinity : sizeValue(data.size_max);
        if (lo === null || hi === null) problems.push('data.size_min and data.size_max must be numbers or hex strings (136 or "0x88")');
        else if (lo > hi) problems.push('data.size_min must not exceed data.size_max');
      }
      break;
    }
    case 'vtable':
      need('class'); need('slots');
      if (!located && data.rtti === undefined) problems.push('vtable facts need data.rva, data.address or data.rtti');
      break;
    case 'enum': need('name'); need('values'); break;
    case 'typedef':
      need('name'); need('type');
      if (typeof data.name === 'string' && !/^[A-Za-z_]\w*$/.test(data.name.trim())) problems.push('data.name of a typedef must be a C identifier (FT_Long, j_common_ptr)');
      break;
    case 'magic': need('bytes'); need('offset'); need('meaning'); break;
    case 'string': need('value'); need('meaning'); break;
    case 'signature': need('pattern'); need('matches'); break;
    case 'identification': need('method'); need('indicator'); break;
    case 'behavior': break;
  }
  return problems;
}

/** The data field that names each kind of fact, in a fixed order per kind. */
const KEY_FIELDS: Record<FactKind, string[]> = {
  function: ['name'], global: ['name'], struct: ['name'], enum: ['name'], typedef: ['name'], vtable: ['class'],
  magic: ['bytes'], string: ['value'], signature: ['pattern'], identification: ['indicator'], behavior: [],
};

/**
 * A short label that never stops mid-thought: the first clause, at most `max` characters
 * cut at a word boundary, without dangling brackets or punctuation.
 */
export function shortLabel(text: string, max = 60): string {
  let s = text.replace(/\s+/g, ' ').trim();
  const clause = /^(.{12,}?)(?:[.;:!?](?:\s|$)| — | - |, (?:which|that|so|because|and|but|while|when)\b)/.exec(s);
  if (clause) s = clause[1];
  if (s.length > max) {
    s = s.slice(0, max + 1);
    s = s.slice(0, Math.max(s.lastIndexOf(' '), 12)).trim();
  }
  // Drop an opening bracket whose closing one was cut off, and trailing filler.
  for (const [open, close] of [['(', ')'], ['[', ']'], ['"', '"']]) {
    const opened = s.split(open).length - 1;
    const closed = open === close ? 0 : s.split(close).length - 1;
    if (open === close ? opened % 2 === 1 : opened > closed) s = s.slice(0, s.lastIndexOf(open)).trim();
  }
  return s.replace(/[\s,;:.\-–—(]+$/, '').replace(/\s+(?:a|an|the|of|to|in|on|at|for|with|and|or|by|from|as|is)$/i, '').trim();
}

/** Fact page title: Fact:<subject base>/<kind>/<key>[ @ <build>] */
export function factKey(fact: FactInput): string {
  if (fact.key?.trim()) return fact.key.trim();
  const d = fact.data;
  const pick = KEY_FIELDS[fact.kind].map((f) => d[f]).find((v) => typeof v === 'string' && v.trim()) as string | undefined;
  const abi = typeof d.abi === 'string' && d.abi.trim() && pick ? ` (${d.abi.trim()})` : '';
  return shortLabel(pick ? `${pick}${abi}` : fact.claim);
}

// ---- builds ------------------------------------------------------------------

export const buildInputSchema = z.object({
  software: z.string().min(3).describe('Software: page, e.g. "Software:Earth Defense Force 5"; or the Library: page for a library binary on its own (libpng16-16.dll)'),
  version: z.string().min(1).max(60),
  platform: z.string().min(2).max(40).describe('e.g. windows-x64, ps4, switch'),
  distribution: z.string().min(2).max(40).describe('e.g. steam, epic, gog, retail, disc'),
  files: z.array(z.object({
    name: z.string().min(1).max(200),
    sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional().describe('Strongly preferred'),
    sha1: z.string().regex(/^[0-9a-fA-F]{40}$/).optional().describe('As ROM/disc databases and decompilation projects publish it'),
    md5: z.string().regex(/^[0-9a-fA-F]{32}$/).optional(),
    crc32: z.string().regex(/^(?:0x)?[0-9a-fA-F]{8}$/).optional().describe('Weak alone: with size'),
    size: z.number().int().nonnegative().optional().describe('Bytes; optional when sha256 is given'),
    pe_timestamp: hex.optional(),
    image_base: hex.optional(),
    version_string: z.string().max(120).optional().describe('Version resource or in-binary version text, e.g. "1.0.3 (Jan 17 1992)"'),
  })).min(1),
  release_date: z.string().regex(/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/).optional().describe('YYYY, YYYY-MM or YYYY-MM-DD'),
  notes: z.string().max(2000).optional(),
});
export type BuildInput = z.infer<typeof buildInputSchema>;

export interface BuildDoc extends BuildInput {
  schema: 'rewiki.build/1';
  /** sha256: every file hashed; hash: SHA-1/MD5 for some; partial: size + timestamp, version text or CRC32 only. */
  identity?: 'sha256' | 'hash' | 'partial';
  created_by: string;
  created_at: string;
}

/** "Build:Chrono Trigger/USA (SNES, cartridge)": version first, then platform and distribution. */
export function buildTitle(b: BuildInput): string {
  return `Build:${baseName(b.software)}/${b.version} (${b.platform}, ${b.distribution})`;
}

// ---- symbol maps -------------------------------------------------------------
// Bulk names for one build (thousands of functions from a disassembler project),
// one JSON page per SYMBOL_CHUNK of address space. Facts stay for what deserves
// explanation, evidence and verification; maps hold the long tail.

export const SYMBOL_KINDS = ['function', 'global', 'vtable', 'label'] as const;
export const SYMBOL_SOURCES = ['manual', 'rtti', 'strings', 'debug-info', 'exports', 'signature', 'decompiler', 'decompilation', 'diffing', 'other'] as const;
const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 } as const;
export const MAX_SYMBOLS_PER_CALL = 5000;

export const symbolInputSchema = z.object({
  rva: hex.describe('RVA, e.g. 0x141230 (or give va instead)'),
  /** Set by the server for va entries on builds without an image base: the address is absolute. */
  absolute: z.boolean().optional(),
  overlay: z.string().max(40).optional().describe('Overlay or segment the address belongs to, when several share it'),
  name: z.string().min(1).max(200).regex(/^[A-Za-z_~?@$][\w:~<>,.*&@$?\- ]*$/, 'a symbol name: C/C++ identifier, scopes (Foo::Bar), templates or decorated names'),
  kind: z.enum(SYMBOL_KINDS),
  type: z.string().max(300).optional().describe('C prototype or type, e.g. "int __fastcall(Weapon *this, int id)"'),
  signature: bytePattern.optional(),
  size: z.number().int().positive().max(0x10000000).optional(),
  confidence: z.enum(['low', 'medium', 'high']),
  source: z.enum(SYMBOL_SOURCES),
});
export type SymbolInput = z.infer<typeof symbolInputSchema>;

export interface SymbolEntry extends SymbolInput {
  by: string;
  at: string;
  /** Other operators who submitted the same name independently. */
  seen_by?: string[];
  /** Names this entry replaced (most recent first, at most 3). */
  previous?: Array<{ name: string; by: string; confidence: string }>;
}

export interface SymbolsDoc {
  schema: 'rewiki.symbols/1';
  build: string;
  range: { start: string; end: string };
  symbols: SymbolEntry[];
}

export interface SymbolConflict {
  rva: string;
  existing: { name: string; confidence: string; by: string };
  proposed: { name: string; confidence: string };
}

const hexRva = (n: number) => `0x${n.toString(16).toUpperCase()}`;
const rvaOf = (s: { rva: string }) => parseInt(s.rva, 16);

/**
 * Merges submitted symbols into a map page. Same name: kept, missing details filled in,
 * the operator counted in seen_by. Different name: replaced only when the new confidence
 * is higher (or `force`), otherwise reported as a conflict.
 */
export function mergeSymbols(doc: SymbolsDoc, incoming: SymbolInput[], op: string, at: string, force = false) {
  const byRva = new Map(doc.symbols.map((x) => [rvaOf(x), x]));
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  const conflicts: SymbolConflict[] = [];
  for (const sym of incoming) {
    const rva = rvaOf(sym);
    const entry: SymbolEntry = { ...sym, rva: hexRva(rva), by: op, at };
    const old = byRva.get(rva);
    if (!old) {
      byRva.set(rva, entry);
      added++;
      continue;
    }
    if (old.name === sym.name) {
      const before = JSON.stringify(old);
      old.type ??= sym.type;
      old.signature ??= sym.signature;
      old.size ??= sym.size;
      if (CONFIDENCE_RANK[sym.confidence] > CONFIDENCE_RANK[old.confidence]) old.confidence = sym.confidence;
      if (op !== old.by && !(old.seen_by ?? []).includes(op)) old.seen_by = [...(old.seen_by ?? []), op];
      if (JSON.stringify(old) === before) unchanged++;
      else updated++;
      continue;
    }
    if (force || CONFIDENCE_RANK[sym.confidence] > CONFIDENCE_RANK[old.confidence]) {
      entry.previous = [{ name: old.name, by: old.by, confidence: old.confidence }, ...(old.previous ?? [])].slice(0, 3);
      byRva.set(rva, entry);
      updated++;
    } else {
      conflicts.push({ rva: old.rva, existing: { name: old.name, confidence: old.confidence, by: old.by }, proposed: { name: sym.name, confidence: sym.confidence } });
    }
  }
  doc.symbols = [...byRva.values()].sort((a, b) => rvaOf(a) - rvaOf(b));
  return { added, updated, unchanged, conflicts };
}

export function emptySymbolsDoc(build: string, chunkStart: number, chunkSize: number): SymbolsDoc {
  return { schema: 'rewiki.symbols/1', build, range: { start: hexRva(chunkStart), end: hexRva(chunkStart + chunkSize - 1) }, symbols: [] };
}

// ---- topic subpages ----------------------------------------------------------

/** A section longer than this (in words) should become a topic subpage. */
export const TOPIC_SPLIT_WORDS = 1500;

export function wordCount(text: string): number {
  return (text.match(/[\p{L}\p{N}_]+/gu) ?? []).length;
}

export function topicPage(parent: string, summary: string, bodyWikitext: string): string {
  return `{{Topic of|${parent}}}\n${summary.trim()}\n\n${bodyWikitext.trim()}\n`;
}

// ---- code pages --------------------------------------------------------------

export const CODE_KINDS = [
  'parser', 'writer', 'ghidra-script', 'ida-script', 'binja-script', 'frida-hook', 'x64dbg-script', 'patcher',
  'mod-loader', 'header', 'format-spec', 'test', 'other',
] as const;

export const codeFileSchema = z.object({
  name: z.string().min(1).max(120).regex(/^[\w.+-][\w .+-]*$/, 'plain file name, no paths'),
  lang: z.string().min(1).max(30),
  content: z.string().min(1),
});

export const codeMetaSchema = z.object({
  summary: z.string().min(10).max(500),
  language: z.string().min(1).max(30),
  kind: z.enum(CODE_KINDS),
  subjects: z.array(z.string()).min(1),
  tested_on: z.string().min(3).max(1000),
  usage: z.string().min(10).max(4000),
  dependencies: z.string().max(2000).optional(),
});
export type CodeMeta = z.infer<typeof codeMetaSchema>;

export interface CodeDoc {
  meta: CodeMeta & {
    license: 'MIT-0';
    status: 'claimed' | 'verified' | 'broken' | 'deprecated';
    created_by: string;
    created_at: string;
    verifications: Array<{ operator: string; date: string; result: 'ran' | 'broken' | 'partial'; method: string; build?: string; notes?: string }>;
  };
  files: Array<z.infer<typeof codeFileSchema>>;
}

export const CODE_PAGE_LIMIT = 256 * 1024;

export function renderCodePage(doc: CodeDoc): string {
  const parts = [
    '{{Code page}}',
    `'''${escapeText(doc.meta.summary)}'''`,
    '== Metadata ==',
    codeBlock('json', JSON.stringify(doc.meta, null, 2)),
  ];
  for (const file of doc.files) {
    parts.push(`== File: ${file.name} ==`);
    parts.push(codeBlock(file.lang, file.content, true));
  }
  return `${parts.join('\n\n')}\n`;
}

export function parseCodePage(wikitext: string): CodeDoc | null {
  const meta = /== Metadata ==\s*<syntaxhighlight lang="json">\n([\s\S]*?)\n<\/syntaxhighlight>/.exec(wikitext);
  if (!meta) return null;
  let parsed: CodeDoc['meta'];
  try {
    parsed = JSON.parse(meta[1]);
  } catch {
    return null;
  }
  const files: CodeDoc['files'] = [];
  for (const m of wikitext.matchAll(/== File: (.+?) ==\s*<syntaxhighlight lang="([^"]+)">\n([\s\S]*?)\n<\/syntaxhighlight>/g)) {
    files.push({ name: m[1].trim(), lang: m[2], content: m[3] });
  }
  return { meta: parsed, files };
}

// ---- repositories ------------------------------------------------------------

export interface RepoEntry {
  url: string;
  commit: string;
  license: string;
  description: string;
  tested_on: string;
  checked: string;
}

export function renderRepo(r: RepoEntry): string {
  const clean = (s: string) => s.replace(/\|/g, '{{!}}').replace(/\n/g, ' ').replace(/\}\}/g, '');
  return `{{Repo|url=${clean(r.url)}|commit=${clean(r.commit)}|license=${clean(r.license)}|description=${clean(r.description)}|tested_on=${clean(r.tested_on)}|checked=${clean(r.checked)}}}`;
}

export function parseRepos(wikitext: string): RepoEntry[] {
  const out: RepoEntry[] = [];
  for (const m of wikitext.matchAll(/\{\{Repo\|([^\n]*?)\}\}/g)) {
    const fields: Record<string, string> = {};
    for (const part of m[1].split('|')) {
      const eq = part.indexOf('=');
      if (eq > 0) fields[part.slice(0, eq).trim()] = part.slice(eq + 1).trim().replace(/\{\{!$/, '|');
    }
    out.push({
      url: fields.url ?? '', commit: fields.commit ?? '', license: fields.license ?? '',
      description: fields.description ?? '', tested_on: fields.tested_on ?? '', checked: fields.checked ?? '',
    });
  }
  return out;
}

// ---- notes -------------------------------------------------------------------

export function renderNote(opts: { subject: string; confidence: string; bodyWikitext: string; evidenceWikitext?: string }): string {
  return [
    `{{Note header|subject=${opts.subject}|confidence=${opts.confidence}|status=open}}`,
    opts.bodyWikitext.trim(),
    opts.evidenceWikitext ? `== Evidence ==\n${opts.evidenceWikitext.trim()}` : '',
  ].filter(Boolean).join('\n\n') + '\n';
}

export function parseNoteHeader(wikitext: string): { subject: string; confidence: string; status: string } | null {
  const m = /\{\{Note header\|subject=([^|}]*)\|confidence=([^|}]*)\|status=([^|}]*)\}\}/.exec(wikitext);
  return m ? { subject: m[1], confidence: m[2], status: m[3] } : null;
}
