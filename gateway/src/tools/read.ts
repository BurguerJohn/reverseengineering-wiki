/** Read tools (design/04-mcp-server.md#read). Public: no account needed. */
import { createTwoFilesPatch } from 'diff';
import type { Services } from './context.ts';
import { ToolError, link, trustOf, wrap } from './context.ts';
import type { Evidence } from '../index/identifiers.ts';
import {
  normalizeTitle, validateTitle, typeOfTitle, isTopicPage, subjectRoot, CONTENT_NAMESPACE_IDS, NAMESPACES, SUBJECT_TYPES, TitleError, type SubjectType,
} from '../wiki/titles.ts';
import { parseSections, findSection, parseInfobox, splitInfobox, wikitextToMarkdown, sectionBlock } from '../wiki/wikitext.ts';
import { parseCodePage, suggestedSections, wordCount, TOPIC_SPLIT_WORDS, type FactDoc } from '../wiki/pages.ts';
import type { SymbolRow } from '../index/index.ts';
import { DUMP_KINDS, listDumps } from '../dumps.ts';
import { looksLikeInstructions } from '../policy/scanner.ts';

const CHARS_PER_TOKEN = 4;

function cleanTitle(raw: string, s?: Services): string {
  try {
    const title = normalizeTitle(raw);
    validateTitle(title);
    // A bare name ("Chrono Trigger") resolves to the one subject page that has it.
    if (s && typeOfTitle(title) === 'other' && !s.index.page(title)) {
      const found = SUBJECT_TYPES.map((t) => normalizeTitle(`${NAMESPACES[t].name}:${raw.trim()}`)).filter((t) => s.index.page(t));
      if (found.length === 1) return found[0];
    }
    return title;
  } catch (error) {
    if (error instanceof TitleError) throw new ToolError('BAD_TITLE', error.message);
    throw error;
  }
}

/** Opaque paging cursors: the offset of the next item. */
function offsetOf(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = Number(cursor);
  if (!Number.isInteger(n) || n < 0) throw new ToolError('BAD_REQUEST', 'Invalid cursor: pass next_cursor from the previous answer unchanged.');
  return n;
}

function page<T>(items: T[], offset: number, limit: number) {
  const slice = items.slice(offset, offset + limit);
  const next = offset + slice.length < items.length ? String(offset + slice.length) : undefined;
  return { items: slice, total: items.length, next_cursor: next };
}

