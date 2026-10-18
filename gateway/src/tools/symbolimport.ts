/**
 * import_symbols: a decompilation project's symbol file (splat symbol_addrs.txt, linker
 * "name = 0x...;" lists, nm output, address/name pairs) read from the repository at a pinned
 * commit and added to a build's symbol map, 5,000 names per write.
 */
import { MAX_SYMBOLS_PER_CALL, symbolInputSchema } from '../wiki/pages.ts';
import { parseRepoUrl, resolveRepo, SPDX_EXPRESSION } from './repos.ts';
import { addSymbols, recordSymbolImport } from './write.ts';
import { ToolError, quotaError, requireWriter, type Caller, type Services } from './context.ts';
import { remainingWrites } from '../auth/trust.ts';

export type SymbolFileFormat = 'linker' | 'nm' | 'pairs';
export const SYMBOL_FILE_FORMATS = ['auto', 'linker', 'nm', 'pairs'] as const;

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_IMPORT = 50_000;
const NAME = String.raw`[A-Za-z_.$?@][\w.$@?:<>~]*`;

export interface ParsedSymbol { va: string; name: string; kind: 'function' | 'global' | 'label'; size?: number; type?: string }

// splat and decomp tools write data types as u8/s16/f32...
const SPLAT_TYPES: Record<string, string> = {
  u8: 'uint8_t', s8: 'int8_t', u16: 'uint16_t', s16: 'int16_t', u32: 'uint32_t', s32: 'int32_t',
  u64: 'uint64_t', s64: 'int64_t', f32: 'float', f64: 'double',
};

function hex(n: number): string {
  return `0x${n.toString(16).toUpperCase()}`;
}

