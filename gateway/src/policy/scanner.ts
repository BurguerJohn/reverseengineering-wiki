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

export function scanText(text: string, context: ScanContext, fileName?: string): Finding[] {
  const findings: Finding[] = [];
  for (const rule of RULES) {
    // Code pages legitimately contain comments and markup-like syntax.
    if (rule.id === 'html-comment' && context === 'code') continue;
    const m = rule.regex.exec(text);
    if (m) {
      findings.push({ rule: rule.id, category: rule.category, label: rule.label, line: lineOf(text, m.index), file: fileName });
    }
  }

  if (context === 'code') {
    const lines = text.split('\n');
    const markers = countMarkers(text);
    if (markers >= 10 && markers / Math.max(lines.length, 1) > MARKERS.code_page_marker_ratio) {
      findings.push({
        rule: 'decompiler-output', category: 'code', file: fileName, line: 1,
        label: 'looks like decompiler output; publish your own implementation, quote target code only in short snippets',
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
    .map((f) => `${f.label} (${f.file ? `${f.file}, ` : ''}line ${f.line}; rule ${f.rule})`)
    .join('; ');
}
