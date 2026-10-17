/**
 * Search index (design/03-architecture.md#index-design-mvp). Rebuildable from
 * MediaWiki at any time; holds no source of truth.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isTopicPage, subjectRoot, typeOfTitle, type PageType } from '../wiki/titles.ts';
import {
  parseSections, splitInfobox, parseInfobox, wikiLinks, redirectTarget, wikitextToMarkdown, RELATION_FIELDS,
} from '../wiki/wikitext.ts';
import { parseCodePage, parseNoteHeader, type FactDoc, type BuildDoc, type SymbolsDoc } from '../wiki/pages.ts';
import {
  extractFromText, extractFromFactData, evidenceTokens, normalizeBytes, queryTokens, type Evidence, type Identifier,
} from './identifiers.ts';

const SCHEMA = `
create table if not exists pages (
  title text primary key,
  type text not null,
  revision integer not null,
  touched text not null,
  author text,
  summary text not null default '',
  status text,
  subject text,
  redirect_to text,
  json text
);
create virtual table if not exists docs using fts5(
  title, section, body, type unindexed,
  tokenize = 'porter unicode61 remove_diacritics 2 tokenchars ''_'''
);
create table if not exists identifiers (
  kind text not null,
  token text not null,
  title text not null,
  section text not null default ''
);
create index if not exists identifiers_lookup on identifiers(kind, token);
create index if not exists identifiers_title on identifiers(title);
create table if not exists edges (
  src text not null,
  rel text not null,
  dst text not null
);
create index if not exists edges_src on edges(src);
create index if not exists edges_dst on edges(dst);
create table if not exists facts (
  title text primary key,
  subject text not null,
  kind text not null,
  status text not null,
  level text not null,
  applies_to text not null,
  observed_in text not null,
  data text not null
);
create index if not exists facts_subject on facts(subject);
create table if not exists builds (
  title text primary key,
  software text not null,
  version text not null,
  platform text not null,
  distribution text not null
);
create table if not exists build_files (
  sha256 text not null,
  title text not null,
  name text not null,
  size integer not null,
  pe_timestamp text
);
create index if not exists build_files_sha on build_files(sha256);
create table if not exists symbols (
  title text not null,
  build text not null,
  rva integer not null,
  name text not null,
  kind text not null,
  confidence text not null,
  source text not null,
  type text,
  signature text,
  size integer,
  seen integer not null default 1,
  absolute integer not null default 0,
  overlay text
);
create index if not exists symbols_build_rva on symbols(build, rva);
create index if not exists symbols_name on symbols(name);
create index if not exists symbols_lname on symbols(lower(name));
create index if not exists symbols_title on symbols(title);
create table if not exists moves (
  old text primary key,
  new text not null
);
create table if not exists state (key text primary key, value text not null);
`;

export interface IndexablePage {
  title: string;
  revid: number;
  timestamp: string;
  user: string;
  content: string;
}

/** What symbol names may look like: C/C++ identifiers, scopes, templates, decorated names. */
export const SYMBOL_NAME = /^[A-Za-z_~?@$][\w:~<>,.*&@$?\- ]*$/;

export interface SymbolRow {
  title: string;
  build: string;
  rva: number;
  name: string;
  kind: string;
  confidence: string;
  source: string;
  type: string | null;
  signature: string | null;
  size: number | null;
  seen: number;
  /** 1: rva holds an absolute address (va entries on builds without an image base). */
  absolute: number;
  overlay: string | null;
}

export interface SearchHit {
  title: string;
  /** Best-matching section; `sections` lists every section of the page that matched. */
  section: string;
  sections?: string[];
  type: PageType;
  snippet: string;
  summary: string;
  status: string | null;
  revision: number;
  score: number;
}

const SUBJECT_TYPES_SET = new Set(['software', 'library', 'format', 'platform', 'technique', 'tool']);

/** Whether byte string `outer` contains `inner` (hex pairs; ".." is a wildcard on either side). */
/** inner occurs in outer (".." matches any byte), with at least minFixed real bytes equal on both sides. */
function bytesContain(outer: string, inner: string, minFixed = 0): boolean {
  const a = outer.match(/../g) ?? [];
  const b = inner.match(/../g) ?? [];
  const innerFixed = b.filter((x) => x !== '..').length;
  for (let start = 0; start + b.length <= a.length; start++) {
    let ok = true;
    let fixed = 0;
    for (let i = 0; i < b.length && ok; i++) {
      ok = a[start + i] === '..' || b[i] === '..' || a[start + i] === b[i];
      if (ok && a[start + i] !== '..' && b[i] !== '..') fixed++;
    }
    // "E8 ?? ?? ?? ??" fits anywhere: count only matches that share real bytes, half of the inner's at least.
    if (ok && fixed >= minFixed && fixed * 2 >= innerFixed) return true;
  }
  return false;
}

/** One byte string starts the other; ".." matches any byte. Both need 2+ fixed bytes in common. */
function bytesPrefix(a: string, b: string): boolean {
  const x = a.match(/../g) ?? [];
  const y = b.match(/../g) ?? [];
  const n = Math.min(x.length, y.length);
  let fixed = 0;
  for (let i = 0; i < n; i++) {
    if (x[i] === '..' || y[i] === '..') continue;
    if (x[i] !== y[i]) return false;
    fixed++;
  }
  return fixed >= 2;
}

/** "Lua 5.4.6 (C) 1994-2023" → "Lua #.#.# (C) #-#": numbers differ between versions of one string. */
function maskDigits(text: string): string {
  return text.replace(/\d+/g, '#');
}

