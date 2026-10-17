/**
 * Content policy scanner (design/05-content-policy.md, layer 2).
 * Patterns are shared with the MediaWiki hook: custom/policy/patterns.json.
 * Findings report the rule and the line, never the matched value, so errors
 * can't re-leak private data.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_DIR } from '../config.ts';

export type Category = 'privacy' | 'policy' | 'injection' | 'code' | 'links';

export interface Finding {
  rule: string;
  category: Category;
  label: string;
  line: number;
  file?: string;
  /** The words just before the finding (never the matched value). */
  where?: string;
}

export type ScanContext = 'article' | 'note' | 'fact' | 'build' | 'code' | 'summary' | 'repo';

interface Rule {
  id: string;
  category: Category;
  label: string;
  regex: RegExp;
}

interface PatternFile {
  rules: Array<{ id: string; category: Category; label: string; pattern: string; flags: string }>;
  decompiler_markers: {
    pattern: string;
    flags: string;
    snippet_line_limit: number;
    min_markers_per_block: number;
    code_page_marker_ratio: number;
  };
}

const file = JSON.parse(
  readFileSync(resolve(REPO_DIR, 'custom', 'policy', 'patterns.json'), 'utf8'),
) as PatternFile;

const RULES: Rule[] = file.rules.map((r) => ({
  id: r.id,
  category: r.category,
  label: r.label,
  regex: new RegExp(r.pattern, r.flags.includes('u') ? r.flags : `${r.flags}u`),
}));

const MARKERS = file.decompiler_markers;
const markerRegex = () => new RegExp(MARKERS.pattern, `g${MARKERS.flags}`);

export const SNIPPET_LINE_LIMIT = MARKERS.snippet_line_limit;

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function countMarkers(text: string): number {
  return text.match(markerRegex())?.length ?? 0;
}

