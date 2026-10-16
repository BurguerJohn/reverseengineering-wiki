/**
 * Exact-identifier extraction and normalization (design/03-architecture.md#index-design-mvp).
 * Agents mid-analysis search with what they have: constants, strings, magic
 * bytes, symbols, RTTI names, hashes. Those are indexed as normalized tokens.
 */

export type IdKind = 'hex' | 'bytes' | 'sha256' | 'symbol' | 'string' | 'rtti' | 'file';

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

const add = (out: Map<string, Identifier>, kind: IdKind, token: string | null) => {
  if (!token || token.length < 2) return;
  if (kind === 'hex' && token.length < 3) return; // 0x10, 0xff… are too common to be useful
  out.set(`${kind}:${token}`, { kind, token });
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
    if (v) add(out, 'bytes', normalizeBytes(v));
  }
  for (const key of ['value', 'indicator', 'string']) {
    const v = str(data[key]);
    if (v) add(out, 'string', normalizeString(v));
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
  rtti?: string[];
  patterns?: string[];
}

/** Turns identify() inputs into lookup tokens, remembering which input each came from. */
export function evidenceTokens(e: Evidence): Array<Identifier & { input: string; weight: number; prefix?: boolean }> {
  const out: Array<Identifier & { input: string; weight: number; prefix?: boolean }> = [];
  for (const s of e.strings ?? []) out.push({ kind: 'string', token: normalizeString(s), input: s, weight: 2 });
  for (const c of e.constants ?? []) {
    const raw = typeof c === 'number' ? `0x${c.toString(16)}` : /^\d+$/.test(c) ? `0x${BigInt(c).toString(16)}` : c;
    const token = normalizeHex(raw);
    if (token) out.push({ kind: 'hex', token, input: String(c), weight: 1.5 });
  }
  for (const m of e.magic ?? []) {
    const token = normalizeBytes(m);
    if (token) out.push({ kind: 'bytes', token, input: m, weight: 3, prefix: true });
  }
  for (const p of e.patterns ?? []) {
    const token = normalizeBytes(p);
    if (token) out.push({ kind: 'bytes', token, input: p, weight: 3 });
  }
  for (const s of e.imports ?? []) out.push({ kind: 'symbol', token: normalizeSymbol(s), input: s, weight: 1 });
  for (const s of e.exports ?? []) out.push({ kind: 'symbol', token: normalizeSymbol(s), input: s, weight: 2 });
  for (const s of e.symbols ?? []) out.push({ kind: 'symbol', token: normalizeSymbol(s), input: s, weight: 2 });
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
