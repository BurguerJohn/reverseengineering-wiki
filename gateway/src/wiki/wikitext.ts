/**
 * Wikitext helpers: section parsing, infobox read/write, and a wikitext →
 * Markdown converter for the subset the gateway writes. Agents read Markdown.
 */

// ---- protected regions -------------------------------------------------------

const PROTECTED = /<(syntaxhighlight|source|pre|nowiki)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** Replaces code/nowiki regions with placeholders so headings inside them are ignored. */
function protect(text: string): { text: string; restore: (s: string) => string } {
  const saved: string[] = [];
  const masked = text.replace(PROTECTED, (m) => {
    saved.push(m);
    return `\u0001${saved.length - 1}\u0002`;
  });
  return { text: masked, restore: (s) => s.replace(/\u0001(\d+)\u0002/g, (_, i) => saved[Number(i)]) };
}

// ---- sections ----------------------------------------------------------------

export interface Section {
  index: number;
  level: number; // 0 for the lead
  heading: string;
  /** Full text of the section including its heading line. */
  text: string;
  /** Text after the heading line. */
  body: string;
}

const HEADING = /^(={2,6})\s*(.+?)\s*\1\s*$/;

export function parseSections(wikitext: string): Section[] {
  const { text, restore } = protect(wikitext);
  const lines = text.split('\n');
  const sections: Section[] = [];
  let current: { level: number; heading: string; lines: string[] } = { level: 0, heading: '', lines: [] };
  const finish = () => {
    const full = restore(current.lines.join('\n'));
    const body = current.level === 0 ? full : restore(current.lines.slice(1).join('\n'));
    sections.push({ index: sections.length, level: current.level, heading: current.heading, text: full, body });
  };
  for (const line of lines) {
    const m = HEADING.exec(line);
    if (m) {
      finish();
      current = { level: m[1].length, heading: restore(m[2]).trim(), lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  finish();
  return sections;
}

export function joinSections(sections: Section[]): string {
  return sections.map((s) => s.text.replace(/\n+$/, '')).filter((s, i) => i > 0 || s.trim()).join('\n\n') + '\n';
}

/** How headings are compared: entities decoded ("&amp;" = "&"), spaces collapsed, case-insensitive. */
export function headingKey(heading: string): string {
  return decodeEntities(heading).replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Finds a section by heading (case-insensitive), "lead"/"summary" for section 0, or by index. */
export function findSection(sections: Section[], query: string | number): Section | undefined {
  if (typeof query === 'number') return sections[query];
  const q = headingKey(query);
  if (q === '' || q === 'lead' || q === 'summary' || q === '0') return sections[0];
  if (/^\d+$/.test(q)) return sections[Number(q)];
  return sections.find((s) => s.level > 0 && headingKey(s.heading) === q);
}

/** Replaces a section's body, or appends a new level-2 section. */
export function replaceSectionBody(sections: Section[], query: string, newBody: string): Section[] {
  const target = findSection(sections, query);
  const body = newBody.replace(/\n+$/, '');
  if (!target) {
    const heading = query.trim();
    return [...sections, { index: sections.length, level: 2, heading, text: `== ${heading} ==\n${body}`, body }];
  }
  return sections.map((s) => {
    if (s !== target) return s;
    if (s.level === 0) {
      const { infobox } = splitInfobox(s.text);
      const text = infobox ? `${infobox}\n${body}` : body;
      return { ...s, text, body: text };
    }
    const headingLine = s.text.split('\n')[0];
    return { ...s, text: `${headingLine}\n${body}`, body };
  });
}

/** Inserts a new level-2 section before the first section whose heading is in `before`. */
export function insertSection(sections: Section[], heading: string, body: string, before: string[]): Section[] {
  const keys = before.map(headingKey);
  const at = sections.findIndex((s) => s.level > 0 && keys.includes(headingKey(s.heading)));
  const section: Section = { index: 0, level: 2, heading, text: `== ${heading} ==\n${body}`, body };
  const out = [...sections];
  out.splice(at < 0 ? out.length : at, 0, section);
  return out.map((s, index) => ({ ...s, index }));
}

// ---- infobox -----------------------------------------------------------------

export type Infobox = Record<string, string>;

/** Separates a leading {{Infobox ...}} from the rest of the lead. Handles nested {{ }}. */
export function splitInfobox(lead: string): { infobox: string | null; rest: string } {
  const start = lead.search(/\{\{\s*Infobox\b/i);
  if (start < 0) return { infobox: null, rest: lead };
  let depth = 0;
  for (let i = start; i < lead.length - 1; i++) {
    if (lead[i] === '{' && lead[i + 1] === '{') { depth++; i++; } else if (lead[i] === '}' && lead[i + 1] === '}') {
      depth--; i++;
      if (depth === 0) {
        return { infobox: lead.slice(start, i + 1), rest: (lead.slice(0, start) + lead.slice(i + 1)).trim() };
      }
    }
  }
  return { infobox: null, rest: lead };
}

export function parseInfobox(wikitext: string): Infobox {
  const { infobox } = splitInfobox(parseSections(wikitext)[0]?.text ?? '');
  if (!infobox) return {};
  const inner = infobox.replace(/^\{\{\s*Infobox\s*/i, '').replace(/\}\}$/, '');
  const fields: Infobox = {};
  // Split on top-level pipes only (ignore pipes inside [[ ]] and {{ }}).
  let depth = 0;
  let buf = '';
  const parts: string[] = [];
  for (let i = 0; i < inner.length; i++) {
    const two = inner.slice(i, i + 2);
    if (two === '[[' || two === '{{') { depth++; buf += two; i++; continue; }
    if ((two === ']]' || two === '}}') && depth > 0) { depth--; buf += two; i++; continue; }
    if (inner[i] === '|' && depth === 0) { parts.push(buf); buf = ''; continue; }
    buf += inner[i];
  }
  parts.push(buf);
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase().replace(/\s+/g, '_');
    const value = part.slice(eq + 1).trim();
    if (key && value) fields[key] = value;
  }
  return fields;
}

export const INFOBOX_FIELDS = [
  'type', 'developer', 'publisher', 'vendor', 'engine', 'uses', 'platforms', 'languages', 'versions',
  'release', 'magic', 'extensions', 'endianness', 'used_by', 'license', 'website', 'aliases',
] as const;

/** Fields whose values are lists of subject links; they form the subject graph. */
export const RELATION_FIELDS: Record<string, string> = {
  engine: 'uses', uses: 'uses', developer: 'developed_by', publisher: 'published_by', vendor: 'made_by',
  platforms: 'runs_on', used_by: 'used_by', formats: 'uses_format',
};

export function renderInfobox(type: string, fields: Infobox): string {
  const lines = [`{{Infobox`, `| type = ${type}`];
  for (const [key, raw] of Object.entries(fields)) {
    const k = key.toLowerCase().replace(/\s+/g, '_');
    if (k === 'type' || !raw?.toString().trim()) continue;
    if (!/^[a-z_]{1,30}$/.test(k)) continue;
    const value = String(raw).replace(/\|/g, '{{!}}').replace(/\n/g, ' ').trim();
    lines.push(`| ${k} = ${value}`);
  }
  lines.push('}}');
  return lines.join('\n');
}

// ---- links -------------------------------------------------------------------

export function wikiLinks(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\[\[([^[\]|#{}<>]+)(?:#[^[\]|]*)?(?:\|[^[\]]*)?\]\]/g)) out.push(m[1].trim());
  return out;
}

export function redirectTarget(wikitext: string): string | null {
  const m = /^\s*#REDIRECT\s*\[\[([^[\]|#]+)/i.exec(wikitext);
  return m ? m[1].trim() : null;
}

// ---- wikitext → markdown -----------------------------------------------------

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function inlineToMarkdown(s: string): string {
  return decodeEntities(
    s
      .replace(/<nowiki\s*\/>/gi, '')
      .replace(/<code><nowiki>([\s\S]*?)<\/nowiki><\/code>/gi, (_, c) => `\`${c}\``)
      .replace(/<nowiki>([\s\S]*?)<\/nowiki>/gi, '$1')
      .replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`')
      .replace(/'''''(.+?)'''''/g, '***$1***')
      .replace(/'''(.+?)'''/g, '**$1**')
      .replace(/''(.+?)''/g, '*$1*')
      .replace(/<s>([\s\S]*?)<\/s>/gi, '~~$1~~')
      .replace(/<br\s*\/?>/gi, '  \n')
      .replace(/\[(https?:\/\/[^\s\]]+)\s+([^\]]+)\]/g, '[$2]($1)')
      .replace(/\[(https?:\/\/[^\s\]]+)\]/g, '<$1>')
      .replace(/\{\{!\}\}/g, '|'),
  );
}

export function tableToMarkdown(block: string): string {
  const rows: string[][] = [];
  let header = false;
  let current: string[] | null = null;
  for (const line of block.split('\n').slice(1)) {
    if (line.startsWith('|}')) break;
    if (line.startsWith('|-')) { if (current) rows.push(current); current = null; continue; }
    if (line.startsWith('|+')) continue;
    if (line.startsWith('!')) {
      header = rows.length === 0;
      current = [...(current ?? []), ...line.slice(1).split('!!').map((c) => inlineToMarkdown(c.trim()))];
    } else if (line.startsWith('|')) {
      current = [...(current ?? []), ...line.slice(1).split('||').map((c) => inlineToMarkdown(c.trim()))];
    } else if (current?.length) {
      current[current.length - 1] += ` ${inlineToMarkdown(line.trim())}`;
    }
  }
  if (current) rows.push(current);
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const esc = (c: string) => c.replace(/\|/g, '\\|');
  const fmt = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => esc(r[i] ?? '')).join(' | ')} |`;
  const [first, ...rest] = header ? rows : [Array.from({ length: width }, () => ''), ...rows];
  return [fmt(first), `|${' --- |'.repeat(width)}`, ...rest.map(fmt)].join('\n');
}

export function wikitextToMarkdown(wikitext: string): string {
  const blocks: string[] = [];
  let text = wikitext.replace(/\r\n?/g, '\n');
  text = text.replace(/<syntaxhighlight\b([^>]*)>\n?([\s\S]*?)\n?<\/syntaxhighlight>/gi, (_, attrs: string, body: string) => {
    const lang = /lang\s*=\s*"?([\w+#.-]+)/i.exec(attrs)?.[1] ?? '';
    blocks.push(`\`\`\`${lang === 'text' ? '' : lang}\n${body}\n\`\`\``);
    return `\u0001${blocks.length - 1}\u0002`;
  });
  text = text.replace(/<pre>([\s\S]*?)<\/pre>/gi, (_, body: string) => {
    blocks.push(`\`\`\`\n${decodeEntities(body)}\n\`\`\``);
    return `\u0001${blocks.length - 1}\u0002`;
  });
  text = text.replace(/^\{\|[\s\S]*?^\|\}/gm, (table) => {
    blocks.push(tableToMarkdown(table));
    return `\u0001${blocks.length - 1}\u0002`;
  });
  // Navigation templates between a subject and its topic subpages.
  text = text.replace(/\{\{Main\|([^}|]+)(?:\|[^}]*)?\}\}/g, "''Main article: [[$1]]''");
  text = text.replace(/\{\{Topic of\|([^}|]+)\}\}/g, "''Topic page of [[$1]].''");
  text = text.replace(/<blockquote>\n?([\s\S]*?)\n?<\/blockquote>/gi, (_, body: string) =>
    body.split('\n').map((l) => `> ${l}`).join('\n'));

  const lines = text.split('\n').map((line) => {
    const heading = HEADING.exec(line);
    // "== X ==" is a top-level section, which agents write as "## X": the same level both ways.
    if (heading) return `${'#'.repeat(heading[1].length)} ${inlineToMarkdown(heading[2])}`;
    if (line === '----') return '---';
    const list = /^([*#:]+)\s?(.*)$/.exec(line);
    if (list && !line.startsWith('#REDIRECT')) {
      const depth = list[1].length - 1;
      const marker = list[1].endsWith('#') ? '1.' : list[1].endsWith(':') ? '' : '-';
      return `${'  '.repeat(depth)}${marker ? `${marker} ` : '  '}${inlineToMarkdown(list[2])}`;
    }
    return inlineToMarkdown(line);
  });
  return lines.join('\n').replace(/\u0001(\d+)\u0002/g, (_, i) => blocks[Number(i)]).replace(/\n{3,}/g, '\n\n').trim();
}

/** [start, end) of a section together with its subsections (sections are a flat list). */
export function sectionBlock(sections: Section[], index: number): [number, number] {
  const level = sections[index].level;
  let end = index + 1;
  while (level > 0 && end < sections.length && sections[end].level > level) end++;
  return [index, level === 0 ? index + 1 : end];
}