/** A published string with * wildcards against an input string (whole match). */
function globMatch(pattern: string, text: string): boolean {
  // "*" any run, "?" one character ("fts5: ????-??-?? *").
  const re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\?/g, '.')).join('[\\s\\S]*')}$`);
  return re.test(text);
}

/** Words too common to search on their own (match="any"). */
const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'in', 'into', 'is', 'it', 'of', 'on', 'or', 'the', 'to', 'what', 'when', 'where', 'with']);

export class SearchIndex {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // Wait for another process's write (the CLI next to the running gateway) instead of failing at once.
    this.db.exec('pragma journal_mode = wal; pragma busy_timeout = 10000;');
    // An index from before stemming: drop its text table and the poll cursor, so the
    // indexer rebuilds everything on its next pass.
    const docs = this.db.prepare("select sql from sqlite_master where name = 'docs'").get() as { sql: string } | undefined;
    if (docs && !docs.sql.includes('porter')) {
      this.db.exec('drop table docs');
      this.db.exec("create table if not exists state (key text primary key, value text not null); delete from state where key = 'rc_cursor';");
    }
    // Symbols without the absolute/overlay columns: same, rebuilt on the next pass.
    const symbolCols = (this.db.prepare('pragma table_info(symbols)').all() as Array<{ name: string }>).map((c) => c.name);
    if (symbolCols.length && !symbolCols.includes('absolute')) {
      this.db.exec('drop table symbols');
      this.db.exec("create table if not exists state (key text primary key, value text not null); delete from state where key = 'rc_cursor';");
    }
    this.db.exec(SCHEMA);
  }

  getState(key: string): string | null {
    const row = this.db.prepare('select value from state where key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setState(key: string, value: string): void {
    this.db.prepare('insert or replace into state (key, value) values (?, ?)').run(key, value);
  }

  clear(): void {
    this.db.exec('delete from pages; delete from docs; delete from identifiers; delete from edges; delete from facts; delete from builds; delete from build_files; delete from symbols; delete from moves; delete from state;');
  }

  removePage(title: string): void {
    for (const table of ['pages', 'docs', 'identifiers', 'facts', 'builds', 'build_files', 'symbols']) {
      this.db.prepare(`delete from ${table} where title = ?`).run(title);
    }
    this.db.prepare('delete from edges where src = ?').run(title);
  }

  page(title: string): { title: string; type: PageType; revision: number; summary: string; status: string | null; subject: string | null; redirect_to: string | null; author: string | null; json: string | null } | undefined {
    return this.db.prepare('select * from pages where title = ?').get(title) as any;
  }

  /**
   * The current title of a page: through a redirect, or through MediaWiki's move log for
   * pages that cannot hold a redirect (JSON pages: builds, facts, symbol maps).
   */
  resolveRedirect(title: string): string {
    let current = title;
    for (let hops = 0; hops < 10; hops++) {
      const page = this.page(current);
      if (page && !page.redirect_to) return current;
      const next = page?.redirect_to ?? (this.db.prepare('select new from moves where old = ?').get(current) as { new: string } | undefined)?.new;
      if (!next || next === current) return current;
      current = next;
    }
    return current;
  }

  /** Records a page move (from the move log); documents may still cite the old title. */
  recordMove(from: string, to: string): void {
    if (from !== to) this.db.prepare('insert or replace into moves (old, new) values (?, ?)').run(from, to);
  }

  /** A page and every older title that leads to it (redirects and moves, any number of renames). */
  namesOf(title: string): string[] {
    const target = this.resolveRedirect(title);
    const names = new Set([target]);
    let frontier = [target];
    while (frontier.length && names.size < 200) {
      const next: string[] = [];
      for (const name of frontier) {
        const olds = [
          ...(this.db.prepare('select title as t from pages where redirect_to = ?').all(name) as Array<{ t: string }>),
          ...(this.db.prepare('select old as t from moves where new = ?').all(name) as Array<{ t: string }>),
        ];
        for (const { t } of olds) if (!names.has(t)) { names.add(t); next.push(t); }
      }
      frontier = next;
    }
    return [...names];
  }

  /** SQL fragment and values matching a build column against a build and its old titles. */
  private buildIn(build: string, column = 'build'): { sql: string; values: string[] } {
    const names = this.namesOf(build);
    return { sql: `${column} in (${names.map(() => '?').join(', ')})`, values: names };
  }

  // ---- indexing ----------------------------------------------------------------

  indexPage(p: IndexablePage): void {
    const type = typeOfTitle(p.title);
    this.db.exec('begin');
    try {
      this.removePage(p.title);
      const target = redirectTarget(p.content);
      if (target) {
        this.insertPage(p, type, '', null, target, target, null);
        this.edge(p.title, 'alias_of', target);
      } else if (SUBJECT_TYPES_SET.has(type)) {
        this.indexArticle(p, type);
      } else if (type === 'fact') {
        this.indexFact(p);
      } else if (type === 'build') {
        this.indexBuild(p);
      } else if (type === 'symbols') {
        this.indexSymbols(p);
      } else if (type === 'code') {
        this.indexCode(p);
      } else if (type === 'notes') {
        this.indexNote(p);
      } else if (type === 'project') {
        this.insertPage(p, type, '', null, null, null, null);
        this.doc(p.title, '', wikitextToMarkdown(p.content), type);
      }
      this.db.exec('commit');
    } catch (error) {
      this.db.exec('rollback');
      throw error;
    }
  }

  private insertPage(p: IndexablePage, type: PageType, summary: string, status: string | null, subject: string | null,
    redirect: string | null, json: string | null): void {
    this.db.prepare(`insert into pages (title, type, revision, touched, author, summary, status, subject, redirect_to, json)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(p.title, type, p.revid, p.timestamp, p.user, summary.slice(0, 600), status, subject, redirect, json);
  }

  private doc(title: string, section: string, body: string, type: string): void {
    this.db.prepare('insert into docs (title, section, body, type) values (?, ?, ?, ?)').run(title, section, body, type);
  }

  private ids(title: string, section: string, ids: Identifier[]): void {
    const stmt = this.db.prepare('insert into identifiers (kind, token, title, section) values (?, ?, ?, ?)');
    for (const id of ids) stmt.run(id.kind, id.token, title, section);
  }

  private edge(src: string, rel: string, dst: string): void {
    if (dst && dst !== src) this.db.prepare('insert into edges (src, rel, dst) values (?, ?, ?)').run(src, rel, dst);
  }

  private indexArticle(p: IndexablePage, type: PageType): void {
    const sections = parseSections(p.content);
    const { rest } = splitInfobox(sections[0]?.text ?? '');
    const lead = rest.replace(/^\s*\{\{Topic of\|[^}]*\}\}\s*/, '');
    const summary = wikitextToMarkdown(lead.split(/\n\s*\n/)[0] ?? '').slice(0, 600);
    const infobox = parseInfobox(p.content);
    const root = subjectRoot(p.title);
    this.insertPage(p, type, summary, null, root, null, JSON.stringify({ infobox }));
    if (isTopicPage(p.title)) this.edge(p.title, 'topic_of', root);

    // Listing templates are rendered by MediaWiki; their source is noise in search results.
    const strip = (text: string) => text.replace(/\{\{(?:Fact list|Code list|Topic of|Main)\|[^}]*\}\}/g, '');
    for (const section of sections) {
      const body = strip(section.level === 0 ? wikitextToMarkdown(rest) : wikitextToMarkdown(section.body));
      if (!body.trim()) continue;
      this.doc(p.title, section.heading, body, type);
      this.ids(p.title, section.heading, extractFromText(body));
    }
    for (const [field, rel] of Object.entries(RELATION_FIELDS)) {
      for (const link of wikiLinks(infobox[field] ?? '')) this.edge(p.title, rel, link);
    }
    if (infobox.magic) {
      for (const part of infobox.magic.split(/[,;]/)) {
        const clean = part.replace(/<\/?(?:code|nowiki)>/g, '').replace(/[`"]/g, '');
        const runs = [clean, ...(clean.match(/(?:\b[0-9A-Fa-f]{2}\b\s*){2,}/g) ?? [])];
        const bytes = runs.map((r) => normalizeBytes(r.trim())).find((b) => b);
        if (bytes) this.ids(p.title, 'Infobox', [{ kind: 'bytes', token: bytes }]);
      }
    }
    for (const link of new Set(wikiLinks(p.content))) this.edge(p.title, 'links', link);
  }

  private indexFact(p: IndexablePage): void {
    let doc: FactDoc;
    try {
      doc = JSON.parse(p.content);
    } catch {
      return;
    }
    this.insertPage(p, 'fact', doc.claim ?? '', doc.status ?? 'claimed', doc.subject ?? null, null, p.content);
    this.db.prepare(`insert into facts (title, subject, kind, status, level, applies_to, observed_in, data)
      values (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(p.title, doc.subject ?? '', doc.kind ?? '', doc.status ?? 'claimed', doc.scope?.level ?? '',
        doc.scope?.applies_to ?? '', JSON.stringify(doc.scope?.observed_in ?? []), JSON.stringify(doc.data ?? {}));
    const body = [doc.claim, `Scope: ${doc.scope?.level} — ${doc.scope?.applies_to}`, JSON.stringify(doc.data, null, 1),
      ...(doc.evidence ?? []).map((e) => `${e.type}: ${e.detail}`)].join('\n');
    this.doc(p.title, '', body, 'fact');
    this.ids(p.title, '', [...extractFromFactData(doc.data ?? {}), ...extractFromText(doc.claim ?? '')]);
    this.edge(p.title, 'fact_of', doc.subject);
    if (doc.topic) this.edge(p.title, 'fact_of', doc.topic);
    if (doc.scope?.applies_to?.startsWith('Build:')) this.edge(p.title, 'applies_to', doc.scope.applies_to);
    for (const b of doc.scope?.observed_in ?? []) this.edge(p.title, 'observed_in', b);
    for (const r of doc.related ?? []) this.edge(p.title, 'related', r);
  }

  private indexBuild(p: IndexablePage): void {
    let doc: BuildDoc;
    try {
      doc = JSON.parse(p.content);
    } catch {
      return;
    }
    const summary = `${doc.software} ${doc.version} (${doc.distribution}, ${doc.platform})`;
    this.insertPage(p, 'build', summary, null, doc.software, null, p.content);
    this.db.prepare('insert into builds (title, software, version, platform, distribution) values (?, ?, ?, ?, ?)')
      .run(p.title, doc.software, doc.version, doc.platform, doc.distribution);
    for (const f of doc.files ?? []) {
      const sha = f.sha256?.toLowerCase() ?? '';
      this.db.prepare('insert into build_files (sha256, title, name, size, pe_timestamp) values (?, ?, ?, ?, ?)')
        .run(sha, p.title, f.name, f.size ?? 0, f.pe_timestamp ?? null);
      const other = (f as { sha1?: string; md5?: string; crc32?: string });
      this.ids(p.title, '', [
        ...(sha ? [{ kind: 'sha256' as const, token: sha }] : []),
        ...(other.sha1 ? [{ kind: 'sha1' as const, token: other.sha1.toLowerCase() }] : []),
        ...(other.md5 ? [{ kind: 'md5' as const, token: other.md5.toLowerCase() }] : []),
        ...(other.crc32 ? [{ kind: 'crc32' as const, token: other.crc32.toLowerCase().replace(/^0x/, '') }] : []),
        { kind: 'file' as const, token: f.name.toLowerCase() },
      ]);
    }
    this.doc(p.title, '', `${summary}\n${(doc.files ?? []).map((f) => f.name).join(' ')}\n${doc.notes ?? ''}`, 'build');
    this.edge(p.title, 'build_of', doc.software);
  }

  private indexSymbols(p: IndexablePage): void {
    let doc: SymbolsDoc;
    try {
      doc = JSON.parse(p.content);
    } catch {
      return;
    }
    const symbols = Array.isArray(doc.symbols) ? doc.symbols : [];
    this.insertPage(p, 'symbols', `${symbols.length} symbols, ${doc.range?.start}–${doc.range?.end}`, null, doc.build, null, null);
    const stmt = this.db.prepare(`insert into symbols (title, build, rva, name, kind, confidence, source, type, signature, size, seen, absolute, overlay)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const x of symbols) {
      const rva = parseInt(String(x.rva), 16);
      if (!Number.isFinite(rva) || typeof x.name !== 'string') continue;
      stmt.run(p.title, doc.build, rva, x.name, x.kind ?? 'function', x.confidence ?? 'low', x.source ?? 'other',
        x.type ?? null, x.signature ?? null, x.size ?? null, 1 + (x.seen_by?.length ?? 0), x.absolute ? 1 : 0, x.overlay ?? null);
    }
    this.edge(p.title, 'symbols_of', doc.build);
  }

  private indexCode(p: IndexablePage): void {
    const doc = parseCodePage(p.content);
    if (!doc) return;
    const subject = doc.meta.subjects[0] ? subjectRoot(doc.meta.subjects[0]) : null;
    this.insertPage(p, 'code', doc.meta.summary, doc.meta.status, subject, null, JSON.stringify(doc.meta));
    const files = doc.files.map((f) => `--- ${f.name}\n${f.content}`).join('\n').slice(0, 40_000);
    this.doc(p.title, '', `${doc.meta.summary}\n${doc.meta.usage}\nTested on: ${doc.meta.tested_on}\n${files}`, 'code');
    this.ids(p.title, '', extractFromText(files));
    for (const s of new Set(doc.meta.subjects.flatMap((x) => [x, subjectRoot(x)]))) this.edge(p.title, 'code_for', s);
  }

  private indexNote(p: IndexablePage): void {
    const header = parseNoteHeader(p.content);
    const body = wikitextToMarkdown(p.content.replace(/\{\{Note header[^}]*\}\}/, ''));
    this.insertPage(p, 'notes', body.slice(0, 300), header?.status ?? 'open', header?.subject ?? null, null, null);
    this.doc(p.title, '', body, 'notes');
    this.ids(p.title, '', extractFromText(body));
    if (header?.subject) this.edge(p.title, 'note_of', header.subject);
  }

  // ---- search --------------------------------------------------------------------

  search(opts: { query: string; types?: string[]; subject?: string; build?: string; status?: string; limit?: number; offset?: number; match?: 'all' | 'any' }): { hits: SearchHit[]; total: number } {
    const limit = Math.min(opts.limit ?? 10, 50);
    const offset = Math.max(0, opts.offset ?? 0);
    const scores = new Map<string, SearchHit>();
    const consider = (hit: SearchHit) => {
      const key = `${hit.title}#${hit.section}`;
      const existing = scores.get(key);
      if (!existing) scores.set(key, hit);
      else existing.score += hit.score;
    };

    let terms = opts.query.split(/\s+/).map((piece) => piece.match(/[\p{L}\p{N}_]+/gu) ?? []).filter((parts) => parts.length);
    // With match="any", common words would match nearly every page: drop them when others remain.
    if (opts.match === 'any') {
      const content = terms.filter((parts) => !(parts.length === 1 && STOP_WORDS.has(parts[0].toLowerCase())));
      if (content.length) terms = content;
    }
    const run = (match: string) => this.db.prepare(`
        select d.title, d.section, d.type, snippet(docs, 2, '**', '**', '…', 24) as snippet, bm25(docs, 5.0, 2.0, 1.0) as rank,
          p.summary, p.status, p.revision
        from docs d join pages p on p.title = d.title
        where docs match ? order by rank limit 200`).all(match) as any[];
    if (terms.length) {
      const quoted = terms.map((parts) => `"${parts.join(' ').replace(/"/g, '')}"`);
      let rows = run(quoted.join(' AND '));
      // Every term must match: "nothing found" beats noise. match="any" is the explicit opt-in.
      if (opts.match === 'any' && terms.length > 1) rows = run(quoted.join(' OR '));
      for (const r of rows) {
        consider({ title: r.title, section: r.section, type: r.type, snippet: r.snippet, summary: r.summary,
          status: r.status, revision: r.revision, score: Math.max(0.1, -r.rank) });
      }
    }

    for (const id of queryTokens(opts.query)) {
      const rows = this.db.prepare(`select i.title, i.section, p.type, p.summary, p.status, p.revision
        from identifiers i join pages p on p.title = i.title where i.kind = ? and i.token = ? limit 50`).all(id.kind, id.token) as any[];
      for (const r of rows) {
        consider({ title: r.title, section: r.section, type: r.type, snippet: `exact match: ${id.kind} ${id.token}`,
          summary: r.summary, status: r.status, revision: r.revision, score: 8 });
      }
    }

    // Symbol map entries are matched by exact name only (there can be millions).
    const symbolName = opts.query.trim();
    if (SYMBOL_NAME.test(symbolName) && symbolName.length <= 200) {
      const rows = this.db.prepare(`select s.title, s.build, s.rva, s.name, s.kind, s.confidence, p.revision from symbols s
        join pages p on p.title = s.title where s.name = ? limit 20`).all(symbolName) as any[];
      for (const r of rows) {
        consider({ title: r.title, section: '', type: 'symbols', snippet: `symbol ${r.name} (${r.kind}) at 0x${r.rva.toString(16).toUpperCase()} in ${r.build}`,
          summary: `Symbol map of ${r.build}`, status: r.confidence, revision: r.revision, score: 10 });
      }
    }

    const q = opts.query.trim().toLowerCase();
    if (q) {
      const rows = this.db.prepare(`select title, type, summary, status, revision, redirect_to from pages
        where lower(title) = ? or lower(substr(title, instr(title, ':') + 1)) = ?`).all(q, q) as any[];
      for (const r of rows) {
        const title = r.redirect_to ?? r.title;
        const target = this.page(title);
        consider({ title, section: '', type: (target?.type ?? r.type) as PageType, snippet: 'title match',
          summary: target?.summary ?? r.summary, status: target?.status ?? r.status, revision: target?.revision ?? r.revision, score: 20 });
      }
    }

    // One word inside a subject's name ("zstd" in Library:Libzstd, "jpeg" in Libjpeg-turbo).
    if (/^[a-z0-9][\w+.-]{3,}$/i.test(q) && !q.includes(':')) {
      const rows = this.db.prepare(`select title, type, summary, status, revision from pages where redirect_to is null
        and type in ('software', 'library', 'format', 'platform', 'technique', 'tool')
        and instr(lower(substr(title, instr(title, ':') + 1)), ?) > 0 limit 10`).all(q) as any[];
      for (const r of rows) consider({ title: r.title, section: '', type: r.type as PageType, snippet: 'title match', summary: r.summary, status: r.status, revision: r.revision, score: 8 });
    }

    // A page whose title holds every term beats one that only mentions them.
    for (const m of this.titleMatches(opts.query, 20)) {
      const page = this.page(m.title);
      if (page) consider({ title: m.title, section: '', type: page.type as PageType, snippet: 'title match', summary: page.summary, status: page.status, revision: page.revision, score: 6 });
    }

    let hits = [...scores.values()].filter((h) => h.type !== ('other' as PageType));
    if (opts.types?.length) hits = hits.filter((h) => opts.types!.includes(h.type));
    if (opts.status) hits = hits.filter((h) => h.status === opts.status);
    if (opts.subject) {
      const related = this.subjectFamily(opts.subject);
      hits = hits.filter((h) => related.has(h.title));
    }
    if (opts.build) {
      const buildTitles = new Set(this.factsForBuild(opts.build).map((f) => f.title));
      buildTitles.add(opts.build);
      hits = hits.filter((h) => buildTitles.has(h.title) || h.title.startsWith(`${opts.build}/`) || (h.type !== 'fact' && h.type !== 'symbols'));
    }
    // One result per page: the best section leads, the others are listed with it.
    const byPage = new Map<string, SearchHit>();
    for (const h of hits.sort((a, b) => b.score - a.score)) {
      const page = byPage.get(h.title);
      if (!page) {
        byPage.set(h.title, { ...h, sections: h.section ? [h.section] : [] });
        continue;
      }
      page.score += h.score * 0.1;
      if (h.section && !page.sections!.includes(h.section)) page.sections!.push(h.section);
    }
    const pages = [...byPage.values()].sort((a, b) => b.score - a.score)
      .map((h) => ({ ...h, sections: h.sections!.length > 1 ? h.sections!.slice(0, 8) : undefined }));
    return { hits: pages.slice(offset, offset + limit), total: pages.length };
  }

  /** A subject page plus everything attached to it (facts, code, notes, builds, aliases). */
  subjectFamily(subject: string): Set<string> {
    const set = new Set([subject]);
    const rows = this.db.prepare(`select src from edges where dst = ? and rel in ('fact_of', 'code_for', 'note_of', 'build_of', 'alias_of', 'topic_of')`)
      .all(subject) as Array<{ src: string }>;
    for (const r of rows) set.add(r.src);
    return set;
  }

  // ---- identify ------------------------------------------------------------------

  identify(evidence: Evidence, limit = 5) {
    const tokens = evidenceTokens(evidence);
    // input → subject → titles that matched
    const perInput = new Map<string, Map<string, Set<string>>>();
    const weights = new Map<string, number>();
    const magicInputs = new Set<string>();
    const symbolInputs = new Set<string>();
    for (const t of tokens) {
      let rows: Array<{ title: string; subject: string | null }>;
      if (t.kind === 'bytes' && t.prefix) {
        rows = this.db.prepare(`select i.title, p.subject from identifiers i join pages p on p.title = i.title
          where i.kind = 'bytes' and (i.token like ? or ? like i.token || '%') limit 100`).all(`${t.token}%`, t.token) as any[];
        // Magics with wildcard bytes (a mask, or ?? in the fact): compared byte by byte.
        const wild = this.db.prepare(`select i.title, i.token, p.subject from identifiers i join pages p on p.title = i.title
          where i.kind = 'bytes' and instr(i.token, '..') > 0 limit 20000`).all() as Array<{ title: string; token: string; subject: string | null }>;
        rows = [...rows, ...wild.filter((r) => bytesPrefix(r.token, t.token))];
        // 6+ bytes also match inside a longer published sequence (a trailer after its length field: IEND's
        // type and CRC inside "00 00 00 00 49 45 4E 44 AE 42 60 82").
        if (t.token.length >= 12) {
          const longer = this.db.prepare(`select i.title, i.token, p.subject from identifiers i join pages p on p.title = i.title
            where i.kind = 'bytes' and length(i.token) > ? limit 20000`).all(t.token.length) as Array<{ title: string; token: string; subject: string | null }>;
          rows = [...rows, ...longer.filter((r) => bytesContain(r.token, t.token, 6))];
        }
      } else if (t.kind === 'bytes' && t.token.length >= 8) {
        // A pattern of 4+ bytes found inside a published signature, or containing one; ?? matches any byte.
        const all = this.db.prepare(`select i.title, i.token, p.subject from identifiers i join pages p on p.title = i.title
          where i.kind = 'bytes' limit 20000`).all() as Array<{ title: string; token: string; subject: string | null }>;
        // The contained side needs 3+ different byte values: zero runs and fill bytes fit inside any table.
        const varied = (token: string) => new Set((token.match(/../g) ?? []).filter((x) => x !== '..')).size >= 3;
        rows = all.filter((r) => r.token === t.token || (r.token.length >= 8 && ((varied(t.token) && bytesContain(r.token, t.token, 3)) || (varied(r.token) && bytesContain(t.token, r.token, 3)))));
      } else if (t.kind === 'string') {
        rows = this.db.prepare(`select i.title, p.subject from identifiers i join pages p on p.title = i.title
          where i.kind = 'string' and (i.token = ?
            or (length(i.token) >= 12 and instr(?, i.token) > 0)
            or (length(?) >= 12 and instr(i.token, ?) > 0)) limit 100`)
          .all(t.token, t.token, t.token, t.token) as any[];
        // Wildcards in published strings ("$luaversion: lua 5.*"), and the same text with other numbers
        // (version banners, copyright years): digits are masked on both sides.
        const masked = maskDigits(t.token);
        const loose = this.db.prepare(`select i.title, i.token, p.subject from identifiers i join pages p on p.title = i.title
          where i.kind = 'string' and (length(i.token) >= 12 or (instr(i.token, '*') > 0 and length(replace(replace(i.token, '*', ''), '?', '')) >= 5)) limit 20000`).all() as Array<{ title: string; token: string; subject: string | null }>;
        rows = [...rows, ...loose.filter((r) => {
          if (r.token.includes('*') && globMatch(r.token, t.token)) return true;
          // Both sides keep 12+ characters once masked ("1234567890..." test vectors mask to "#").
          const other = maskDigits(r.token);
          return masked.length >= 12 && other.length >= 12 && /\d/.test(t.token + r.token) && (other.includes(masked) || masked.includes(other));
        })];
      } else {
        rows = this.db.prepare(`select i.title, p.subject from identifiers i join pages p on p.title = i.title
          where i.kind = ? and i.token = ? limit 100`).all(t.kind, t.token) as any[];
        if (t.kind === 'symbol' && t.source !== 'imports') {
          const mapped = this.db.prepare(`select distinct s.title, b.software as subject from symbols s join builds b on b.title = s.build
            where lower(s.name) = ? limit 50`).all(t.token) as any[];
          rows = [...rows, ...mapped];
        }
        if (t.kind === 'symbol') {
          const globs = this.db.prepare(`select i.title, i.token, p.subject from identifiers i join pages p on p.title = i.title
            where i.kind = 'symbol' and instr(i.token, '*') > 0 limit 2000`).all() as Array<{ title: string; token: string; subject: string | null }>;
          rows = [...rows, ...globs.filter((g) => globMatch(g.token, t.token))];
        }
      }
      if (!rows.length) continue;
      const bySubject = perInput.get(t.input) ?? new Map<string, Set<string>>();
      for (const r of rows) {
        const subject = r.subject ?? r.title;
        const titles = bySubject.get(subject) ?? new Set<string>();
        titles.add(r.title);
        bySubject.set(subject, titles);
      }
      perInput.set(t.input, bySubject);
      weights.set(t.input, Math.max(weights.get(t.input) ?? 0, t.weight));
      if (t.prefix) magicInputs.add(t.input);
      if (t.kind === 'symbol') symbolInputs.add(t.input);
    }

    const candidates = new Map<string, { subject: string; score: number; matched: Array<{ input: string; pages: string[] }> }>();
    for (const [input, bySubject] of perInput) {
      const specificity = 1 / Math.sqrt(bySubject.size); // an input matching many subjects says little
      for (const [subject, titles] of bySubject) {
        const c = candidates.get(subject) ?? { subject, score: 0, matched: [] };
        const onFact = [...titles].some((t) => t.startsWith('Fact:'));
        // File magic matched by the subject's own magic fact: as telling as a unique string.
        const onMagicFact = magicInputs.has(input) && [...titles].some((t) => /^Fact:[^/]+\/magic\//.test(t));
        // A name found in a build's symbol map or a fact is evidence; the same name in prose is a mention.
        const onMap = [...titles].some((t) => t.startsWith('Build:') && t.includes('/symbols/'));
        const proseOnly = symbolInputs.has(input) && !onFact && !onMap;
        c.score += (weights.get(input) ?? 1) * specificity * (onMagicFact ? 2 : onMap ? 2 : onFact ? 1.5 : proseOnly ? 0.6 : 1);
        c.matched.push({ input, pages: [...titles].slice(0, 5) });
        candidates.set(subject, c);
      }
    }
    return [...candidates.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((c) => {
        const page = this.page(c.subject);
        return {
          subject: c.subject,
          type: page?.type ?? typeOfTitle(c.subject),
          summary: page?.summary ?? '',
          score: Math.round(c.score * 100) / 100,
          confidence: c.matched.length >= 3 && c.score >= 6 ? 'high' : c.score >= 3 ? 'medium' : 'low',
          matched: c.matched,
        };
      });
  }

  // ---- binaries, facts, graph ------------------------------------------------------

  /** Every Build: title (for "did you mean" suggestions). */
  buildTitles(limit = 500): string[] {
    return (this.db.prepare('select title from builds order by title limit ?').all(limit) as Array<{ title: string }>).map((r) => r.title);
  }

  /** Pages whose title contains every word of the query (subjects first): better than a body match. */
  titleMatches(query: string, limit = 5): Array<{ title: string; type: string; summary: string }> {
    const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    if (!words.length || words.length > 6) return [];
    const where = words.map(() => "(' ' || lower(title) || ' ') like ?").join(' and ');
    const rows = this.db.prepare(`select coalesce(redirect_to, title) as title from pages where ${where} limit 50`)
      .all(...words.map((w) => `%${w}%`)) as Array<{ title: string }>;
    const order = ['software', 'library', 'format', 'platform', 'technique', 'tool'];
    const seen = new Set<string>();
    const out: Array<{ title: string; type: string; summary: string }> = [];
    const short = words.filter((w) => w.length <= 4).map((w) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'iu'));
    for (const r of rows) {
      if (short.some((re) => !re.test(r.title.slice(r.title.indexOf(':') + 1)))) continue;
      const page = this.page(r.title);
      if (!page || seen.has(r.title)) continue;
      seen.add(r.title);
      out.push({ title: r.title, type: page.type, summary: page.summary });
    }
    const rank = (t: string) => (order.includes(t) ? order.indexOf(t) : order.length);
    return out.sort((a, b) => rank(a.type) - rank(b.type) || a.title.length - b.title.length).slice(0, limit);
  }

  /** A build by any of its files' SHA-1, MD5 or CRC32. */
  buildByHash(kind: 'sha1' | 'md5' | 'crc32', value: string): string | null {
    const row = this.db.prepare(`select i.title from identifiers i join pages p on p.title = i.title where i.kind = ? and i.token = ? and p.type = 'build' limit 1`)
      .get(kind, value.toLowerCase().replace(/^0x/, '')) as { title: string } | undefined;
    return row?.title ?? null;
  }

  buildBySha(sha256: string): string | null {
    const row = this.db.prepare('select title from build_files where sha256 = ?').get(sha256.toLowerCase()) as { title: string } | undefined;
    return row?.title ?? null;
  }

  buildByFile(name: string, size?: number, peTimestamp?: string): string | null {
    const rows = this.db.prepare('select title, size, pe_timestamp from build_files where lower(name) = lower(?)').all(name) as any[];
    const exact = rows.find((r) => (size === undefined || r.size === size) && (!peTimestamp || r.pe_timestamp?.toLowerCase() === peTimestamp.toLowerCase()));
    return exact?.title ?? null;
  }

  buildsOf(software: string): Array<{ title: string; version: string; platform: string; distribution: string }> {
    return this.db.prepare('select title, version, platform, distribution from builds where software = ? order by version').all(software) as any[];
  }

  factsForBuild(build: string): Array<{ title: string; kind: string; status: string; data: string; subject: string }> {
    const names = this.namesOf(build);
    const applies = names.map(() => 'applies_to = ?').join(' or ');
    const observed = names.map(() => 'observed_in like ?').join(' or ');
    return this.db.prepare(`select title, kind, status, data, subject from facts where ${applies} or ${observed}`)
      .all(...names, ...names.map((n) => `%${JSON.stringify(n).slice(1, -1)}%`)) as any[];
  }

  /**
   * The general pages (formats, platforms, libraries, techniques, tools) a subject is connected to,
   * in either direction (infobox fields or links), with how much they hold.
   */
  generalNeighbors(title: string): Array<{ title: string; type: string; summary: string; facts: number; code: number }> {
    const rows = this.db.prepare(`select dst as other from edges where src = ? and rel in ('uses', 'uses_format', 'runs_on', 'links', 'used_by')
      union select src as other from edges where dst = ? and rel in ('uses', 'uses_format', 'runs_on', 'links', 'used_by')`).all(title, title) as Array<{ other: string }>;
    const out: Array<{ title: string; type: string; summary: string; facts: number; code: number }> = [];
    for (const r of rows) {
      const target = this.resolveRedirect(r.other);
      const page = this.page(target);
      if (!page || target === title || subjectRoot(target) === title || !['format', 'platform', 'library', 'technique', 'tool'].includes(page.type) || out.some((o) => o.title === target)) continue;
      const facts = (this.db.prepare("select count(*) as n from edges where dst = ? and rel = 'fact_of'").get(target) as { n: number }).n;
      const code = (this.db.prepare("select count(*) as n from edges where dst = ? and rel = 'code_for'").get(target) as { n: number }).n;
      out.push({ title: target, type: page.type, summary: page.summary.slice(0, 160), facts, code });
    }
    return out.slice(0, 20);
  }

  /** Every page of some types, by title (search with query "*"). */
  listPages(types: string[], offset: number, limit: number, subject?: string): { hits: Array<{ title: string; type: string; summary: string; status: string | null; revision: number }>; total: number } {
    const placeholders = types.map(() => '?').join(', ');
    // With a subject: its own pages (facts, notes, code, builds of it).
    const where = `redirect_to is null and type in (${placeholders})${subject ? ' and (subject = ? or title = ?)' : ''}`;
    const params = [...types, ...(subject ? [subject, subject] : [])];
    const total = (this.db.prepare(`select count(*) as n from pages where ${where}`).get(...params) as { n: number }).n;
    const hits = this.db.prepare(`select title, type, summary, status, revision from pages where ${where} order by title limit ? offset ?`)
      .all(...params, limit, offset) as any[];
    return { hits: hits.map((h) => ({ ...h, summary: String(h.summary ?? '').slice(0, 200) })), total };
  }

  /** Names of every struct fact on the wiki (export_header tells a type from another page from an unknown one). */
  structNames(): string[] {
    return (this.db.prepare(`select json_extract(data, '$.name') as name from facts where kind = 'struct' and status != 'rejected'`).all() as Array<{ name: unknown }>)
      .map((r) => r.name).filter((n): n is string => typeof n === 'string');
  }

  factsForSubject(subject: string, kinds?: string[]): Array<{ title: string; kind: string; status: string; level: string; applies_to: string; data: string }> {
    const rows = this.db.prepare('select title, kind, status, level, applies_to, data from facts where subject = ?').all(subject) as any[];
    return kinds?.length ? rows.filter((r) => kinds.includes(r.kind)) : rows;
  }

  /**
   * Subject pages a short name may refer to: "PE" for "Format:PE (Portable Executable)" (the name before or inside the
   * parentheses), "DLL proxy" for "Technique:DLL proxy loading" (a word prefix), or any title containing it.
   */
  subjectsNamed(name: string): Array<{ title: string; via: 'title' | 'short name' | 'similar title' }> {
    const n = name.trim().toLowerCase();
    if (n.length < 2) return [];
    const rows = this.db.prepare(`select title from pages where redirect_to is null
      and type in ('software', 'library', 'format', 'platform', 'technique', 'tool') and instr(title, '/') = 0
      and instr(lower(substr(title, instr(title, ':') + 1)), ?) > 0 limit 200`).all(n) as Array<{ title: string }>;
    const out: Array<{ title: string; via: 'title' | 'short name' | 'similar title' }> = [];
    for (const { title } of rows) {
      const base = title.slice(title.indexOf(':') + 1).toLowerCase();
      const outer = base.replace(/\s*\(([^)]*)\)\s*$/, '').trim();
      const inner = /\(([^)]*)\)\s*$/.exec(base)?.[1]?.trim();
      if (base === n) out.push({ title, via: 'title' });
      else if (outer === n || inner === n) out.push({ title, via: 'short name' });
      else if (new RegExp(`(?:^|[\\s(/-])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[\\s)/-])`).test(base) || base.startsWith(`${n} `)) out.push({ title, via: 'similar title' });
    }
    return out.sort((a, b) => ['title', 'short name', 'similar title'].indexOf(a.via) - ['title', 'short name', 'similar title'].indexOf(b.via)).slice(0, 5);
  }

  /** Pages whose text contains a string (a repository URL), for "already listed on". */
  pagesMentioning(text: string, limit = 20): string[] {
    return (this.db.prepare('select distinct title from docs where instr(body, ?) > 0 limit ?').all(text, limit) as Array<{ title: string }>).map((r) => r.title);
  }

  /** Struct, enum and typedef facts of one type name, on any subject (export_header also=["GUID"]). */
  typeFactsByName(name: string): Array<{ title: string; kind: string; status: string; level: string; applies_to: string; data: string }> {
    return this.db.prepare(`select title, kind, status, level, applies_to, data from facts where kind in ('struct', 'enum', 'typedef')
      and json_extract(data, '$.name') = ? limit 10`).all(name) as any[];
  }

  /** Facts about a topic subpage (fact.topic): stored on its subject page. */
  factsForTopic(topic: string): Array<{ title: string; kind: string; status: string }> {
    return this.db.prepare(`select f.title, f.kind, f.status from facts f join edges e on e.src = f.title
      where e.rel = 'fact_of' and e.dst = ?`).all(topic) as any[];
  }

  sectionText(title: string, heading: string): string | null {
    const row = this.db.prepare('select body from docs where title = ? and lower(section) = lower(?)').get(title, heading) as { body: string } | undefined;
    return row?.body ?? null;
  }

  static readonly REVERSE_RELATIONS: Record<string, string> = {
    used_by: 'uses', has_facts: 'fact_of', has_code: 'code_for', has_notes: 'note_of', has_builds: 'build_of',
    has_topics: 'topic_of', has_symbols: 'symbols_of',
  };

  /** Every edge around a page (up to depth 3), optionally one relation; facts can be filtered by kind and status. */
  related(title: string, opts: { relation?: string; depth?: number; kind?: string; status?: string } = {}): Array<{ src: string; rel: string; dst: string }> {
    const reverse = SearchIndex.REVERSE_RELATIONS;
    const { relation } = opts;
    const out: Array<{ src: string; rel: string; dst: string }> = [];
    const seen = new Set([title]);
    let frontier = [title];
    for (let d = 0; d < Math.min(opts.depth ?? 1, 3) && frontier.length; d++) {
      const next: string[] = [];
      for (const node of frontier) {
        const outgoing = this.db.prepare('select src, rel, dst from edges where src = ?').all(node) as any[];
        const incoming = this.db.prepare('select src, rel, dst from edges where dst = ?').all(node) as any[];
        for (const e of [...outgoing, ...incoming]) {
          if (e.rel === 'links' && relation !== 'links') continue;
          if (relation) {
            const wanted = reverse[relation] ?? relation;
            if (e.rel !== wanted) continue;
            if (reverse[relation] && e.dst !== node) continue;
          }
          out.push(e);
          for (const n of [e.src, e.dst]) if (!seen.has(n)) { seen.add(n); next.push(n); }
        }
      }
      frontier = next;
    }
    if (!opts.kind && !opts.status) return out;
    const facts = new Map((this.db.prepare('select title, kind, status from facts').all() as any[]).map((f) => [f.title, f]));
    return out.filter((e) => {
      const fact = facts.get(e.src) ?? facts.get(e.dst);
      return !!fact && (!opts.kind || fact.kind === opts.kind) && (!opts.status || fact.status === opts.status);
    });
  }

  /** Topic subpages of a subject, in title order. */
  topicsOf(root: string): Array<{ title: string; summary: string }> {
    return this.db.prepare(`select p.title, p.summary from edges e join pages p on p.title = e.src
      where e.dst = ? and e.rel = 'topic_of' order by p.title`).all(root) as any[];
  }

  // ---- symbol maps -------------------------------------------------------------------

  symbolCount(build: string): { symbols: number; pages: number } {
    const b = this.buildIn(build);
    const row = this.db.prepare(`select count(*) as n, count(distinct title) as p from symbols where ${b.sql}`).get(...b.values) as { n: number; p: number };
    return { symbols: row.n, pages: row.p };
  }

  /** The symbol at an RVA, or the closest one below it (with the offset into it). */
  symbolAt(build: string, rva: number): (SymbolRow & { offset: number }) | null {
    const b = this.buildIn(build);
    const row = this.db.prepare(`select * from symbols where ${b.sql} and rva <= ? order by rva desc limit 1`).get(...b.values, rva) as SymbolRow | undefined;
    return row ? { ...row, offset: rva - row.rva } : null;
  }

  symbolsRange(build: string, from: number, to: number, limit: number): SymbolRow[] {
    const b = this.buildIn(build);
    return this.db.prepare(`select * from symbols where ${b.sql} and rva >= ? and rva <= ? order by rva limit ?`).all(...b.values, from, to, limit) as any[];
  }

  /** Exact name, or a prefix when the name ends with "*"; optionally across all builds. */
  /**
   * Where a name is in every build: symbol maps and build-level facts (rva, or a va address), with
   * the software of each build, to carry an address from one version or region to another.
   */
  addressesOf(name: string, limit = 50): Array<{ build: string; rva: number; absolute: boolean; source: string; software: string | null }> {
    const out: Array<{ build: string; rva: number; absolute: boolean; source: string; software: string | null }> = [];
    const softwareOf = (b: string) => (this.db.prepare('select software from builds where title = ?').get(this.resolveRedirect(b)) as { software: string } | undefined)?.software ?? null;
    for (const r of this.db.prepare('select build, rva, absolute, title from symbols where name = ? limit ?').all(name, limit) as any[]) {
      out.push({ build: this.resolveRedirect(r.build), rva: r.rva, absolute: !!r.absolute, source: r.title, software: softwareOf(r.build) });
    }
    const facts = this.db.prepare(`select title, applies_to, data from facts where level = 'build' and kind in ('function', 'global', 'vtable')
      and (json_extract(data, '$.name') = ? or json_extract(data, '$.class') = ?) limit ?`).all(name, name, limit) as Array<{ title: string; applies_to: string; data: string }>;
    for (const f of facts) {
      let d: any = {};
      try { d = JSON.parse(f.data); } catch { /* skip */ }
      const rva = typeof d.rva === 'string' ? parseInt(d.rva, 16) : NaN;
      const va = d.address?.kind === 'va' && typeof d.address.value === 'string' ? parseInt(d.address.value, 16) : NaN;
      const at = Number.isFinite(rva) ? rva : va;
      if (!Number.isFinite(at)) continue;
      const build = this.resolveRedirect(f.applies_to);
      // A fact and a symbol map naming the same address: the fact (it has evidence).
      const same = out.findIndex((o) => o.build === build && o.rva === at);
      const row = { build, rva: at, absolute: !Number.isFinite(rva), source: f.title, software: softwareOf(build) };
      if (same >= 0) out[same] = row; else out.push(row);
    }
    return out;
  }

  symbolsByName(name: string, build: string | null, limit: number, offset: number): SymbolRow[] {
    const prefix = name.endsWith('*');
    const value = prefix ? `${name.slice(0, -1).replace(/[!%_]/g, (c) => `!${c}`)}%` : name;
    const b = build ? this.buildIn(build) : null;
    const where = `${prefix ? "name like ? escape '!'" : 'name = ?'}${b ? ` and ${b.sql}` : ''}`;
    return this.db.prepare(`select * from symbols where ${where} order by build, rva limit ? offset ?`)
      .all(value, ...(b?.values ?? []), limit, offset) as any[];
  }

  symbolsForBuild(build: string): SymbolRow[] {
    const b = this.buildIn(build);
    return this.db.prepare(`select * from symbols where ${b.sql} order by rva`).all(...b.values) as any[];
  }

  allSymbols(): Iterable<SymbolRow> {
    return this.db.prepare('select * from symbols order by build, rva').iterate() as Iterable<SymbolRow>;
  }

  /** Subject pages (not facts, notes or builds), most recently changed first. */
  recentSubjects(limit: number): Array<{ title: string; type: string; summary: string }> {
    return this.db.prepare(`select title, type, summary from pages where redirect_to is null
      and type in ('software', 'library', 'format', 'platform', 'technique', 'tool') order by touched desc limit ?`).all(limit) as any[];
  }

  stats(): Record<string, number> {
    // Aliases (redirects) are not pages of their own.
    const rows = this.db.prepare('select type, count(*) as n from pages where redirect_to is null group by type').all() as Array<{ type: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.type, r.n]));
  }

  allFacts(): Array<{ title: string; json: string }> {
    return this.db.prepare("select title, json from pages where type = 'fact' order by title").all() as any[];
  }
}