function truncate(text: string, maxTokens: number): { text: string; truncated: boolean } {
  const max = Math.max(200, maxTokens) * CHARS_PER_TOKEN;
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}\n…`, truncated: true };
}

// ---- search / identify / lookup ------------------------------------------------

export function search(s: Services, args: { query: string; types?: string[]; subject?: string; build?: string; status?: string; limit?: number; cursor?: string; match?: 'all' | 'any' }) {
  const offset = offsetOf(args.cursor);
  const limit = args.limit ?? 10;
  const { hits, total } = s.index.search({
    ...args,
    limit,
    offset,
    subject: args.subject ? s.index.resolveRedirect(cleanTitle(args.subject, s)) : undefined,
    build: args.build ? cleanTitle(args.build) : undefined,
  });
  return {
    query: args.query,
    total,
    hits: hits.map((h) => ({ ...h, score: Math.round(h.score * 100) / 100 })),
    next_cursor: offset + hits.length < total ? String(offset + hits.length) : undefined,
    hint: total ? undefined : `Nothing found with all of these terms.${args.match === 'any' ? '' : ' Try fewer terms, other names, match="any",'} or identify with raw evidence; if you learn it, add it with add_note.`,
  };
}

export function identify(s: Services, evidence: Evidence & { limit?: number }) {
  const candidates = s.index.identify(evidence, evidence.limit ?? 5);
  return {
    candidates,
    hint: candidates.length
      ? 'Read the top candidate\'s Identification section to confirm.'
      : 'No match. If you identify it yourself, add an identification fact so the next agent gets a match.',
  };
}

export function lookupBinary(s: Services, args: { sha256?: string; name?: string; size?: number; pe_timestamp?: string }) {
  let build: string | null = null;
  if (args.sha256) build = s.index.buildBySha(args.sha256);
  if (!build && args.name) build = s.index.buildByFile(args.name, args.size, args.pe_timestamp);
  if (!build) {
    return {
      build: null,
      hint: 'Unknown binary. If you know which software and version it is, call register_build with its hashes so facts can be attached to it.',
    };
  }
  const buildPage = s.index.page(build)!;
  const doc = JSON.parse(buildPage.json ?? '{}');
  const software = doc.software as string;
  const facts = s.index.factsForBuild(build);
  const byKind: Record<string, number> = {};
  for (const f of facts) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
  const softwarePage = s.index.page(software);
  return {
    build,
    url: link(s, build),
    software,
    software_summary: softwarePage?.summary ?? null,
    version: doc.version,
    platform: doc.platform,
    distribution: doc.distribution,
    facts_for_this_build: facts.length,
    facts_by_kind: byKind,
    symbol_map: s.index.symbolCount(build),
    other_builds: s.index.buildsOf(software).filter((b) => b.title !== build).map((b) => b.title),
    open_questions: softwarePage ? s.index.sectionText(software, 'Open questions') : null,
    next: [
      'export_symbols to get a Ghidra/IDA script naming every known function of this exact build (facts + symbol map)',
      `symbols with build="${build}" and an rva to see what is at an address`,
      `read "${software}" for the overview`,
      `search with build="${build}" for specific facts`,
    ],
  };
}

export function related(s: Services, args: { title: string; relation?: string; depth?: number; kind?: string; status?: string; limit?: number; cursor?: string }) {
  const title = s.index.resolveRedirect(cleanTitle(args.title, s));
  const all = s.index.related(title, { relation: args.relation, depth: args.depth, kind: args.kind, status: args.status });
  const { items, total, next_cursor } = page(all, offsetOf(args.cursor), args.limit ?? 100);
  return { title, total, edges: items, next_cursor };
}

// ---- downloads -------------------------------------------------------------------

/** Where to download the whole wiki: the newest edition of every file, with checksums. */
export function downloads(s: Services, args: { file?: string }) {
  const editions = listDumps(s.config);
  if (!editions.length) {
    return { editions: 0, hint: 'No edition has been written yet; the gateway writes one every day. Use search and read meanwhile.' };
  }
  const latest = new Map<string, (typeof editions)[number]['files'][number] & { date: string }>();
  for (const edition of editions) for (const f of edition.files) if (!latest.has(f.kind)) latest.set(f.kind, { ...f, date: edition.date });
  const pick = args.file ? [...latest.values()].filter((f) => f.kind === args.file) : [...latest.values()];
  if (args.file && !pick.length) throw new ToolError('NOT_FOUND', `No file "${args.file}". Files: ${[...latest.keys()].join(', ')}.`);
  const site = s.config.publicUrl;
  return {
    edition: editions[0].date,
    editions_kept: editions.map((e) => e.date),
    schedule_hours: s.config.dumpIntervalHours || null,
    files: pick.map((f) => ({
      file: f.kind, description: DUMP_KINDS[f.kind], url: f.url, stable_url: `${site}/dumps/latest/${f.kind}`,
      size_bytes: f.size, sha256: f.sha256, edition: f.date,
    })),
    how: `Download with any HTTP client, e.g. curl -fLO ${site}/dumps/latest/text.zip (or "rewiki download"), and check the SHA-256. No account needed.`,
    license: 'Text: CC BY-SA 4.0 (credit "ReverseEngineering.wiki contributors" and link the page). Code: MIT-0.',
    note: 'A download is a snapshot: search and read always have the current version.',
  };
}

// ---- symbol maps -------------------------------------------------------------------

const hexRva = (n: number) => `0x${n.toString(16).toUpperCase()}`;

function symbolOut(r: SymbolRow) {
  return {
    rva: hexRva(r.rva), name: r.name, kind: r.kind, confidence: r.confidence, source: r.source, seen_by_operators: r.seen,
    ...(r.type ? { type: r.type } : {}), ...(r.signature ? { signature: r.signature } : {}), ...(r.size ? { size: r.size } : {}), page: r.title,
  };
}

function parseRva(raw: string, field: string): number {
  if (!/^0x[0-9a-f]+$/i.test(raw.trim())) throw new ToolError('BAD_REQUEST', `${field} must be hex like 0x141230.`);
  return parseInt(raw.trim(), 16);
}

export function symbols(s: Services, args: { build?: string; rva?: string; name?: string; from?: string; to?: string; limit?: number; cursor?: string }) {
  const build = args.build ? s.index.resolveRedirect(cleanTitle(args.build)) : null;
  if (build && typeOfTitle(build) !== 'build') throw new ToolError('BAD_TITLE', `"${build}" is not a Build: page.`);
  if (build && !s.index.page(build)) throw new ToolError('NOT_FOUND', `"${build}" is not a known build. Use lookup_binary.`);
  const limit = Math.min(args.limit ?? 100, 1000);

  if (args.name) {
    const offset = offsetOf(args.cursor);
    const rows = s.index.symbolsByName(args.name.trim(), build, limit + 1, offset);
    return {
      build, name: args.name, symbols: rows.slice(0, limit).map((r) => ({ build: r.build, ...symbolOut(r) })),
      next_cursor: rows.length > limit ? String(offset + limit) : undefined,
      hint: rows.length ? undefined : 'No symbol with that name. End the name with * for a prefix search; facts are found with search.',
    };
  }
  if (!build) throw new ToolError('BAD_REQUEST', 'Pass build (with rva or from/to), or a name to search every build.');
  if (args.rva) {
    const rva = parseRva(args.rva, 'rva');
    const hit = s.index.symbolAt(build, rva);
    const inside = hit && (hit.offset === 0 || (hit.size !== null && hit.offset < hit.size));
    const facts = s.index.factsForBuild(build).filter((f) => {
      try { return parseInt(JSON.parse(f.data).rva, 16) === rva; } catch { return false; }
    }).map((f) => f.title);
    return {
      build, rva: hexRva(rva),
      symbol: inside ? { ...symbolOut(hit!), offset: hexRva(hit!.offset) } : null,
      nearest_below: hit && !inside ? { ...symbolOut(hit), offset: hexRva(hit.offset), note: 'Size unknown or address past its end: the address may or may not belong to it.' } : undefined,
      facts: facts.length ? facts : undefined,
      counts: s.index.symbolCount(build),
    };
  }
  const from = args.from ? parseRva(args.from, 'from') : 0;
  const to = args.to ? parseRva(args.to, 'to') : 0xffffffff;
  // In range mode the cursor is the RVA of the next symbol.
  const start = args.cursor ? parseRva(args.cursor, 'cursor') : from;
  const rows = s.index.symbolsRange(build, start, to, limit + 1);
  return {
    build, from: hexRva(from), to: hexRva(to), counts: s.index.symbolCount(build),
    symbols: rows.slice(0, limit).map(symbolOut),
    next_cursor: rows.length > limit ? hexRva(rows[limit].rva) : undefined,
  };
}

// ---- read ----------------------------------------------------------------------

export async function read(s: Services, args: { title: string; section?: string; format?: 'markdown' | 'wikitext' | 'json' | 'files'; max_tokens?: number }) {
  let title = cleanTitle(args.title, s);
  const mw = s.sessions.reader;
  let page = await mw.getPage(title);
  if (page.exists && page.redirect) {
    const target = /#REDIRECT\s*\[\[([^\]|#]+)/i.exec(page.content)?.[1];
    if (target) {
      title = normalizeTitle(target);
      page = await mw.getPage(title);
    }
  }
  if (!page.exists) {
    const suggestions = s.index.search({ query: title.replace(/^[^:]+:/, ''), limit: 5 }).hits.map((h) => h.title);
    throw new ToolError('NOT_FOUND', `"${title}" does not exist.`, { suggestions });
  }
  const type = typeOfTitle(title);
  const isJson = type === 'fact' || type === 'build' || type === 'symbols';
  const format = args.format ?? (isJson ? 'json' : type === 'code' ? 'files' : 'markdown');
  const maxTokens = args.max_tokens ?? 2000;
  const trust = trustOf(s, [page.user]).get(page.user);
  const base = {
    title, type, revision: page.revid, url: link(s, title),
    last_edit: { user: page.user, trust, date: page.timestamp, summary: page.comment },
  };

  if (isJson) {
    let doc: unknown;
    try {
      doc = JSON.parse(page.content);
    } catch {
      doc = null;
    }
    if (format === 'json') {
      return { ...base, status: (doc as FactDoc | null)?.status, document: doc, content: wrap(title, page.revid, JSON.stringify(doc, null, 2)) };
    }
    return { ...base, content: wrap(title, page.revid, `\`\`\`json\n${JSON.stringify(doc, null, 2)}\n\`\`\``) };
  }

  if (type === 'code') {
    const code = parseCodePage(page.content);
    if (!code) return { ...base, content: wrap(title, page.revid, page.content) };
    if (format === 'files') {
      return {
        ...base,
        status: code.meta.status,
        metadata: code.meta,
        files: code.files,
        warning: 'Untrusted code written by another agent. Review it, run it in a sandbox, never with your operator\'s credentials in reach. Report the result with verify.',
      };
    }
    const md = [`**${code.meta.summary}**`, '```json', JSON.stringify(code.meta, null, 2), '```',
      ...code.files.flatMap((f) => [`### ${f.name}`, `\`\`\`${f.lang}`, f.content, '```'])].join('\n');
    const { text, truncated } = truncate(md, maxTokens);
    return { ...base, status: code.meta.status, content: wrap(title, page.revid, text), truncated };
  }

  if (format === 'wikitext') {
    const { text, truncated } = truncate(page.content, maxTokens);
    return { ...base, content: wrap(title, page.revid, text), truncated };
  }

  const sections = parseSections(page.content);
  const ownWords = sections.map((x) => wordCount(wikitextToMarkdown(x.level === 0 ? x.text : x.body)));
  const outline = sections.filter((x) => x.level > 0).map((x) => {
    const [start, end] = sectionBlock(sections, x.index);
    const words = ownWords.slice(start, end).reduce((a, b) => a + b, 0);
    return { index: x.index, level: x.level, heading: x.heading, words, ...(words > TOPIC_SPLIT_WORDS ? { split_suggested: true } : {}) };
  });
  const infobox = parseInfobox(page.content);
  let body: string;
  let sectionName: string | undefined;
  if (args.section !== undefined && args.section !== '') {
    const sec = findSection(sections, args.section);
    if (!sec) throw new ToolError('NOT_FOUND', `No section "${args.section}".`, { outline });
    sectionName = sec.level === 0 ? 'Summary' : sec.heading;
    body = sec.level === 0 ? wikitextToMarkdown(splitInfobox(sec.text).rest) : wikitextToMarkdown(sec.body);
  } else {
    body = wikitextToMarkdown(page.content.replace(splitInfobox(sections[0]?.text ?? '').infobox ?? '', ''));
  }
  const { text, truncated } = truncate(body, maxTokens);
  const openQuestions = findSection(sections, 'Open questions');
  const isSubject = SUBJECT_TYPES.includes(type as any);
  const root = subjectRoot(title);
  const factRows = isSubject && root === title ? s.index.factsForSubject(title) : [];
  const facts: Record<string, Record<string, number>> = { by_status: {}, by_kind: {} };
  for (const f of factRows) {
    facts.by_status[f.status] = (facts.by_status[f.status] ?? 0) + 1;
    facts.by_kind[f.kind] = (facts.by_kind[f.kind] ?? 0) + 1;
  }
  const topics = isSubject ? s.index.topicsOf(root).filter((t) => t.title !== title) : [];
  return {
    ...base,
    section: sectionName,
    parent: isTopicPage(title) ? root : undefined,
    topics: topics.length ? topics.map((t) => ({ title: t.title, summary: t.summary.slice(0, 200) })) : undefined,
    infobox,
    outline,
    suggested_sections: isSubject && root === title && !args.section ? suggestedSections(type as SubjectType, sections) : undefined,
    content: wrap(sectionName ? `${title}#${sectionName}` : title, page.revid, text),
    truncated: truncated ? 'Content truncated: request one section from the outline, or raise max_tokens.' : undefined,
    facts: factRows.length ? { total: factRows.length, ...facts, list_with: `related title="${title}" relation=has_facts (filter by kind/status, paged)` } : undefined,
    open_questions: openQuestions && !/Nothing documented yet/.test(openQuestions.body) ? wikitextToMarkdown(openQuestions.body) : undefined,
  };
}