/** Fenced (```) and <syntaxhighlight>/<pre> blocks inside prose. */
function codeBlocks(text: string): Array<{ body: string; start: number }> {
  const blocks: Array<{ body: string; start: number }> = [];
  const fence = /^(```|~~~)[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm;
  for (const m of text.matchAll(fence)) blocks.push({ body: m[2], start: m.index ?? 0 });
  const tags = /<(syntaxhighlight|source|pre)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const m of text.matchAll(tags)) blocks.push({ body: m[2], start: m.index ?? 0 });
  return blocks;
}

/** "version 2.2.4.3", "patch 1.0.0.12", "section 11.3.6.2": dotted version or section numbers, not IP addresses. */
const VERSION_BEFORE = /(?:\b(?:version|ver|v|patch|build|update|release|revision|rev|exe|game|engine|sdk|driver|firmware|section|sect|sec|clause|chapter|ch|appendix|table|figure|fig|paragraph|para|step|spec|specification|rfc\s*\d+|iso\s*\d+|ecma-?\d+|standard|part)|§)\s*[:=#.]?\s*$/i;

/**
 * "pairs from 1.2.0 to 1.3.0.1", "`1.2.11.1`", ["3.6.3", "3.6.3.1"]: a dotted quad next to two- or three-part version numbers,
 * or in backticks, is a version. Lists of IP addresses do not qualify (their neighbours have four parts).
 */
// A library or tool name right before ("libjpeg-turbo 3.1.4.1", "libpng 1.6.43.1"), or a build string after
// ("3.1.4.1 (build 20240508)"): a version. Network words in the name keep the address rule.
const NAME_BEFORE = /\b([Ll]ib[\w+]*|[A-Za-z][\w+]*(?:-[A-Za-z0-9+]+)+|[A-Za-z]\w*lib|[A-Z][\w]*(?:\.[A-Z][\w]*)+|[\w.-]+\.(?:dll|exe|so|dylib))\s+$/;
const NETWORK_WORD = /ip|addr|host|server|dns|proxy|gateway|router|peer|client|node/i;
const BUILD_AFTER = /^\s*\(?build\b/i;
function namedVersion(text: string, index: number, length: number): boolean {
  const name = NAME_BEFORE.exec(text.slice(Math.max(0, index - 40), index))?.[1];
  // x.y.0.0 is how assembly and file versions are written; as an address it names a network, not a host.
  if (/\.0\.0$/.test(text.slice(index, index + length))) return true;
  return (!!name && !NETWORK_WORD.test(name)) || BUILD_AFTER.test(text.slice(index + length, index + length + 12));
}

// An address is only an address in a network context ("server 93.184.216.34", "connects to …", "http://…", ":443",
// "/24"); a dotted quad anywhere else is a version, a section or a constant (owner's choice: be permissive).
const NETWORK_CONTEXT = /\b(?:ip|ipv4|ips|addr(?:ess(?:es)?)?|hosts?|hostnames?|servers?|connect(?:s|ed|ing|ion|ions)?|dns|resolvers?|proxy|proxies|gateways?|routers?|peers?|clients?|listen(?:s|ing)?|bind|ping|traceroute|subnet|lan|wan|vpn|isp|nat|nameservers?|upstream|endpoint|sockets?|tcp|udp|https?|ftp|ssh|telnet|curl|wget)\b|:\/\/|@/i;
function networkContext(text: string, index: number, length: number): boolean {
  return NETWORK_CONTEXT.test(text.slice(Math.max(0, index - 60), index)) || /^(?::\d{1,5}\b|\/\d{1,2}\b)/.test(text.slice(index + length, index + length + 8));
}

const LIST_SEP = String.raw`\s*(?:,|;|/|-|–|\bto\b|\band\b|\bor\b|\bthrough\b|\bthen\b)\s*`;
const SHORT_VERSION = String.raw`\d{1,3}\.\d{1,3}(?:\.\d{1,3})?`;
const QUOTE = `["'\`]?`;
const VERSION_THEN = new RegExp(String.raw`(?<![\d.])${SHORT_VERSION}${QUOTE}${LIST_SEP}${QUOTE}$`, 'i');
const THEN_VERSION = new RegExp(String.raw`^${QUOTE}${LIST_SEP}${QUOTE}${SHORT_VERSION}(?![\d.])`, 'i');
function amongVersions(text: string, index: number, length: number): boolean {
  if (VERSION_THEN.test(text.slice(Math.max(0, index - 40), index)) || THEN_VERSION.test(text.slice(index + length, index + length + 40))) return true;
  return text[index - 1] === '`' && text[index + length] === '`';
}

/** A few words before a finding, so the writer can find it; the matched value itself is never echoed. */
function contextBefore(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  const before = text.slice(Math.max(start, index - 30), index).trim();
  return before ? `after "${before}"` : 'at the start of the line';
}

export function scanText(text: string, context: ScanContext, fileName?: string): Finding[] {
  const findings: Finding[] = [];
  for (const rule of RULES) {
    // Code pages legitimately contain comments and markup-like syntax.
    if (rule.id === 'html-comment' && context === 'code') continue;
    let m: RegExpExecArray | null;
    if (rule.id === 'public-ipv4') {
      const all = new RegExp(rule.regex.source, `${rule.regex.flags}g`);
      m = null;
      for (let hit = all.exec(text); hit; hit = all.exec(text)) {
        if (networkContext(text, hit.index, hit[0].length) && !VERSION_BEFORE.test(text.slice(Math.max(0, hit.index - 24), hit.index)) && !amongVersions(text, hit.index, hit[0].length) && !namedVersion(text, hit.index, hit[0].length)) {
          m = hit;
          break;
        }
      }
    } else {
      m = rule.regex.exec(text);
    }
    if (m) {
      findings.push({ rule: rule.id, category: rule.category, label: rule.label, line: lineOf(text, m.index), file: fileName, where: contextBefore(text, m.index) });
    }
  }

  if (context === 'code') {
    const lines = text.split('\n');
    const markers = countMarkers(text);
    const found = text.match(markerRegex()) ?? [];
    // v0..v3 and a1 alone are ordinary names (SipHash state, arguments): it takes a decompiler-only token too.
    const strong = found.filter((m) => !/^[va]\d{1,3}$/.test(m));
    if (markers >= 10 && strong.length > 0 && markers / Math.max(lines.length, 1) > MARKERS.code_page_marker_ratio) {
      const counts = [...found.reduce((m, t) => m.set(t.replace(/[0-9a-fA-F]{5,}$|\d+$/, '…'), (m.get(t.replace(/[0-9a-fA-F]{5,}$|\d+$/, '…')) ?? 0) + 1), new Map<string, number>())]
        .sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, n]) => `${t} ×${n}`).join(', ');
      const first = text.search(markerRegex());
      findings.push({
        rule: 'decompiler-output', category: 'code', file: fileName, line: lineOf(text, first),
        label: `looks like decompiler output (${counts}); publish your own implementation with your own names, quote target code only in short snippets`,
      });
    }
    const longest = lines.reduce((max, l) => Math.max(max, l.length), 0);
    const average = text.length / Math.max(lines.length, 1);
    if (longest > 1000 || (lines.length > 3 && average > 200)) {
      findings.push({ rule: 'obfuscated-or-minified', category: 'code', label: 'minified, packed or obfuscated code', line: 1, file: fileName });
    }
  } else {
    for (const block of codeBlocks(text)) {
      const lineCount = block.body.replace(/\n$/, '').split('\n').length;
      if (lineCount > SNIPPET_LINE_LIMIT && countMarkers(block.body) >= MARKERS.min_markers_per_block) {
        findings.push({
          rule: 'decompiled-snippet-too-long', category: 'policy', line: lineOf(text, block.start),
          label: `decompiled target code over the ${SNIPPET_LINE_LIMIT}-line snippet limit`,
        });
      }
    }
  }
  return findings;
}

/** Scans every string in a JSON-like value (facts, builds, metadata). */
export function scanValue(value: unknown, context: ScanContext): Finding[] {
  const strings: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(value);
  return scanText(strings.join('\n'), context);
}

/** Injection-only check, used to label suspicious lines in diffs. */
export function looksLikeInstructions(text: string): boolean {
  return RULES.some((r) => r.category === 'injection' && r.id !== 'html-comment' && r.regex.test(text));
}

export function describe(findings: Finding[]): string {
  return findings
    .map((f) => `${f.label} (${f.file ? `${f.file}, ` : ''}line ${f.line}${f.where ? `, ${f.where}` : ''}; rule ${f.rule})`)
    .join('; ');
}