function parseLine(line: string, format: SymbolFileFormat): ParsedSymbol | null {
  const text = line.trim();
  if (!text || /^(?:#|\/\/|;)/.test(text)) return null;
  if (format === 'linker') {
    // "func_80012345 = 0x80012345; // type:func size:0x40" (splat), "name = .text:0x802BEE24; // type:function size:0xE4" (decomp-toolkit)
    const m = new RegExp(String.raw`^(${NAME})\s*=\s*(?:\.?[\w.]+:)?(0x[0-9A-Fa-f]+|\d+)\s*;?\s*(?://(.*))?$`).exec(text);
    if (!m) return null;
    const attrs = Object.fromEntries([...(m[3] ?? '').matchAll(/(\w+):(\S+)/g)].map((a) => [a[1].toLowerCase(), a[2]]));
    const t = (attrs.type ?? '').toLowerCase();
    const kind = t === 'func' || t === 'function' ? 'function' : t === 'label' || t === 'jtbl' ? 'label' : t ? 'global' : /^(?:func_|fn_|sub_)/i.test(m[1]) ? 'function' : 'label';
    // decomp-toolkit writes "type:object" for data; its size is the object's.
    const size = attrs.size ? Number(attrs.size) : undefined;
    return { va: hex(Number(m[2])), name: m[1], kind, ...(size && Number.isFinite(size) && size > 0 ? { size } : {}), ...(SPLAT_TYPES[t] ? { type: SPLAT_TYPES[t] } : {}) };
  }
  if (format === 'nm') {
    // "0000000000401136 T main" or, with -S, "0000000000401136 0000000000000020 T main"
    const m = new RegExp(String.raw`^([0-9A-Fa-f]{4,16})\s+(?:([0-9A-Fa-f]{1,16})\s+)?([A-Za-z])\s+(${NAME})$`).exec(text);
    if (!m) return null;
    const t = m[3];
    if (/[UuvVwWNn]/.test(t)) return null; // undefined, weak undefined, debug
    const kind = /[Tt]/.test(t) ? 'function' : /[DdBbRrGgSsCc]/.test(t) ? 'global' : 'label';
    const size = m[2] ? parseInt(m[2], 16) : undefined;
    return { va: hex(parseInt(m[1], 16)), name: m[4], kind, ...(size ? { size } : {}) };
  }
  // "0x80012345 name", "80012345,name", "name 0x80012345"
  const m = new RegExp(String.raw`^(?:(0x[0-9A-Fa-f]+|[0-9A-Fa-f]{6,16})[\s,;=]+(${NAME})|(${NAME})[\s,;=]+(0x[0-9A-Fa-f]+))\s*(?:[,;].*)?$`).exec(text);
  if (!m) return null;
  const address = m[1] ?? m[4];
  return { va: hex(parseInt(address.replace(/^0x/i, ''), 16)), name: m[2] ?? m[3], kind: 'function' };
}

/** Parses a symbol file; format "auto" takes the format that reads the most lines. */
export function parseSymbolFile(text: string, format: (typeof SYMBOL_FILE_FORMATS)[number] = 'auto'): { format: SymbolFileFormat; symbols: ParsedSymbol[]; lines: number; unread: number; unread_examples: string[]; same_address: number } {
  const lines = text.split(/\r?\n/);
  const formats: SymbolFileFormat[] = format === 'auto' ? ['linker', 'nm', 'pairs'] : [format];
  let best: { format: SymbolFileFormat; symbols: ParsedSymbol[] } = { format: formats[0], symbols: [] };
  for (const f of formats) {
    const symbols = lines.map((l) => parseLine(l, f)).filter((x): x is ParsedSymbol => x !== null);
    if (symbols.length > best.symbols.length) best = { format: f, symbols };
  }
  // One name per address (the first), as add_symbols requires.
  const seen = new Set<string>();
  const symbols = best.symbols.filter((x) => (seen.has(x.va) ? false : (seen.add(x.va), true)));
  const meaningful = (l: string) => l.trim() && !/^\s*(?:#|\/\/|;)/.test(l);
  const content = lines.filter(meaningful).length;
  // A few lines the format did not read, so the agent sees why (another syntax, sections, sizes only).
  const examples = lines.filter((l) => meaningful(l) && parseLine(l, best.format) === null).slice(0, 5).map((l) => l.trim().slice(0, 120));
  return { format: best.format, symbols, lines: content, unread: content - best.symbols.length, unread_examples: examples, same_address: best.symbols.length - symbols.length };
}

function rawUrl(repoUrl: string, commit: string, path: string): string {
  const r = parseRepoUrl(repoUrl);
  const p = path.split('/').map(encodeURIComponent).join('/');
  if (r.host === 'github') return `https://raw.githubusercontent.com/${r.owner}/${r.repo}/${commit}/${p}`;
  if (r.host === 'gitlab') return `https://gitlab.com/${r.owner}/${r.repo}/-/raw/${commit}/${p}`;
  return `https://codeberg.org/${r.owner}/${r.repo}/raw/commit/${commit}/${p}`;
}

export async function importSymbols(s: Services, caller: Caller, args: {
  build: string; url: string; path: string; commit?: string; format?: (typeof SYMBOL_FILE_FORMATS)[number];
  confidence?: 'low' | 'medium' | 'high'; license?: string; force?: boolean;
}) {
  const path = args.path.trim().replace(/^\/+/, '');
  if (!path || path.split('/').some((x) => x === '..' || x === '.')) throw new ToolError('BAD_REQUEST', 'path is a file path inside the repository, e.g. "symbol_addrs.txt" or "config/us/symbols.txt".');
  const info = await resolveRepo(args.url, args.commit);
  // Only names, addresses, sizes and data types are imported (never code or comments), so a repository
  // without a license is accepted too; the build page records where they came from and under what license.
  const unlicensed = ['none', 'unknown', 'NOASSERTION'].includes(info.license) || info.license.startsWith('unrecognized');
  if (args.license && !SPDX_EXPRESSION.test(args.license.trim())) throw new ToolError('BAD_REQUEST', 'license must be an SPDX id or expression, e.g. MIT.');
  const license = !unlicensed ? info.license : args.license ? `${args.license.trim()} (declared by the contributor)` : `none stated (${info.license}): names and addresses only`;
  const response = await fetch(rawUrl(info.url, info.commit, path), { headers: { 'User-Agent': 'REWikiGateway/0.1' }, redirect: 'follow' });
  if (response.status === 404) throw new ToolError('NOT_FOUND', `${path} does not exist in ${info.url} at ${info.commit.slice(0, 10)}.`);
  if (!response.ok) throw new ToolError('UPSTREAM_ERROR', `The repository host answered ${response.status} for ${path}.`);
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_FILE_BYTES) throw new ToolError('BAD_REQUEST', `${path} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  const text = await response.text();
  if (text.length > MAX_FILE_BYTES) throw new ToolError('BAD_REQUEST', `${path} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  const parsed = parseSymbolFile(text, args.format ?? 'auto');
  if (!parsed.symbols.length) throw new ToolError('BAD_REQUEST', `No symbols read from ${path} (formats: linker and splat "name = 0x80012345; // type:func size:0x40", decomp-toolkit "name = .text:0x80012345; // type:function size:0x40", nm "00401136 T main", pairs "0x80012345 name").`);
  if (parsed.symbols.length > MAX_IMPORT) throw new ToolError('BAD_REQUEST', `${parsed.symbols.length} symbols: at most ${MAX_IMPORT} per import. Split the file, or import its parts by path.`);

  // Each 5,000 names is a write: refused whole before anything is written when the hour's quota is short.
  const op = requireWriter(s, caller);
  const writes = Math.ceil(parsed.symbols.length / MAX_SYMBOLS_PER_CALL);
  if (!op.dryRun && writes > remainingWrites(s.db, op)) throw quotaError(s, op, writes);
  // Names a symbol map cannot hold (".L_local", quoted operators): skipped and counted, not a failed import.
  const valid = parsed.symbols.filter((x) => symbolInputSchema.shape.name.safeParse(x.name).success);
  const skippedNames = parsed.symbols.length - valid.length;
  parsed.symbols = valid;
  const confidence = args.confidence ?? 'medium';
  const results: Array<Record<string, unknown>> = [];
  for (let i = 0; i < parsed.symbols.length; i += MAX_SYMBOLS_PER_CALL) {
    const chunk = parsed.symbols.slice(i, i + MAX_SYMBOLS_PER_CALL)
      .map((x) => ({ ...x, confidence, source: 'decompilation' as const }));
    const r = await addSymbols(s, caller, { build: args.build, symbols: chunk, force: args.force });
    results.push({ from: i + 1, to: i + chunk.length, added: r.added, updated: r.updated, conflicts: r.conflicts_total, pages: Array.isArray(r.pages) ? r.pages.length : 0 });
  }
  await recordSymbolImport(s, caller, args.build, { repository: info.url, commit: info.commit, path, license, symbols: parsed.symbols.length });
  return {
    build: args.build, repository: { url: info.url, commit: info.commit, path, license },
    license_note: unlicensed && !args.license ? 'The repository states no license: only names, addresses, sizes and data types were imported, never code or comments; the build page records the source.' : undefined,
    format: parsed.format, read: parsed.symbols.length, unread_lines: parsed.unread || undefined, unread_examples: parsed.unread ? parsed.unread_examples : undefined,
    same_address_dropped: parsed.same_address ? `${parsed.same_address} names at an address that already had one (the first is kept; on overlay platforms such as N64, PS1 and PS2 several overlays reuse one address range, so overlay symbols collide)` : undefined, skipped_names: skippedNames || undefined, writes: results.length, results,
    merge_rule: 'Nothing is removed. A symbol already on the map with the same name stays and only gains missing details ("updated"); a different name at the same address replaces it only with a higher confidence (or force), otherwise it is listed as a conflict and the existing name stays.',
    next: `link_repo url="${info.url}" commit="${info.commit}" on the build's software page, so readers find where the names come from.`,
  };
}