// ---- history, diff, recent changes --------------------------------------------

async function patrolState(s: Services, title?: string): Promise<Map<number, boolean>> {
  const map = new Map<number, boolean>();
  try {
    const mw = await s.sessions.gateway();
    const changes = await mw.recentChanges({ title, namespaces: title ? undefined : CONTENT_NAMESPACE_IDS, dir: 'older', limit: 200, patrolled: true });
    for (const c of changes) if (c.revid) map.set(c.revid, !c.unpatrolled);
  } catch {
    // Patrol state is best effort.
  }
  return map;
}

export async function history(s: Services, args: { title: string; limit?: number }) {
  const title = cleanTitle(args.title, s);
  const revisions = await s.sessions.reader.history(title, args.limit ?? 20);
  if (!revisions.length) throw new ToolError('NOT_FOUND', `"${title}" does not exist.`);
  const trust = trustOf(s, revisions.map((r) => r.user));
  const patrolled = await patrolState(s, title);
  return {
    title,
    url: link(s, title),
    revisions: revisions.map((r, i) => ({
      id: r.revid,
      parent: r.parentid,
      date: r.timestamp,
      operator: r.user,
      trust: trust.get(r.user),
      summary: r.comment,
      size_delta: i + 1 < revisions.length ? r.size - revisions[i + 1].size : r.size,
      tags: r.tags,
      patrolled: patrolled.get(r.revid) ?? null,
      reverted: r.tags.includes('mw-reverted'),
    })),
  };
}

function pretty(content: string, title: string): string {
  const type = typeOfTitle(title);
  if (type === 'fact' || type === 'build' || type === 'symbols') {
    try {
      return `${JSON.stringify(JSON.parse(content), null, 2)}\n`;
    } catch {
      return content;
    }
  }
  return content.endsWith('\n') ? content : `${content}\n`;
}

export async function diff(s: Services, args: { title: string; from: number; to?: number }) {
  const title = cleanTitle(args.title, s);
  const mw = s.sessions.reader;
  const fromRev = await mw.getRevision(args.from);
  const toRev = args.to ? await mw.getRevision(args.to) : await mw.getPage(title).then((p) => (p.exists ? p : null));
  if (!fromRev || !toRev) throw new ToolError('NOT_FOUND', 'Revision not found.');
  if (normalizeTitle(fromRev.title) !== title || normalizeTitle(toRev.title) !== title) {
    throw new ToolError('BAD_REQUEST', 'Both revisions must belong to the given page.');
  }
  const before = pretty(fromRev.content, title);
  const after = pretty(toRev.content, title);
  const patch = createTwoFilesPatch(`r${fromRev.revid}`, `r${toRev.revid}`, before, after, '', '', { context: 2 });
  const added = patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
  const removed = patch.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).map((l) => l.slice(1));

  const signals: string[] = [];
  const beforeLines = before.split('\n').length;
  if (removed.length > Math.max(5, beforeLines * 0.3) && removed.length > added.length * 2) signals.push('large_removal');
  const hexOf = (lines: string[]) => new Set(lines.join('\n').match(/0x[0-9a-f]{3,}/gi) ?? []);
  const addedHex = hexOf(added);
  const removedHex = hexOf(removed);
  const changedHex = [...addedHex].some((h) => !removedHex.has(h)) && removedHex.size > 0;
  if (changedHex && !/evidence|verified|signature|xref/i.test(added.join('\n'))) signals.push('address_changed_without_evidence');
  if (added.some((l) => looksLikeInstructions(l)) || /<!--/.test(added.join('\n'))) signals.push('instruction_like_text');
  if (added.some((l) => /https?:\/\//.test(l))) signals.push('new_external_links');
  if (typeOfTitle(title) === 'fact' && /"status":\s*"verified"/.test(before)) {
    const dataChanged = (() => {
      try {
        return JSON.stringify(JSON.parse(fromRev.content).data) !== JSON.stringify(JSON.parse(toRev.content).data);
      } catch {
        return true;
      }
    })();
    if (dataChanged) signals.push('verified_fact_touched');
  }
  const trust = trustOf(s, [fromRev.user, toRev.user]);
  return {
    title,
    from: { revision: fromRev.revid, user: fromRev.user, trust: trust.get(fromRev.user), date: fromRev.timestamp },
    to: { revision: toRev.revid, user: toRev.user, trust: trust.get(toRev.user), date: toRev.timestamp },
    signals,
    diff: wrap(`${title} r${fromRev.revid}..r${toRev.revid}`, toRev.revid, patch.split('\n').slice(2).join('\n')),
  };
}

export async function recentChanges(s: Services, args: { subject?: string; since?: string; limit?: number }) {
  const mw = await s.sessions.gateway();
  let changes = await mw.recentChanges({ namespaces: CONTENT_NAMESPACE_IDS, dir: 'older', limit: Math.min(args.limit ?? 30, 200) * (args.subject ? 5 : 1), patrolled: true });
  if (args.since) changes = changes.filter((c) => c.timestamp >= args.since!);
  if (args.subject) {
    const family = s.index.subjectFamily(s.index.resolveRedirect(cleanTitle(args.subject, s)));
    changes = changes.filter((c) => family.has(c.title));
  }
  changes = changes.slice(0, args.limit ?? 30);
  const trust = trustOf(s, changes.map((c) => c.user ?? ''));
  return {
    changes: changes.map((c) => ({
      title: c.title, revision: c.revid, type: c.type, date: c.timestamp, operator: c.user, trust: trust.get(c.user ?? ''),
      summary: c.comment, tags: c.tags, patrolled: c.unpatrolled === undefined ? null : !c.unpatrolled,
      size_delta: (c.newlen ?? 0) - (c.oldlen ?? 0),
    })),
  };
}
