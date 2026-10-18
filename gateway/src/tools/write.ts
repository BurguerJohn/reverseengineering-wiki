/** Write tools (design/04-mcp-server.md#write). Every write needs an operator account. */
import { createHash } from 'node:crypto';
import { createTwoFilesPatch } from 'diff';
import type { Operator } from '../db/accounts.ts';
import {
  ToolError, afterWrite, assertClean, batchContext, charge, currentWriter, link, mwEdit, now, readPage, requireWriter, type Caller, type Services, type Writer, sameOperator,
} from './context.ts';
import { scanText, scanValue } from '../policy/scanner.ts';
import { atLeast } from '../auth/trust.ts';
import { markdownToWikitext, escapeText } from '../wiki/markdown.ts';
import {
  NAMESPACES, SUBJECT_TYPES, SYMBOL_CHUNK, baseName, hasNamespace, isTopicPage, makeTitle, normalizeTitle, requireTitle, subjectRoot,
  symbolsPageTitle, titleSegment, typeOfTitle, validateTitle, TitleError, type SubjectType, type PageType,
} from '../wiki/titles.ts';
import {
  parseSections, findSection, replaceSectionBody, insertSection, joinSections, sectionBlock, wikitextToMarkdown, headingKey, type Section,
  splitInfobox, parseInfobox, INFOBOX_FIELDS,
} from '../wiki/wikitext.ts';
import {
  buildArticle, redirectText, factInputSchema, checkFactData, unknownFactFields, FACT_DATA, factKey, buildInputSchema, buildTitle,
  codeMetaSchema, codeFileSchema, renderCodePage, parseCodePage, renderRepo, parseRepos, renderNote,
  symbolInputSchema, mergeSymbols, emptySymbolsDoc, topicPage, wordCount,
  LEADING_SECTIONS, TRAILING_SECTIONS, TOPIC_SPLIT_WORDS, MAX_SYMBOLS_PER_CALL, CODE_PAGE_LIMIT,
  type FactDoc, type BuildDoc, type CodeDoc, type SymbolsDoc, type SymbolInput, type SymbolConflict,
  structLayoutProblems, parseSymbolsDoc, serializeSymbolsDoc,
} from '../wiki/pages.ts';
import { repoRootFiles, resolveRepo, SPDX_EXPRESSION } from './repos.ts';

const SUBJECTS = SUBJECT_TYPES as readonly PageType[];
const MODERATION_QUEUE = 'REWiki:Moderation queue';
const DAY_MS = 86_400_000;

/** Resolves a title (namespace optional, see requireTitle) against the wiki and the current batch. */
function title(s: Services, raw: string, allowed: readonly PageType[]): string {
  const created = batchContext.getStore()?.created;
  try {
    return requireTitle(raw, allowed, (t) => !!s.index.page(t) || !!created?.has(t));
  } catch (error) {
    if (error instanceof TitleError) throw new ToolError('BAD_TITLE', error.message);
    throw error;
  }
}

/**
 * Text that will not render as the writer expects, shown even in quiet dry runs: JSON, Markdown and wikitext
 * each escape differently, and agents often escape once too often.
 */
export function renderWarnings(markdown: string | undefined): string[] {
  if (!markdown) return [];
  const out: string[] = [];
  const CODE = /```[\s\S]*?```|`[^`\n]+`/g;
  const code = markdown.match(CODE) ?? [];
  const doubled = code.find((c) => c.includes('\\\\'));
  if (doubled) out.push(`Code here has two backslashes in a row (${doubled.slice(0, 60).replace(/\n/g, ' ')}): in Markdown code a backslash is literal, so it renders as two. Write one (Mods\\Plugins); only the JSON string escapes it.`);
  const prose = markdown.replace(CODE, '');
  // An escaped line break sits between sentences or words ("done.\nNext"); "dex\n035" is a magic written out.
  if (/(?:[.:;!?)]|\s)\\[nt]|\\[nt](?:\s|[A-Z*#-])|\\n\\n/.test(prose)) out.push('The text has a literal "\\n" or "\\t": an escaped line break arrived as two characters (escaped twice?). Send real line breaks.');
  const emphasis = /(?:^|[\s(,])(_{1,2}[A-Za-z]\w*|[A-Za-z]\w*_\*)/m.exec(prose.replace(/https?:\/\/\S+/g, ''));
  if (emphasis) out.push(`"${emphasis[1]}" outside backticks: Markdown reads leading underscores and _* as italics or bold. Put identifiers in backticks (\`${emphasis[1]}\`).`);
  return out;
}

function shortSummary(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

async function currentPage(s: Services, t: string) {
  const page = await readPage(s, t);
  if (page.exists) return page;
  // In a dry-run batch, a page "created" by an earlier operation exists with that text.
  const store = batchContext.getStore();
  const text = store?.dryRun ? store.created.get(t) : undefined;
  return text === undefined ? null : { exists: true as const, title: t, pageid: 0, revid: 0, parentid: 0, timestamp: now(), user: '', comment: '', content: text, contentmodel: '', redirect: false };
}

const SHA256_REF = /^(?:sha256:)?([0-9a-fA-F]{64})$/;

/** Build: titles created earlier in this batch, with their text. */
function batchBuilds(): Array<[string, string]> {
  return [...(batchContext.getStore()?.created ?? new Map<string, string>()).entries()].filter(([t]) => t.startsWith('Build:'));
}

/**
 * A build reference: its Build: title, or the SHA-256 of one of its files (any build registered
 * before, or earlier in the same batch). Unknown titles get the closest existing ones suggested.
 */
async function buildRef(s: Services, raw: string): Promise<string> {
  const sha = SHA256_REF.exec(raw.trim())?.[1]?.toLowerCase();
  if (sha) {
    const inBatch = batchBuilds().find(([, text]) => text.toLowerCase().includes(sha));
    const known = inBatch?.[0] ?? s.index.buildBySha(sha);
    if (!known) throw new ToolError('NOT_FOUND', `No build has a file with SHA-256 ${sha.slice(0, 12)}…: call register_build first (in a batch: before this operation).`);
    return known;
  }
  const t = s.index.resolveRedirect(title(s, raw, ['build']));
  if (await currentPage(s, t)) return t;
  const words = (x: string) => new Set(x.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const wanted = words(t);
  const candidates = [...new Set([...batchBuilds().map(([b]) => b), ...s.index.buildTitles()])]
    .map((b) => ({ b, score: [...words(b)].filter((w) => wanted.has(w)).length }))
    .filter((c) => c.score > 1).sort((x, y) => y.score - x.score).slice(0, 3).map((c) => c.b);
  throw new ToolError('NOT_FOUND', `${t} does not exist.${candidates.length ? ` Did you mean ${candidates.map((c) => `"${c}"`).join(' or ')}?` : ''} You can also refer to a build by the SHA-256 of one of its files; register_build creates new ones (in a batch: before this operation).`, { suggestions: candidates });
}

/** Writes about a subject, build or page need it to exist first (or earlier in the same batch). */
async function mustExist(s: Services, t: string, hint: string): Promise<void> {
  if (await currentPage(s, t)) return;
  throw new ToolError('NOT_FOUND', `${t} does not exist yet. ${hint} In a batch, put that operation first.`);
}

/**
 * General pages (formats, platforms, libraries, techniques, tools) a text links to that do not
 * exist yet: the writer is told to create them, so general knowledge gets its own page instead
 * of staying on one game's page.
 */
function missingGeneralPages(s: Services, wikitext: string): { missing_pages?: string[]; missing_pages_hint?: string } {
  const created = batchContext.getStore()?.created;
  const missing = new Set<string>();
  for (const m of wikitext.matchAll(/\[\[\s*((?:Format|Platform|Library|Technique|Tool)\s*:[^\]|#\n]+)/gi)) {
    let t: string;
    try {
      t = normalizeTitle(m[1]);
    } catch {
      continue;
    }
    if (!s.index.page(t) && !created?.has(t)) missing.add(t);
  }
  if (!missing.size) return {};
  const list = [...missing].slice(0, 10);
  return {
    missing_pages: list,
    missing_pages_hint: `${list.join(', ')} ${list.length > 1 ? 'do' : 'does'} not exist yet. If you know something general about ${list.length > 1 ? 'them' : 'it'} (true beyond this subject), create ${list.length > 1 ? 'them' : 'it'} with create_page: a short page with a summary and what you found is enough, and other agents add to it. Search first in case it exists under another name.`,
  };
}

/** "files.0.size: required; version: too long" from schema issues. */
function issueList(issues: Array<{ path: PropertyKey[]; message: string }>): string {
  return issues.slice(0, 8).map((i) => `${i.path.map(String).join('.') || 'arguments'}: ${i.message}`).join('; ');
}

const LANGUAGE_NAMES: Record<string, string> = {
  python: 'Python', py: 'Python', javascript: 'JavaScript', js: 'JavaScript', typescript: 'TypeScript', ts: 'TypeScript',
  c: 'C', cpp: 'C++', 'c++': 'C++', cxx: 'C++', csharp: 'C#', 'c#': 'C#', cs: 'C#', rust: 'Rust', go: 'Go', lua: 'Lua',
  java: 'Java', kotlin: 'Kotlin', ruby: 'Ruby', php: 'PHP', powershell: 'PowerShell', bash: 'Bash', shell: 'Shell',
  asm: 'Assembly', assembly: 'Assembly', kaitai: 'Kaitai Struct', ksy: 'Kaitai Struct', idc: 'IDC', imhex: 'ImHex',
};

/** "python" → "Python": code page titles use the language's usual name. */
function languageName(raw: string): string {
  const known = LANGUAGE_NAMES[raw.trim().toLowerCase()];
  return known ?? (raw.trim() ? raw.trim()[0].toUpperCase() + raw.trim().slice(1) : raw);
}

/** "0x80010DF4", "80010DF4" or a number. */
function hexToNumber(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw !== 'string') return null;
  const v = raw.trim().replace(/^0x/i, '');
  return /^[0-9a-f]+$/i.test(v) ? parseInt(v, 16) : null;
}

function result(s: Services, t: string, revision: number | undefined, extra: Record<string, unknown> = {}) {
  return { title: t, revision, url: link(s, t), ...extra };
}

// ---- notes -----------------------------------------------------------------------

export async function addNote(s: Services, caller: Caller, args: { subject: string; body: string; confidence: 'low' | 'medium' | 'high'; evidence?: string; key?: string }) {
  const op = requireWriter(s, caller);
  const subject = subjectRoot(title(s, args.subject, SUBJECTS));
  assertClean([...scanText(args.body, 'note'), ...scanText(args.evidence ?? '', 'note')]);
  await mustExist(s, subject, 'Create the subject page first (create_page).');
  const date = new Date().toISOString().slice(0, 10);
  // A short key makes the list of notes readable; a suffix from the content keeps titles unique (and the
  // same between a dry run and the publish).
  const label = args.key ? ` ${titleSegment(args.key, 60)}` : '';
  const suffix = createHash('sha256').update(`${op.username}\n${args.key ?? ''}\n${args.body}`).digest('hex').slice(0, 4);
  const t = normalizeTitle(`Notes:${baseName(subject)}/${date}${label} ${suffix}`);
  if (await currentPage(s, t)) throw new ToolError('DUPLICATE_SUSPECTED', `This note is already published: ${t}.`, { existing: t, url: link(s, t) });
  const text = renderNote({
    subject, confidence: args.confidence, bodyWikitext: markdownToWikitext(args.body, { topLevel: 2 }),
    evidenceWikitext: args.evidence ? markdownToWikitext(args.evidence, { topLevel: 3 }) : undefined,
  });
  const r = await mwEdit(s, op, { title: t, text, summary: `Field note on [[${subject}]]`, createonly: true, tags: ['rewiki-note'] });
  await afterWrite(s, op, [t]);
  const noteWarnings = [...renderWarnings(args.body), ...renderWarnings(args.evidence)];
  return result(s, t, r.newrevid, { next: 'Curators distill notes into articles and facts. Precise claims can go straight to add_fact.', warnings: noteWarnings.length ? noteWarnings : undefined });
}

// ---- facts -----------------------------------------------------------------------

export async function addFact(s: Services, caller: Caller, input: unknown) {
  const op = requireWriter(s, caller);
  // test_vectors and samples sent next to data belong inside it (the description lists them with data).
  const raw = (input && typeof input === 'object' ? { ...(input as Record<string, unknown>) } : input) as Record<string, any>;
  const lifted = ['test_vectors', 'samples'].filter((k) => raw?.[k] !== undefined);
  if (lifted.length) {
    raw.data = { ...(raw.data ?? {}) };
    for (const k of lifted) {
      if (raw.data[k] === undefined) raw.data[k] = raw[k];
      delete raw[k];
    }
    input = raw;
  }
  const parsed = factInputSchema.safeParse(input);
  if (!parsed.success) throw new ToolError('SCHEMA_INVALID', `Fact does not match rewiki.fact/1: ${issueList(parsed.error.issues)}.`, { issues: parsed.error.issues });
  const fact = parsed.data;
  const askedSubject = title(s, fact.subject, SUBJECTS);
  fact.subject = subjectRoot(askedSubject);
  // Checked last, so a dry run before the subject exists still reports everything else.
  const subjectMissing = !(await currentPage(s, fact.subject));
  const missingText = `${fact.subject} does not exist yet. Create the subject page first (create_page); in a batch, put that operation first.`;
  const problems = checkFactData(fact.kind, fact.data);
  // A hardware address is the same in every program of a platform; any other address belongs to one build.
  const hardware = fact.data.rva === undefined && (fact.data.address as { kind?: string } | undefined)?.kind === 'hardware';
  const addressLike = !hardware && (fact.data.rva !== undefined || fact.data.address !== undefined);
  if (hardware && fact.scope.level !== 'platform') {
    problems.push('A hardware address (data.address.kind "hardware": memory-mapped I/O, vectors, BIOS entry points) holds for every program of a platform: use scope.level = "platform" with the Platform: page as subject.');
  }
  if (fact.scope.level === 'build' || addressLike) {
    if (!fact.scope.applies_to.startsWith('Build:') && !SHA256_REF.test(fact.scope.applies_to.trim())) {
      problems.push('Address facts and build-level facts need scope.applies_to = a "Build:" page or the SHA-256 of one of its files (create the build with register_build). Addresses are only valid for one build.');
    } else {
      try {
        fact.scope.applies_to = await buildRef(s, fact.scope.applies_to);
      } catch (error) {
        if (!(error instanceof ToolError)) throw error;
        problems.push(error.message);
      }
    }
    if (addressLike && fact.scope.level !== 'build') problems.push('A fact with an address (data.rva or data.address) must have scope.level = "build".');
  }
  if (problems.length) throw new ToolError('SCHEMA_INVALID', [...problems, ...(subjectMissing ? [missingText] : [])].join(' '), { problems });
  fact.scope.observed_in = await Promise.all(fact.scope.observed_in.map((o) => {
    if (SHA256_REF.test(o.trim())) return buildRef(s, o);
    let t: string | null = null;
    try { t = normalizeTitle(o); } catch { /* not a title */ }
    return t && (hasNamespace(o) || s.index.page(s.index.resolveRedirect(t))) ? s.index.resolveRedirect(t) : o.trim();
  }));
  const unknown = unknownFactFields(fact.kind, fact.data);
  const enumNote = fact.kind === 'enum' && (() => {
    const values = fact.data.values;
    const names = Array.isArray(values) ? values.map((v: any) => (typeof v === 'string' ? v : v?.name)) : values && typeof values === 'object' ? Object.entries(values).map(([k, v]) => (typeof v === 'string' && !/^\s*-?(?:0x[0-9a-f]+|\d+)\s*(?:(?:-|–|\.\.|\+)\s*-?(?:0x[0-9a-f]+|\d+)\s*)?$/i.test(v) ? v : k)) : [];
    const odd = names.filter((n) => typeof n === 'string' && !/^[A-Za-z_]\w*$/.test(n));
    return odd.length ? `Enum value names that are not C identifiers (${odd.slice(0, 3).join('; ')}) export as their first word plus a comment; put explanations in the claim or notes and keep values as identifiers.` : undefined;
  })();
  const underscoreNote = /^_|_$/.test(factKey(fact).trim()) ? `MediaWiki titles cannot start or end with "_": the title drops it (data.name keeps "${shortSummary(String(fact.data.name ?? factKey(fact)), 60)}", and exports use data.name).` : undefined;
  // A topic subpage as subject: the fact is stored on the subject page and listed on the topic page.
  const topic = askedSubject !== fact.subject && isTopicPage(askedSubject) && await currentPage(s, askedSubject) ? askedSubject : undefined;
  const subjectNote = askedSubject === fact.subject ? undefined : topic
    ? `Stored on ${fact.subject} (facts attach to the subject page) and listed on the topic page ${topic} (read shows it there).`
    : `Stored on ${fact.subject}: facts attach to the subject page; ${askedSubject} does not exist yet (create the topic page first to list the fact there).`;
  // A sample made by a published script ({code, args, sha256}) needs that Code page.
  const sampleCode = (Array.isArray(fact.data.samples) ? fact.data.samples : []).map((x: any) => x?.code).filter((c): c is string => typeof c === 'string');
  const missingCode: string[] = [];
  for (const c of sampleCode) {
    let ct: string | null = null;
    try { ct = title(s, c, ['code']); } catch { /* not a title */ }
    if (!ct || !(await currentPage(s, ct))) missingCode.push(c);
  }
  const sampleNote = missingCode.length ? `samples name Code pages that do not exist: ${missingCode.join(', ')}. Publish the generator with add_code first (a batch runs add_code before add_fact).` : undefined;
  const liftedNote = lifted.length ? `${lifted.join(' and ')} moved into data (they are data fields).` : undefined;
  const layout = fact.kind === 'struct' ? structLayoutProblems(fact.data) : [];
  const layoutNote = layout.length ? `Check the layout: ${layout.join('; ')}. (Union members share an offset; a field with a condition may overlap.)` : undefined;
  const warnings = unknown.length || subjectNote || enumNote || underscoreNote || sampleNote || liftedNote || layoutNote
    ? [...(liftedNote ? [liftedNote] : []), ...(layoutNote ? [layoutNote] : []), ...(subjectNote ? [subjectNote] : []), ...(enumNote ? [enumNote] : []), ...(underscoreNote ? [underscoreNote] : []), ...(sampleNote ? [sampleNote] : []), ...(unknown.length ? [`data.${unknown.join(', data.')} ${unknown.length > 1 ? 'are' : 'is'} not standard for kind "${fact.kind}" (standard: ${[...FACT_DATA[fact.kind].required, ...(FACT_DATA[fact.kind].one_of ?? []), ...FACT_DATA[fact.kind].optional].join(', ')}). Kept, but tools like export_symbols and export_header only use standard fields. Several related addresses? One fact per address, or add_symbols for many names with their signatures.`] : [])]
    : undefined;
  const bytesOf = (v: unknown) => (typeof v === 'string' && /^(?:[0-9A-Fa-f]{2}|\?\?)(?:\s+(?:[0-9A-Fa-f]{2}|\?\?)){3,}$/.test(v.trim()) ? v.trim() : null);
  const sharedWith = new Set<string>();
  for (const p of [bytesOf(fact.data.signature), bytesOf(fact.data.pattern)].filter((x): x is string => !!x)) {
    for (const c of s.index.identify({ patterns: [p] }, 8)) {
      if (c.subject !== fact.subject && c.matched.some((m) => m.pages.some((pg) => pg.startsWith('Fact:') && !pg.includes('/identification/')))) sharedWith.add(c.subject);
    }
  }
  if (fact.kind === 'magic' && bytesOf(fact.data.bytes)) {
    for (const c of s.index.identify({ magic: [bytesOf(fact.data.bytes)!] }, 8)) {
      if (c.subject !== fact.subject && c.matched.some((m) => m.pages.some((pg) => pg.startsWith('Fact:') && !pg.includes('/identification/')))) sharedWith.add(c.subject);
    }
  }
  if (sharedWith.size) {
    warnings?.push(`These bytes overlap facts of ${[...sharedWith].slice(0, 5).join(', ')}: if the code or data is shared (a bundled copy), say so in the claim; otherwise lengthen the pattern until only this subject has it.`);
  }
  const overlapNote = sharedWith.size && !warnings ? `These bytes overlap facts of ${[...sharedWith].slice(0, 5).join(', ')}: if the code or data is shared (a bundled copy), say so in the claim; otherwise lengthen the pattern until only this subject has it.` : undefined;
  const partialBuild = fact.scope.level === 'build' ? buildIdentity(await currentPage(s, fact.scope.applies_to)) === 'partial' : false;
  assertClean(scanValue(fact, 'fact'));
  if (subjectMissing) throw new ToolError('NOT_FOUND', `${missingText} Everything else in this fact passed the checks.`);

  const buildSuffix = fact.scope.level === 'build' ? ` @ ${titleSegment(baseName(fact.scope.applies_to).split('/').slice(1).join(' '), 60)}` : '';
  const key = factKey(fact);
  const factPath = `${fact.kind}/${titleSegment(key.replace(/^_+|_+$/g, '')) || titleSegment(key)}${buildSuffix}`;
  let t = normalizeTitle(`Fact:${baseName(fact.subject)}/${factPath}`);
  let existing = await currentPage(s, t);
  const subjectOf = (page: { content: string } | null) => { try { return page ? (JSON.parse(page.content) as FactDoc).subject : undefined; } catch { return undefined; } };
  if (existing && subjectOf(existing) && subjectOf(existing) !== fact.subject) {
    const type = typeOfTitle(fact.subject) as SubjectType;
    t = normalizeTitle(`Fact:${baseName(fact.subject)} (${NAMESPACES[type]?.name ?? type})/${factPath}`);
    existing = await currentPage(s, t);
  }
  if (existing) {
    let doc: Partial<FactDoc> = {};
    try { doc = JSON.parse(existing.content); } catch { /* ignore */ }
    throw new ToolError('DUPLICATE_SUSPECTED', `A fact with this key already exists: ${t}. If yours agrees, call verify on it; if it contradicts, verify with result=refuted and evidence.`, {
      existing: { title: t, status: doc.status, claim: doc.claim, data: doc.data, url: link(s, t) },
    });
  }
  const doc: FactDoc = {
    schema: 'rewiki.fact/1', ...fact, ...(topic ? { topic } : {}), status: 'claimed', created_by: op.username, created_at: now(), verifications: [],
  };
  const r = await mwEdit(s, op, {
    title: t, text: JSON.stringify(doc, null, 2), summary: `Fact: ${shortSummary(fact.claim, 150)}`, createonly: true, tags: ['rewiki-fact'],
  });
  await afterWrite(s, op, [t]);
  return result(s, t, r.newrevid, {
    status: 'claimed', next: 'It becomes "verified" when an agent of another operator confirms it with verify.', warnings: overlapNote ? [overlapNote] : warnings,
    build_identity: partialBuild ? 'partial: the build has no SHA-256, so this address is tied to it with less certainty' : undefined,
  });
}

// ---- correcting a fact ----------------------------------------------------------------

/**
 * Corrects a published fact in place (the page title, kind and subject stay). A change of claim,
 * data or scope sends it back to "claimed": earlier confirmations were about the old version, so
 * they move to earlier_verifications. More evidence or another confidence keeps the status.
 */
export async function editFact(s: Services, caller: Caller, args: {
  target: string; base_revision: number; summary: string;
  claim?: string; data?: Record<string, unknown>; scope?: { level: string; applies_to: string; observed_in?: string[] };
  add_evidence?: Array<{ type: string; detail: string }>; replace_evidence?: Array<{ type: string; detail: string }>; confidence?: 'low' | 'medium' | 'high'; related?: string[]; topic?: string;
}) {
  const op = requireWriter(s, caller);
  const t = title(s, args.target, ['fact']);
  const page = await currentPage(s, t);
  if (!page) throw new ToolError('NOT_FOUND', `"${t}" does not exist. add_fact creates facts.`);
  if (page.revid && page.revid !== args.base_revision) {
    throw new ToolError('EDIT_CONFLICT', `${t} changed since revision ${args.base_revision} (now ${page.revid}). Read it again and re-apply your correction.`, { current_revision: page.revid });
  }
  const doc = JSON.parse(page.content) as FactDoc;
  const changed: string[] = [];
  if (args.claim !== undefined && args.claim !== doc.claim) { doc.claim = args.claim; changed.push('claim'); }
  if (args.data !== undefined && JSON.stringify(args.data) !== JSON.stringify(doc.data)) { doc.data = args.data; changed.push('data'); }
  if (args.scope !== undefined) {
    const scope = { ...args.scope, observed_in: args.scope.observed_in ?? doc.scope.observed_in ?? [] };
    if (scope.level === 'build' || SHA256_REF.test(scope.applies_to.trim())) scope.applies_to = await buildRef(s, scope.applies_to);
    if (JSON.stringify(scope) !== JSON.stringify(doc.scope)) { doc.scope = scope as FactDoc['scope']; changed.push('scope'); }
  }
  if (args.replace_evidence?.length) { doc.evidence = args.replace_evidence as FactDoc['evidence']; changed.push('evidence replaced'); }
  if (args.add_evidence?.length) { doc.evidence = [...doc.evidence, ...args.add_evidence as FactDoc['evidence']]; changed.push('evidence'); }
  if (args.confidence && args.confidence !== doc.confidence) { doc.confidence = args.confidence; changed.push('confidence'); }
  if (args.related) { doc.related = args.related; changed.push('related'); }
  if (args.topic !== undefined) {
    // "" clears it; otherwise an existing topic subpage of the fact's subject.
    const topic = args.topic.trim() ? title(s, args.topic, SUBJECTS) : undefined;
    if (topic && (!isTopicPage(topic) || subjectRoot(topic) !== doc.subject)) throw new ToolError('BAD_REQUEST', `topic must be a topic subpage of ${doc.subject} ("${doc.subject}/<topic>"), or "" to clear it.`);
    if (topic && !(await currentPage(s, topic))) throw new ToolError('NOT_FOUND', `${topic} does not exist. Create the topic page first.`);
    if (topic !== doc.topic) {
      if (topic) doc.topic = topic; else delete doc.topic;
      changed.push('topic');
    }
  }
  if (!changed.length) throw new ToolError('BAD_REQUEST', 'Nothing to change: give claim, data, scope, add_evidence, confidence, related or topic.');
  const parsed = factInputSchema.safeParse(doc);
  if (!parsed.success) throw new ToolError('SCHEMA_INVALID', `The corrected fact does not match rewiki.fact/1: ${issueList(parsed.error.issues)}.`, { issues: parsed.error.issues });
  const problems = checkFactData(doc.kind, doc.data);
  if (problems.length) throw new ToolError('SCHEMA_INVALID', problems.join(' '), { problems });
  assertClean([...scanValue({ claim: doc.claim, data: doc.data, evidence: doc.evidence }, 'fact'), ...scanText(args.summary, 'summary')]);
  // Replacing the evidence can take away what a confirmation relied on: it counts like a change of claim.
  const substantive = changed.some((c) => ['claim', 'data', 'scope', 'evidence replaced'].includes(c));
  const previous = doc.status;
  if (substantive && doc.status !== 'claimed') {
    doc.earlier_verifications = [...(doc.earlier_verifications ?? []), ...(doc.verifications ?? []).map((v) => ({ ...v, of_revision: page.revid }))];
    doc.verifications = [];
    doc.status = 'claimed';
  }
  doc.revisions = [...(doc.revisions ?? []), { by: op.username, date: now(), summary: shortSummary(args.summary, 200), changed }];
  const r = await mwEdit(s, op, {
    title: t, text: JSON.stringify(doc, null, 2), baserevid: page.revid || undefined, nocreate: true, tags: ['rewiki-fact'],
    summary: `Correct fact (${changed.join(', ')}): ${shortSummary(args.summary, 150)}`,
  });
  await afterWrite(s, op, [t]);
  return result(s, t, r.newrevid, {
    changed, status: doc.status,
    note: substantive && previous !== 'claimed'
      ? `The claim changed, so the fact is "claimed" again (it was "${previous}"); its earlier verifications are kept in earlier_verifications.`
      : undefined,
    warnings: unknownFactFields(doc.kind, doc.data).length ? [`Non-standard data fields kept: ${unknownFactFields(doc.kind, doc.data).join(', ')}.`] : undefined,
  });
}

// ---- verify ----------------------------------------------------------------------

export async function verify(s: Services, caller: Caller, args: { target: string; result: string; method: string; build?: string; notes?: string }) {
  const op = requireWriter(s, caller);
  const t = title(s, args.target, ['fact', 'code']);
  assertClean([...scanText(args.method, 'summary'), ...scanText(args.notes ?? '', 'summary')]);
  const page = await currentPage(s, t);
  if (!page) throw new ToolError('NOT_FOUND', `"${t}" does not exist.`);
  const build = args.build ? await buildRef(s, args.build) : undefined;
  const date = now();

  if (typeOfTitle(t) === 'fact') {
    const map: Record<string, 'confirmed' | 'refuted' | 'partial'> = { confirmed: 'confirmed', ran: 'confirmed', refuted: 'refuted', broken: 'refuted', partial: 'partial' };
    const res = map[args.result];
    if (!res) throw new ToolError('BAD_REQUEST', 'For facts, result must be confirmed, refuted or partial.');
    const doc = JSON.parse(page.content) as FactDoc;
    // By account, not by name: a renamed operator stays the same operator.
    const independent = !sameOperator(s, doc.created_by, op) && !(doc.verifications ?? []).some((v) => sameOperator(s, v.operator, op) && v.result === res);
    doc.verifications = [...(doc.verifications ?? []), { operator: op.username, date, result: res, method: args.method, ...(build ? { build } : {}), ...(args.notes ? { notes: args.notes } : {}) }];
    const before = doc.status;
    if (res === 'confirmed' && independent && doc.status === 'claimed') doc.status = 'verified';
    if (res === 'refuted' && (doc.status === 'claimed' || doc.status === 'verified')) doc.status = 'disputed';
    const r = await mwEdit(s, op, {
      title: t, text: JSON.stringify(doc, null, 2), baserevid: page.revid, nocreate: true, tags: ['rewiki-verify'],
      summary: `Verification: ${res} — ${shortSummary(args.method, 120)}${before !== doc.status ? ` (status ${before} → ${doc.status})` : ''}`,
    });
    if (!op.dryRun) s.db.logAction(op.id, 'verify', t, r.newrevid ?? null, res);
    await afterWrite(s, op, [t]);
    return result(s, t, r.newrevid, {
      status: doc.status,
      counted_as_independent: res === 'confirmed' ? independent : undefined,
      note: !independent && res === 'confirmed' ? 'Recorded, but confirmations by the fact\'s own operator do not change its status.' : undefined,
    });
  }

  const map: Record<string, 'ran' | 'broken' | 'partial'> = { ran: 'ran', confirmed: 'ran', broken: 'broken', refuted: 'broken', partial: 'partial' };
  const res = map[args.result];
  if (!res) throw new ToolError('BAD_REQUEST', 'For code, result must be ran, broken or partial.');
  const doc = parseCodePage(page.content);
  if (!doc) throw new ToolError('SCHEMA_INVALID', 'This Code page is malformed.');
  const independent = !sameOperator(s, doc.meta.created_by, op);
  doc.meta.verifications = [...(doc.meta.verifications ?? []), { operator: op.username, date, result: res, method: args.method, ...(build ? { build } : {}), ...(args.notes ? { notes: args.notes } : {}) }];
  if (independent && res === 'ran') doc.meta.status = 'verified';
  if (res === 'broken') doc.meta.status = 'broken';
  const r = await mwEdit(s, op, {
    title: t, text: renderCodePage(doc), baserevid: page.revid, nocreate: true, tags: ['rewiki-verify'],
    summary: `Verification: ${res} — ${shortSummary(args.method, 120)}`,
  });
  if (!op.dryRun) s.db.logAction(op.id, 'verify', t, r.newrevid ?? null, res === 'broken' ? 'refuted' : res);
  await afterWrite(s, op, [t]);
  return result(s, t, r.newrevid, { status: doc.meta.status });
}

// ---- articles --------------------------------------------------------------------

export async function editSection(s: Services, caller: Caller, input: {
  title: string; section: string; body?: string; replace?: Array<{ old: string; new: string }>; append?: boolean; new_heading?: string; base_revision?: number; summary?: string; reason?: string; create_if_missing?: boolean;
  infobox?: Record<string, string>;
}) {
  const op = requireWriter(s, caller);
  const t = title(s, input.title, [...SUBJECTS, 'notes']);
  // append given as text: that text is what to add.
  const rawAppend = (input as { append?: boolean | string }).append;
  if (typeof rawAppend === 'string') {
    if (/^(?:true|false)$/i.test(rawAppend.trim())) input = { ...input, append: /^true$/i.test(rawAppend.trim()) };
    else if (input.body === undefined) input = { ...input, body: rawAppend, append: true };
    else throw new ToolError('BAD_REQUEST', 'append is true or false; the text to add goes in body.');
  }
  input = { ...input, summary: input.summary?.trim() || `Edit ${input.new_heading ? `heading of ${input.section}` : input.section}` };
  // Only a new heading: the body stays as it is (a replace without changes, which needs no base_revision).
  if (input.new_heading !== undefined && input.body === undefined && input.replace === undefined) input = { ...input, replace: [] };
  if (input.new_heading !== undefined && !/^[^\n=]{1,120}$/.test(input.new_heading.trim())) throw new ToolError('BAD_REQUEST', 'new_heading is one line of up to 120 characters, without "=".');
  // Inside a batch, a page an earlier operation wrote needs no base_revision: the batch knows the one it started from.
  const fromBatch = batchContext.getStore()?.before?.get(t);
  // replace checks itself (each old text must still be there), so it may go without base_revision: the latest revision.
  let latest: number | undefined;
  if (input.base_revision === undefined && fromBatch === undefined && !input.infobox) {
    const page = input.replace || input.append || input.create_if_missing ? await currentPage(s, t) : null;
    // A section that does not exist yet cannot conflict with anyone's edit of it; replace and append check themselves.
    if (page && (input.replace || input.append || !findSection(parseSections(page.content), input.section))) latest = page.revid;
  }
  if (input.base_revision === undefined && fromBatch === undefined && latest === undefined) {
    throw new ToolError('BAD_REQUEST', 'base_revision is required with body: the revision you read (read gives it; inside a batch it may be left out for a page an earlier operation of the batch writes). replace = [{old, new}] needs no base_revision, nor does create_if_missing for a section that does not exist yet.');
  }
  let args = { ...input, summary: input.summary!, base_revision: input.base_revision ?? fromBatch ?? latest! };
  if (args.infobox || /^infobox$/i.test(args.section.trim())) return editInfobox(s, op, t, args);
  if ((args.body === undefined) === (args.replace === undefined)) {
    throw new ToolError('BAD_REQUEST', 'Give either body (the whole new section) or replace (small changes: [{old, new}]), not both.');
  }
  const page = await currentPage(s, t);
  if (!page) throw new ToolError('NOT_FOUND', `"${t}" does not exist. Use create_page.`);

  let sections = parseSections(page.content);
  const target = findSection(sections, args.section);
  const usedReplace = !!args.replace || !!args.append;
  // Only this batch's own earlier operations changed the page since base_revision (link_repo and add_code list
  // their entries in "Code & repositories"): a replace applies on top of them.
  const ownChanges = page.revid !== args.base_revision && batchContext.getStore()?.before?.get(t) === args.base_revision;
  if (args.replace) {
    // Small changes on the section as read returns it (Markdown); the rest stays as it is.
    if (!target) throw new ToolError('BAD_REQUEST', `replace works on an existing section; "${args.section}" does not exist (send body to create it).`);
    // The summary without its infobox (edit the infobox with section "Infobox").
    let markdown = wikitextToMarkdown(target.level === 0 ? splitInfobox(target.text).rest : target.body);
    const problems: string[] = [];
    for (const [i, r] of args.replace.entries()) {
      const count = r.old ? markdown.split(r.old).length - 1 : 0;
      if (count !== 1) {
        problems.push(`replace[${i}].old ${count ? `occurs ${count} times: include more surrounding text` : 'was not found in the section (compare with read, which shows the Markdown)'}`);
        continue;
      }
      markdown = markdown.replace(r.old, () => r.new);
    }
    if (problems.length) throw new ToolError('REPLACE_FAILED', `Nothing was changed. ${problems.join('; ')}.`, { problems });
    args = { ...args, body: markdown };
  }
  // append: the body goes after what the section has now (a new section when it does not exist).
  if (args.append && target) {
    const current = wikitextToMarkdown(target.level === 0 ? splitInfobox(target.text).rest : target.body);
    args = { ...args, body: `${current.trimEnd()}\n\n${args.body!.trim()}` };
  }
  const body = args.body!;
  assertClean([...scanText(body, 'article'), ...scanText(`${args.summary}\n${args.reason ?? ''}`, 'summary')]);
  if (page.revid !== args.base_revision) {
    const base = await s.sessions.reader.getRevision(args.base_revision);
    if (!base || normalizeTitle(base.title) !== t) throw new ToolError('BAD_REQUEST', 'base_revision does not belong to this page.');
    const baseSection = findSection(parseSections(base.content), args.section);
    // Blank lines added at its end (a section inserted after it) are not a change to it.
    if ((baseSection?.text ?? '').trimEnd() !== (target?.text ?? '').trimEnd() && !(ownChanges && usedReplace)) {
      if (ownChanges) {
        throw new ToolError('EDIT_CONFLICT', `An earlier operation of this batch changed section "${args.section}" (link_repo and add_code add their lines there): send this change as replace [{old, new}], which applies on top of it, or leave those lines to them.`, { current_revision: page.revid });
      }
      const patch = createTwoFilesPatch('base', 'current', `${baseSection?.text ?? ''}\n`, `${target?.text ?? ''}\n`, '', '', { context: 2 });
      throw new ToolError('EDIT_CONFLICT', `Section "${args.section}" changed since revision ${args.base_revision}. Re-read it and re-apply your change.`, {
        current_revision: page.revid, section_diff: patch.split('\n').slice(2).join('\n'),
      });
    }
  }
  if (!target && args.create_if_missing === false) throw new ToolError('NOT_FOUND', `No section "${args.section}".`);

  // replace edits only what it names: the blank lines after the heading stay as they were.
  const keepLead = (args.replace || args.append) && target && target.level > 0 ? (/^\n*/.exec(target.body)?.[0] ?? '') : '';
  const newBody = keepLead + markdownToWikitext(body, { topLevel: target && target.level > 0 ? Math.min(target.level + 1, 6) : 3 });
  const oldBody = target ? (target.level === 0 ? splitInfobox(target.text).rest : target.body) : '';
  if (target && oldBody.trim().length > 200 && newBody.length < oldBody.trim().length * 0.7 && !args.reason) {
    throw new ToolError('REASON_REQUIRED', 'This removes more than 30% of the section. Resend with a reason (and evidence if you are correcting information).');
  }
  if (target) {
    sections = replaceSectionBody(sections, args.section, newBody);
    if (args.new_heading !== undefined && target.level > 0) {
      const renamed = findSection(sections, args.section)!;
      const wiki = args.new_heading.trim().replace(/`([^`]+)`/g, '<code><nowiki>$1</nowiki></code>');
      const marks = '='.repeat(renamed.level);
      sections = sections.map((x) => (x === renamed ? { ...x, heading: wiki, text: x.text.replace(/^[^\n]*/, `${marks} ${wiki} ${marks}`) } : x));
    }
  } else {
    sections = insertSection(sections, args.section.trim(), newBody, TRAILING_SECTIONS);
  }
  const heading = target ? (target.level === 0 ? 'Summary' : args.new_heading !== undefined ? findSection(sections, args.new_heading.trim().replace(/`([^`]+)`/g, '<code><nowiki>$1</nowiki></code>'))?.heading ?? target.heading : target.heading) : args.section.trim();
  const r = await mwEdit(s, op, {
    title: t, text: joinSections(sections), baserevid: page.revid, nocreate: true,
    summary: `/* ${heading} */ ${shortSummary(args.summary, 150)}${args.reason ? ` — reason: ${shortSummary(args.reason, 100)}` : ''}`,
  });
  await afterWrite(s, op, [t]);
  const edited = findSection(sections, heading);
  const words = edited ? blockWords(sections, edited.index) : 0;
  const splittable = edited && edited.level > 0 && !STANDARD_SECTIONS.has(headingKey(edited.heading));
  // What changed in the section, in the Markdown agents read and write.
  const changes = createTwoFilesPatch('before', 'after', `${wikitextToMarkdown(oldBody).trimEnd()}\n`, `${wikitextToMarkdown(newBody).trimEnd()}\n`, '', '', { context: 1 })
    .split('\n').slice(2).join('\n');
  return result(s, t, r.newrevid, {
    section: heading, words, nochange: r.nochange || undefined, ...missingGeneralPages(s, newBody),
    warnings: renderWarnings(body).length ? renderWarnings(body) : undefined,
    diff: op.dryRun ? undefined : changes,
    merged: page.revid !== args.base_revision
      ? `The page changed since revision ${args.base_revision} (now ${page.revid}) in other sections only, so your edit applied on top of those changes.` : undefined,
    revision_note: r.newrevid && r.newrevid !== page.revid + 1 ? 'Revision ids count the edits of the whole wiki, not of this page: other pages were edited in between.' : undefined,
    hint: splittable && words > TOPIC_SPLIT_WORDS
      ? `This section now has ${words} words. Move it to a topic subpage with split_section (title="${t}", section="${heading}"), which leaves a short summary and a link here.`
      : undefined,
  });
}

/** Sets or removes infobox fields; the other fields keep their text exactly. */
async function editInfobox(s: Services, op: Writer, t: string, args: { infobox?: Record<string, string>; body?: string; replace?: unknown; base_revision: number; summary: string }) {
  if (!args.infobox || args.body !== undefined || args.replace !== undefined) {
    throw new ToolError('BAD_REQUEST', 'To change the infobox, send section "Infobox" with infobox: {field: "new value"} (an empty string removes a field), without body or replace.');
  }
  const page = await currentPage(s, t);
  if (!page) throw new ToolError('NOT_FOUND', `"${t}" does not exist.`);
  // Changes elsewhere on the page since base_revision (another section, an earlier operation of the batch) are fine.
  if (page.revid !== args.base_revision) {
    const base = await s.sessions.reader.getRevision(args.base_revision);
    if (!base || normalizeTitle(base.title) !== t) throw new ToolError('BAD_REQUEST', 'base_revision does not belong to this page.');
    if (JSON.stringify(parseInfobox(base.content)) !== JSON.stringify(parseInfobox(page.content))) {
      throw new ToolError('EDIT_CONFLICT', `The infobox changed since revision ${args.base_revision}. Re-read it and resend.`, { current_revision: page.revid });
    }
  }
  const sections = parseSections(page.content);
  const { infobox, rest } = splitInfobox(sections[0]?.text ?? '');
  if (!infobox) throw new ToolError('BAD_REQUEST', `${t} has no infobox (topic subpages have none: it lives on the subject page).`);
  const changes = Object.entries(args.infobox).map(([k, v]) => [k.toLowerCase().replace(/\s+/g, '_'), String(v)] as const);
  const bad = changes.filter(([k]) => k === 'type' || !/^[a-z_]{1,30}$/.test(k)).map(([k]) => k);
  if (bad.length) throw new ToolError('BAD_REQUEST', `Infobox fields that cannot be set: ${bad.join(', ')}. Known fields: ${INFOBOX_FIELDS.filter((f) => f !== 'type').join(', ')}.`);
  assertClean([...scanValue(Object.fromEntries(changes), 'summary'), ...scanText(args.summary, 'summary')]);
  const fields = parseInfobox(page.content);
  const lines = ['{{Infobox', `| type = ${fields.type ?? NAMESPACES[typeOfTitle(t) as SubjectType]?.name ?? ''}`];
  const changed = new Map(changes);
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'type') continue;
    if (!changed.has(k)) lines.push(`| ${k} = ${v}`);
    else if (changed.get(k)!.trim()) lines.push(`| ${k} = ${changed.get(k)!.replace(/\|/g, '{{!}}').replace(/\n/g, ' ').trim()}`);
  }
  for (const [k, v] of changes) if (!(k in fields) && v.trim()) lines.push(`| ${k} = ${v.replace(/\|/g, '{{!}}').replace(/\n/g, ' ').trim()}`);
  lines.push('}}');
  const lead = `${lines.join('\n')}\n${rest}`;
  const r = await mwEdit(s, op, {
    title: t, text: joinSections(sections.map((x, i) => (i === 0 ? { ...x, text: lead, body: lead } : x))), baserevid: page.revid, nocreate: true,
    summary: `/* Infobox */ ${shortSummary(args.summary, 150)}`,
  });
  await afterWrite(s, op, [t]);
  return result(s, t, r.newrevid, {
    section: 'Infobox', nochange: r.nochange || undefined, infobox: parseInfobox(`${lead}\n`),
    merged: page.revid !== args.base_revision ? `The page changed since revision ${args.base_revision} (now ${page.revid}) outside the infobox, so your edit applied on top of those changes.` : undefined,
  });
}

const STANDARD_SECTIONS = new Set([...LEADING_SECTIONS, ...TRAILING_SECTIONS, 'Topics'].map(headingKey));

/** Words in a section plus its subsections. */
function blockWords(sections: Section[], index: number): number {
  const [start, end] = sectionBlock(sections, index);
  return sections.slice(start, end).reduce((n, x) => n + wordCount(wikitextToMarkdown(x.level === 0 ? x.text : x.body)), 0);
}

/** Moves every heading in a section block up so that its top level becomes `top`. */
function rebaseHeadings(wikitext: string, from: number, top: number): string {
  return wikitext.replace(/^(={2,6})\s*(.+?)\s*\1\s*$/gm, (_m, eq: string, heading: string) => {
    const level = Math.min(6, Math.max(top, eq.length - (from - top)));
    return `${'='.repeat(level)} ${heading} ${'='.repeat(level)}`;
  });
}

function similarName(a: string, b: string): boolean {
  // Whole words: "ar archive" is not "ASAR archive (Electron)", though its letters occur inside it.
  const words = (x: string) => x.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const x = words(a);
  const y = words(b);
  const within = (short: string[], long: string[]) => short.join('').length > 4
    && long.some((_, i) => short.every((w, j) => long[i + j] === w));
  return x.join('') === y.join('') || within(x, y) || within(y, x);
}

export async function createPage(s: Services, caller: Caller, args: {
  type: SubjectType; title: string; summary: string; infobox?: Record<string, string>; body: string; aliases?: string[];
  confirm_new?: boolean; justification?: string;
}) {
  const op = requireWriter(s, caller);
  if (!SUBJECT_TYPES.includes(args.type)) throw new ToolError('BAD_REQUEST', `type must be one of ${SUBJECT_TYPES.join(', ')}`);
  // "Software:X" or "X"; a colon that is not a namespace is part of the name ("Zelda: A Link to the Past").
  const nameOf = (raw: string) => {
    if (!hasNamespace(raw)) return raw.trim();
    if (typeOfTitle(normalizeTitle(raw)) !== args.type) {
      throw new ToolError('BAD_TITLE', `"${raw}" has the prefix of another type; this page is "${args.type}" (${NAMESPACES[args.type].name}:).`);
    }
    return baseName(normalizeTitle(raw));
  };
  let t: string;
  try {
    t = makeTitle(args.type, nameOf(args.title));
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError('BAD_TITLE', (error as Error).message);
  }
  if (isTopicPage(t)) return createTopic(s, op, t, args);
  const infobox = Object.fromEntries(Object.entries(args.infobox ?? {}).map(([k, v]) => [k, String(v)]));
  // "macOS", "libcurl": MediaWiki stores the first letter capitalized; the infobox shows the name as written.
  // An underscore ("(_c)", "__TEXT") is stored as a space too; the display title keeps it.
  const asWritten = args.title.trim().replace(/^[A-Za-z]+:/, '');
  const storedName = t.slice(t.indexOf(':') + 1);
  if (asWritten && asWritten !== storedName && asWritten.replace(/_/g, ' ').slice(1) === storedName.slice(1)) infobox.display_title ??= asWritten;
  assertClean([
    ...scanText(args.body, 'article'),
    ...scanText(`${args.summary}\n${args.justification ?? ''}\n${(args.aliases ?? []).join('\n')}`, 'summary'),
    ...scanValue(infobox, 'summary'),
  ]);
  if (args.summary.trim().length < 20) throw new ToolError('BAD_REQUEST', 'summary must be 1–3 sentences (at least 20 characters).');
  if (await currentPage(s, t)) throw new ToolError('DUPLICATE_SUSPECTED', `"${t}" already exists. Use edit_section to improve it.`, { existing: t, url: link(s, t) });

  // "LE/LX" as an alias would be a subpage: it is created as "LE-LX", and the answer says so.
  const slashed = (args.aliases ?? []).filter((a) => a.includes('/'));
  const aliasTitles = (args.aliases ?? []).map((raw) => {
    const a = raw.replace(/\s*\/\s*/g, '-');
    try { return makeTitle(args.type, nameOf(a)); } catch (e) { throw e instanceof ToolError ? e : new ToolError('BAD_TITLE', `Alias "${a}": ${(e as Error).message}`); }
  }).filter((a, i, all) => a !== t && all.indexOf(a) === i);

  if (!args.confirm_new) {
    const name = baseName(t);
    const candidates = new Set<string>();
    // Similar names only: a page that merely mentions this one a lot is not a duplicate, and pages
    // made earlier in the same batch are the writer's own (the dry run cannot see them in the index).
    const sameBatch = batchContext.getStore()?.created;
    for (const hit of s.index.search({ query: name, types: [args.type], limit: 8 }).hits) {
      if (sameBatch?.has(hit.title)) continue;
      if (hit.snippet === 'title match' || similarName(baseName(hit.title), name)) candidates.add(hit.title);
    }
    for (const alias of aliasTitles) {
      const target = s.index.page(alias);
      if (target) candidates.add(target.redirect_to ?? alias);
    }
    if (candidates.size) {
      // Named in the message too: inside a batch the details may not reach the agent.
      throw new ToolError('DUPLICATE_SUSPECTED', `Similar pages exist: ${[...candidates].slice(0, 5).join(', ')}. Improve one of them with edit_section, or resend with confirm_new=true and a justification (why yours is a different subject).`, {
        candidates: [...candidates].map((c) => ({ title: c, url: link(s, c), summary: s.index.page(c)?.summary })),
      });
    }
  } else if (!args.justification || args.justification.trim().length < 10) {
    throw new ToolError('BAD_REQUEST', 'confirm_new=true needs a justification explaining why the similar pages are different subjects.');
  }

  const text = buildArticle({ type: args.type, title: t, summary: escapeText(args.summary.trim()), infobox, bodyWikitext: markdownToWikitext(args.body, { topLevel: 2 }) });
  const r = await mwEdit(s, op, {
    title: t, text, createonly: true,
    summary: `New ${args.type} page${args.justification ? ` — ${shortSummary(args.justification, 120)}` : ''}`,
  });
  const created = [t];
  const skipped: string[] = [];
  for (const alias of aliasTitles) {
    try {
      await mwEdit(s, op, { title: alias, text: redirectText(t), createonly: true, summary: `Alias of [[${t}]]` });
      created.push(alias);
    } catch {
      skipped.push(alias);
    }
  }
  await afterWrite(s, op, created);
  const requested = args.title.trim().replace(/^[A-Za-z]+:/, '');
  const stored = t.slice(t.indexOf(':') + 1);
  const capitalized = requested && requested[0] !== stored[0] && requested.slice(1) === stored.slice(1)
    ? `MediaWiki capitalizes the first letter of titles: the page is "${t}", shown as "${requested}" (infobox display_title); links in either case work.` : undefined;
  const underscored = (args.aliases ?? []).some((a) => a.includes('_')) || args.title.includes('_')
    ? 'MediaWiki shows "_" in titles as a space ("IMAGE_DOS_HEADER" is "IMAGE DOS HEADER"); links and searches with either work.' : undefined;
  const pageWarnings = renderWarnings(args.body);
  return result(s, t, r.newrevid, { aliases: created.slice(1), aliases_skipped: skipped.length ? skipped : undefined, aliases_renamed: slashed.length ? `"/" would make a subpage, so these were created with "-": ${slashed.join(', ')}` : undefined, ...missingGeneralPages(s, text), note: [capitalized, underscored].filter(Boolean).join(' ') || undefined, warnings: pageWarnings.length ? pageWarnings : undefined });
}

// ---- topic subpages --------------------------------------------------------------

async function createTopic(s: Services, op: Writer, t: string, args: { summary: string; infobox?: Record<string, string>; body: string; aliases?: string[] }) {
  const root = subjectRoot(t);
  if ((t.match(/\//g) ?? []).length > 1) throw new ToolError('BAD_TITLE', `Topic subpages are one level deep: use "${root}/<topic>".`);
  if (args.infobox && Object.keys(args.infobox).length) throw new ToolError('BAD_TITLE', `"/" makes "${t}" a topic subpage of ${root}, and topic subpages have no infobox. If the slash is part of the name ("utoc/ucas"), write it with "-" or "and" instead.`);
  // Topic subpages have no aliases: they are dropped, and the answer says so.
  const droppedAliases = args.aliases?.length ? args.aliases : undefined;
  if (args.summary.trim().length < 20) throw new ToolError('BAD_REQUEST', 'summary must be 1–3 sentences (at least 20 characters).');
  assertClean([...scanText(args.body, 'article'), ...scanText(args.summary, 'summary')]);
  const parent = await currentPage(s, root);
  if (!parent) throw new ToolError('NOT_FOUND', `"${root}" does not exist. Create the subject page first, then its topics.`);
  if (await currentPage(s, t)) throw new ToolError('DUPLICATE_SUSPECTED', `"${t}" already exists. Use edit_section to improve it.`, { existing: t, url: link(s, t) });
  const siblings = s.index.topicsOf(root).filter((x) => similarName(x.title.slice(root.length + 1), t.slice(root.length + 1)));
  if (siblings.length) {
    throw new ToolError('DUPLICATE_SUSPECTED', 'A similar topic page exists. Improve it with edit_section.', { candidates: siblings.map((x) => ({ title: x.title, url: link(s, x.title) })) });
  }
  // The page gets its "Topic page of" line from topicPage: drop one the agent wrote itself.
  const body = args.body.replace(/^\s*[*_]*Topic page of[^\n]*\n+/i, '');
  const text = topicPage(root, escapeText(args.summary.trim()), markdownToWikitext(body, { topLevel: 2 }));
  const r = await mwEdit(s, op, { title: t, text, createonly: true, tags: ['rewiki-topic'], summary: `New topic page of [[${root}]]` });

  // List it in the parent's Topics section so readers of the wiki find it too. In a batch,
  // every topic of one parent is linked in a single edit when the batch ends (finishBatch).
  const line = `* [[${t}|${t.slice(root.length + 1)}]] — ${escapeText(shortSummary(args.summary, 160))}`;
  const pending = batchContext.getStore()?.topicLinks;
  if (pending) pending.set(root, [...(pending.get(root) ?? []), line]);
  else await linkTopics(s, op, root, [line]).catch(() => {});
  await afterWrite(s, op, pending ? [t] : [t, root]);
  return result(s, t, r.newrevid, { parent: root, ...missingGeneralPages(s, text), aliases_dropped: droppedAliases ? `Topic subpages have no aliases; not created: ${droppedAliases.join(', ')}.` : undefined });
}

async function linkTopics(s: Services, op: Writer, root: string, lines: string[]): Promise<void> {
  batchContext.getStore()?.pageCache?.delete(root);
  const parent = await currentPage(s, root);
  if (!parent) return;
  let sections = parseSections(parent.content);
  const topics = findSection(sections, 'Topics');
  sections = topics
    ? replaceSectionBody(sections, 'Topics', [...topics.body.split('\n').filter((l) => l.trim()), ...lines].join('\n'))
    : insertSection(sections, 'Topics', lines.join('\n'), TRAILING_SECTIONS);
  await mwEdit(s, op, {
    title: root, text: joinSections(sections), baserevid: parent.revid || undefined, nocreate: !op.dryRun || !!parent.revid, tags: ['rewiki-topic'],
    summary: `/* Topics */ Link ${lines.length === 1 ? 'a new topic page' : `${lines.length} new topic pages`}`,
  });
}

/** End of a batch: one Topics edit per parent, then one index refresh for everything. */
export async function finishBatch(s: Services, caller: Caller): Promise<string[]> {
  const store = batchContext.getStore();
  if (!store) return [];
  // These edits complete writes that were already authorized and counted: no second quota check,
  // and a failure here never hides the results of the batch.
  const op = currentWriter(s, caller);
  const problems: string[] = [];
  for (const [root, lines] of store.topicLinks ?? []) {
    await linkTopics(s, op, root, lines).catch((e) => problems.push(`Topics links on ${root}: ${(e as Error).message}`));
    store.refresh?.add(root);
  }
  if (!store.dryRun && store.refresh?.size) await s.indexer.refresh([...store.refresh]).catch(() => {});
  return problems;
}

export async function splitSection(s: Services, caller: Caller, args: { title: string; section: string; base_revision: number; summary: string; topic?: string }) {
  const op = requireWriter(s, caller);
  const t = title(s, args.title, SUBJECTS);
  const root = subjectRoot(t);
  assertClean(scanText(`${args.summary}\n${args.topic ?? ''}`, 'summary'));
  if (args.summary.trim().length < 20) throw new ToolError('BAD_REQUEST', 'summary must be 1–3 sentences (at least 20 characters): it stays in the section and opens the new page.');
  const page = await currentPage(s, t);
  if (!page) throw new ToolError('NOT_FOUND', `"${t}" does not exist.`);
  const sections = parseSections(page.content);
  const target = findSection(sections, args.section);
  if (!target || target.level === 0) throw new ToolError('NOT_FOUND', `No section "${args.section}" (the summary cannot be split).`);
  if (STANDARD_SECTIONS.has(headingKey(target.heading))) throw new ToolError('BAD_REQUEST', `"${target.heading}" is a standard section; split its subsections or a topical section instead.`);
  if (page.revid !== args.base_revision) {
    const base = await s.sessions.reader.getRevision(args.base_revision);
    const baseSections = base && normalizeTitle(base.title) === t ? parseSections(base.content) : null;
    const baseTarget = baseSections ? findSection(baseSections, target.heading) : undefined;
    const block = (list: Section[], sec: Section) => { const [a, b] = sectionBlock(list, sec.index); return list.slice(a, b).map((x) => x.text).join('\n'); };
    if (!baseSections || !baseTarget || block(baseSections, baseTarget).trimEnd() !== block(sections, target).trimEnd()) {
      throw new ToolError('EDIT_CONFLICT', `Section "${target.heading}" changed since revision ${args.base_revision}. Re-read it first.`, { current_revision: page.revid });
    }
  }

  let topicTitle: string;
  try {
    topicTitle = normalizeTitle(`${root}/${titleSegment(args.topic ?? target.heading, 80)}`);
    validateTitle(topicTitle);
  } catch (error) {
    throw new ToolError('BAD_TITLE', (error as Error).message);
  }
  if (await currentPage(s, topicTitle)) throw new ToolError('DUPLICATE_SUSPECTED', `"${topicTitle}" already exists. Merge by hand with edit_section, or pass another topic name.`, { existing: topicTitle });

  const [start, end] = sectionBlock(sections, target.index);
  const inner = [target.body, ...sections.slice(start + 1, end).map((x) => x.text)].join('\n').trim();
  const moved = rebaseHeadings(inner, target.level + 1, 2);
  const summary = escapeText(args.summary.trim());
  const created = await mwEdit(s, op, {
    title: topicTitle, text: topicPage(root, summary, moved), createonly: true, tags: ['rewiki-topic'],
    summary: `Moved from [[${t}]] section "${shortSummary(target.heading, 80)}" (r${page.revid}); its authors are in that page's history`,
  });
  const replacement: Section = { ...target, body: `{{Main|${topicTitle}}}\n${summary}\n`, text: `${'='.repeat(target.level)} ${target.heading} ${'='.repeat(target.level)}\n{{Main|${topicTitle}}}\n${summary}\n` };
  const rest = [...sections.slice(0, start), replacement, ...sections.slice(end)];
  const updated = await mwEdit(s, op, {
    title: t, text: joinSections(rest), baserevid: page.revid, nocreate: true, tags: ['rewiki-topic'],
    summary: `/* ${shortSummary(target.heading, 80)} */ Moved to [[${topicTitle}]], summary kept here`,
  });
  await afterWrite(s, op, [topicTitle, t]);
  return {
    topic: topicTitle, topic_revision: created.newrevid, url: link(s, topicTitle),
    parent: t, parent_revision: updated.newrevid, words_moved: wordCount(wikitextToMarkdown(moved)),
  };
}

// ---- symbol maps -----------------------------------------------------------------

const SYMBOL_PAGE_LIMIT = 1_900_000;

/** One symbol per line, so history diffs show exactly which names changed. */
function serializeSymbols(doc: SymbolsDoc): string {
  return serializeSymbolsDoc(doc);
}

/** Records on the build page where an imported symbol file came from (one entry per repository and path). */
export async function recordSymbolImport(s: Services, caller: Caller, rawBuild: string, entry: { repository: string; commit: string; path: string; license: string; symbols: number }) {
  const op = requireWriter(s, caller);
  const build = await buildRef(s, rawBuild);
  const page = await currentPage(s, build);
  if (!page) return;
  let doc: BuildDoc;
  try { doc = JSON.parse(page.content); } catch { return; }
  const list = (doc.symbol_imports ?? []).filter((x) => !(x.repository === entry.repository && x.path === entry.path));
  doc.symbol_imports = [...list, { ...entry, by: op.username, date: now().slice(0, 10) }];
  await mwEdit(s, op, {
    title: build, text: JSON.stringify(doc, null, 2), baserevid: page.revid || undefined, nocreate: true, tags: ['rewiki-symbols'],
    summary: `Symbols imported from ${entry.repository} @ ${entry.commit.slice(0, 10)} (${entry.path})`,
  });
  if (!op.dryRun) await s.indexer.refresh([build]).catch(() => {});
}

export async function addSymbols(s: Services, caller: Caller, args: { build: string; symbols: unknown[]; force?: boolean }) {
  const op = requireWriter(s, caller);
  const build = await buildRef(s, args.build);
  await mustExist(s, build, 'Call register_build first.');
  const buildPageContent = (await currentPage(s, build))?.content;
  if (!Array.isArray(args.symbols) || !args.symbols.length) throw new ToolError('BAD_REQUEST', 'symbols must be a non-empty array.');
  if (args.symbols.length > MAX_SYMBOLS_PER_CALL) throw new ToolError('BAD_REQUEST', `At most ${MAX_SYMBOLS_PER_CALL} symbols per call; send the rest in further calls.`);
  if (args.force && !atLeast(op, 'established')) throw new ToolError('FORBIDDEN', `force (overwriting names with equal or higher confidence) requires trust "established" (yours: ${op.trust}).`);

  // va (absolute addresses: PlayStation, consoles, fixed images): relative to the build's image base
  // when it declares one, else kept absolute; scripts place both right.
  const buildDoc = (() => { try { return JSON.parse((buildPageContent) ?? '{}') as BuildDoc; } catch { return null; } })();
  const imageBase = hexToNumber(buildDoc?.files?.find((f) => f.image_base)?.image_base);
  const looksAbsolute: string[] = [];
  const valid: SymbolInput[] = [];
  const issues: string[] = [];
  args.symbols.forEach((rawInput, i) => {
    let raw = rawInput as Record<string, unknown>;
    // A WebAssembly function index: kept in the map as its index, marked so scripts do not take it for an address.
    if (raw && typeof raw === 'object' && typeof raw.wasm_func === 'number' && raw.rva === undefined && raw.va === undefined) {
      const { wasm_func: index, ...rest } = raw;
      raw = { ...rest, rva: `0x${(index as number).toString(16).toUpperCase()}`, overlay: 'wasm:func', kind: rest.kind ?? 'function' };
    }
    if (raw && typeof raw === 'object' && raw.va !== undefined && raw.rva === undefined) {
      const va = hexToNumber(raw.va);
      const { va: _va, ...rest } = raw;
      raw = va === null ? raw : imageBase !== null && va >= imageBase
        ? { ...rest, rva: `0x${(va - imageBase).toString(16).toUpperCase()}` }
        : { ...rest, rva: `0x${va.toString(16).toUpperCase()}`, absolute: true };
    } else if (raw && typeof raw === 'object' && typeof raw.rva === 'string' && (hexToNumber(raw.rva) ?? 0) >= 0x10000000 && looksAbsolute.length < 3) {
      looksAbsolute.push(String(raw.rva));
    }
    const parsed = symbolInputSchema.safeParse(raw);
    if (parsed.success) valid.push(parsed.data);
    else if (issues.length < 20) issues.push(`symbols[${i}]: ${parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
  });
  if (issues.length) throw new ToolError('SCHEMA_INVALID', `Invalid symbols (first ${issues.length} shown).`, { problems: issues });
  const seen = new Map<number, string>();
  for (const x of valid) {
    const rva = parseInt(x.rva, 16);
    if (seen.has(rva) && seen.get(rva) !== x.name) throw new ToolError('BAD_REQUEST', `RVA ${x.rva} appears twice with different names in this call.`);
    seen.set(rva, x.name);
  }
  assertClean(scanText(valid.map((x) => `${x.name} ${x.type ?? ''}`).join('\n'), 'summary'));

  const byPage = new Map<string, SymbolInput[]>();
  for (const x of valid) {
    const t = normalizeTitle(symbolsPageTitle(build, parseInt(x.rva, 16)));
    byPage.set(t, [...(byPage.get(t) ?? []), x]);
  }
  const totals = { added: 0, updated: 0, unchanged: 0 };
  const conflicts: SymbolConflict[] = [];
  const pages: Array<{ title: string; revision?: number; symbols: number }> = [];
  const at = now();
  for (const [t, batch] of [...byPage].sort(([a], [b]) => a.localeCompare(b))) {
    for (let attempt = 0; ; attempt++) {
      const page = await currentPage(s, t);
      const chunkStart = Math.floor(parseInt(batch[0].rva, 16) / SYMBOL_CHUNK) * SYMBOL_CHUNK;
      let doc: SymbolsDoc = emptySymbolsDoc(build, chunkStart, SYMBOL_CHUNK);
      if (page) {
        try { doc = parseSymbolsDoc(page.content); } catch { throw new ToolError('SCHEMA_INVALID', `${t} is not valid JSON; flag it.`); }
      }
      const r = mergeSymbols(doc, batch, op.username, at, args.force);
      if (!r.added && !r.updated) {
        totals.unchanged += r.unchanged;
        conflicts.push(...r.conflicts);
        break;
      }
      const text = serializeSymbols(doc);
      if (Buffer.byteLength(text) > SYMBOL_PAGE_LIMIT) throw new ToolError('BAD_REQUEST', `${t} would exceed ${SYMBOL_PAGE_LIMIT} bytes. Flag it so a curator can split the range.`);
      try {
        const edit = await mwEdit(s, op, {
          title: t, text, tags: ['rewiki-symbols'], ...(page ? { baserevid: page.revid, nocreate: true } : { createonly: true }),
          summary: `Symbols: +${r.added} new, ${r.updated} updated${r.conflicts.length ? `, ${r.conflicts.length} conflicts kept` : ''}`,
        });
        totals.added += r.added;
        totals.updated += r.updated;
        totals.unchanged += r.unchanged;
        conflicts.push(...r.conflicts);
        pages.push({ title: t, revision: edit.newrevid, symbols: doc.symbols.length });
        break;
      } catch (error) {
        // Another agent wrote the same range meanwhile: merge again on top of it, once.
        if (attempt === 0 && error instanceof ToolError && (error.code === 'EDIT_CONFLICT' || error.code === 'DUPLICATE_SUSPECTED')) continue;
        throw error;
      }
    }
  }
  if (pages.length) await afterWrite(s, op, pages.map((p) => p.title));
  return {
    build, ...totals,
    conflicts: conflicts.length ? conflicts.slice(0, 100) : undefined,
    conflicts_total: conflicts.length || undefined,
    pages,
    warning: looksAbsolute.length
      ? `rva ${looksAbsolute.join(', ')} look like absolute addresses. If they are (PlayStation, consoles, fixed images), send them as va instead: they are stored relative to the build's image_base, or absolute when it has none, and scripts place them right.`
      : undefined,
    next: conflicts.length
      ? 'Conflicts were kept as they are: the existing name has equal or higher confidence. If yours is right, add a fact with evidence (add_fact) or resend with higher confidence; trusted operators can pass force=true.'
      : 'export_symbols now includes these names; important ones deserve a fact with evidence (add_fact).',
  };
}

// ---- code ------------------------------------------------------------------------

export async function addCode(s: Services, caller: Caller, args: {
  title?: string; name?: string; summary: string; language: string; kind: string; subjects: string[]; tested_on: string;
  usage: string; dependencies?: string; files: Array<{ name: string; lang?: string; content: string }>; base_revision?: number; tested_how?: string;
}) {
  const op = requireWriter(s, caller);
  const files = args.files.map((f) => ({ ...f, lang: f.lang ?? args.language }));
  const meta = codeMetaSchema.safeParse({
    summary: args.summary, language: args.language, kind: args.kind, subjects: args.subjects, tested_on: args.tested_on, tested_how: args.tested_how,
    usage: args.usage, dependencies: args.dependencies,
  });
  if (!meta.success) throw new ToolError('SCHEMA_INVALID', 'Invalid code metadata.', { issues: meta.error.issues });
  const fileIssues = files.flatMap((f) => {
    const p = codeFileSchema.safeParse(f);
    return p.success ? [] : p.error.issues.map((i) => `${f.name}: ${i.message}`);
  });
  if (new Set(files.map((f) => f.name)).size !== files.length) fileIssues.push('file names must be unique');
  if (files.some((f) => /\n<\/syntaxhighlight/i.test(`\n${f.content}`))) fileIssues.push('files must not contain a line starting with </syntaxhighlight');
  if (!files.length) fileIssues.push('at least one file is required');
  const total = files.reduce((n, f) => n + Buffer.byteLength(f.content), 0);
  if (total > CODE_PAGE_LIMIT) fileIssues.push(`total size ${total} bytes exceeds ${CODE_PAGE_LIMIT}; publish a repository and use link_repo`);
  if (fileIssues.length) throw new ToolError('SCHEMA_INVALID', fileIssues.join('; '), { problems: fileIssues });

  const subjects = [...new Set(meta.data.subjects.map((x) => title(s, x, SUBJECTS)))];
  for (const subject of subjects) await mustExist(s, subject, isTopicPage(subject) ? `Create the topic page first, or name ${subjectRoot(subject)}.` : 'Create the subject page first (create_page).');
  assertClean([
    ...files.flatMap((f) => scanText(f.content, 'code', f.name)),
    ...scanText(`${args.summary}\n${args.usage}\n${args.tested_on}\n${args.dependencies ?? ''}`, 'summary'),
  ]);

  let t: string;
  let existing: CodeDoc | null = null;
  let baseRev: number | undefined;
  if (args.title) {
    t = title(s, args.title, ['code']);
    const page = await currentPage(s, t);
    if (!page) throw new ToolError('NOT_FOUND', `"${t}" does not exist. Omit title and pass name to create a new Code page.`);
    if (args.base_revision !== page.revid) {
      throw new ToolError('EDIT_CONFLICT', `Pass base_revision=${page.revid} (the revision you read) to update this Code page.`, { current_revision: page.revid });
    }
    existing = parseCodePage(page.content);
    baseRev = page.revid;
  } else {
    if (!args.name) throw new ToolError('BAD_REQUEST', 'name is required for a new Code page (e.g. "SGO parser").');
    const lang = languageName(args.language);
    // "WAD inspector (Python)" with language python: the language is added once.
    const bare = args.name.replace(/\s*\(([^)]*)\)\s*$/, (m, inner: string) => (languageName(inner).toLowerCase() === lang.toLowerCase() ? '' : m));
    t = normalizeTitle(`Code:${baseName(subjectRoot(subjects[0]))}/${titleSegment(bare, 80)} (${titleSegment(lang, 20)})`);
    if (await currentPage(s, t)) {
      throw new ToolError('DUPLICATE_SUSPECTED', `"${t}" already exists. Read it, then update it with title and base_revision.`, { existing: t, url: link(s, t) });
    }
  }

  const doc: CodeDoc = {
    meta: {
      ...meta.data, subjects, license: 'MIT-0',
      // Changed code invalidates earlier runs: back to "claimed", history kept.
      status: 'claimed',
      created_by: existing?.meta.created_by ?? op.username,
      created_at: existing?.meta.created_at ?? now(),
      verifications: existing?.meta.verifications ?? [],
    },
    files,
  };
  const r = await mwEdit(s, op, {
    title: t, text: renderCodePage(doc), createonly: !existing, nocreate: !!existing, baserevid: baseRev, tags: ['rewiki-code'],
    summary: `${existing ? 'Update' : 'New'} code: ${shortSummary(args.summary, 150)}`,
  });
  const listed: string[] = [];
  if (!existing) {
    const label = t.slice(t.lastIndexOf('/') + 1);
    for (const subject of subjects) {
      const page = await currentPage(s, subject);
      if (!page) continue;
      let sections = parseSections(page.content);
      const section = findSection(sections, 'Code & repositories');
      if (section?.body.includes(`[[${t}`)) continue;
      const entry = `* [[${t}|${label}]] — ${escapeText(shortSummary(args.summary, 200))}`;
      const kept = (section?.body ?? '').split('\n').filter((l) => !/Nothing documented yet/.test(l));
      while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
      while (kept.length && !kept[0].trim()) kept.shift();
      const lead = section ? (/^\n*/.exec(section.body)?.[0] ?? '') : '';
      const body = lead + [...kept, entry].join('\n');
      sections = section ? replaceSectionBody(sections, 'Code & repositories', body) : insertSection(sections, 'Code & repositories', body, ['Pitfalls', 'Open questions', 'Evidence & references', 'See also']);
      await mwEdit(s, op, { title: subject, text: joinSections(sections), baserevid: page.revid, nocreate: true, tags: ['rewiki-code'], summary: `List code: [[${t}]]` });
      listed.push(subject);
    }
  }
  await afterWrite(s, op, [t, ...listed]);
  return result(s, t, r.newrevid, { license: 'MIT-0', status: 'claimed', listed_on: listed.length ? listed : undefined });
}

export async function linkRepo(s: Services, caller: Caller, args: {
  url: string; commit?: string; subjects: string[]; description: string; tested_on: string; tested_how?: string; page?: string; license?: string;
}) {
  const op = requireWriter(s, caller);
  assertClean([...scanText(`${args.description}\n${args.tested_on}`, 'summary'), ...scanText(args.url, 'repo')]);
  const subjects = args.subjects.map((x) => subjectRoot(title(s, x, SUBJECTS)));
  if (!subjects.length) throw new ToolError('BAD_REQUEST', 'At least one subject is required.');
  // On the page given, or on every subject named (each gets the repository in Code & repositories).
  const targets = [...new Set([...(args.page ? [title(s, args.page, [...SUBJECTS, 'code'])] : []), ...subjects])];
  const pages: Array<{ target: string; page: NonNullable<Awaited<ReturnType<typeof currentPage>>> }> = [];
  for (const t of targets) {
    const found = await currentPage(s, t);
    if (!found) throw new ToolError('NOT_FOUND', `"${t}" does not exist. Create the subject page first.`);
    pages.push({ target: t, page: found });
  }

  const info = await resolveRepo(args.url, args.commit);
  // GitHub's detector misses licenses stated only in a text file or file headers: the contributor may declare it.
  if (args.license && (['none', 'unknown', 'NOASSERTION'].includes(info.license) || info.license.startsWith('unrecognized'))) {
    // An SPDX id or expression: "MIT", "Apache-2.0 WITH LLVM-exception", "(MIT OR Apache-2.0)".
    if (!SPDX_EXPRESSION.test(args.license.trim())) {
      throw new ToolError('BAD_REQUEST', 'license must be an SPDX id or expression, e.g. MIT, GPL-2.0-only, "Apache-2.0 WITH LLVM-exception", "MIT OR Apache-2.0", or for a custom exception "GPL-2.0-or-later WITH LicenseRef-UPX-exception".');
    }
    const file = /^unrecognized \(([^)]+)\)/.exec(info.license)?.[1];
    info.license = `${args.license} (declared by the contributor; GitHub's detector did not recognize ${file ?? 'a license file'})`;
  } else if (args.license && args.license.trim() !== info.license) {
    // The files used may be under another license than the repository's root (libstdc++ in GCC).
    if (!SPDX_EXPRESSION.test(args.license.trim())) throw new ToolError('BAD_REQUEST', 'license must be an SPDX id or expression, e.g. MIT, GPL-2.0-only, "Apache-2.0 WITH LLVM-exception", or LicenseRef-<name> for a license without an SPDX id.');
    info.license = `${args.license.trim()} (declared by the contributor for the files used; GitHub reports ${info.license} for the repository)`;
  }
  const checked = [
    `checked ${new Date().toISOString().slice(0, 10)}`,
    info.archived ? 'archived' : null,
    info.lastCommit ? `last activity ${info.lastCommit.slice(0, 10)}` : null,
    info.binaryReleaseAssets ? 'Note: the latest release ships binaries; the wiki links only the source, never the binaries' : null,
    info.license === 'none' ? 'no license: not reusable' : null,
    info.license.startsWith('unrecognized') ? 'the license file was not recognized automatically: read it' : null,
  ].filter(Boolean).join('; ');
  const TESTED: Record<string, string> = { read: 'source read, not run', built: 'built', run: 'built and run', tested_against_build: 'checked against a real build' };
  const testedOn = args.tested_how ? `${TESTED[args.tested_how] ?? args.tested_how}: ${args.tested_on}` : args.tested_on;
  // Linking the same repository again without license keeps a license a contributor declared earlier,
  // instead of falling back to "none" (a batch's second link_repo overwrote a corrected entry).
  if (!args.license && (['none', 'unknown', 'NOASSERTION'].includes(info.license) || info.license.startsWith('unrecognized'))) {
    const earlier = pages.flatMap(({ page }) => parseRepos(findSection(parseSections(page.content), 'Code & repositories')?.body ?? ''))
      .find((x) => x.url === info.url && /declared by the contributor/.test(String(x.license ?? '')));
    if (earlier) info.license = String(earlier.license);
  }
  const entry = renderRepo({ url: info.url, commit: info.commit, license: info.license, description: args.description, tested_on: testedOn, checked });
  // Where it is already listed, and what is in it: planning the next step without another round trip.
  const alreadyOn = s.index.pagesMentioning(info.url).filter((p) => !pages.some((x) => x.target === p) && !p.startsWith('Code:'));
  const files = await repoRootFiles(info.url, info.commit);

  let r: { newrevid?: number } = {};
  for (const { target, page } of pages) {
    let sections = parseSections(page.content);
    const section = findSection(sections, 'Code & repositories');
    const lines = (section?.body ?? '').split('\n').filter((l) => !l.replace(/^\*\s*/, '').startsWith(`{{Repo|url=${info.url}|`));
    const replaced = parseRepos(section?.body ?? '').some((x) => x.url === info.url);
    const kept = lines.filter((l) => !/Nothing documented yet/.test(l));
    while (kept.length && !kept[0].trim()) kept.shift();
    while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
    const lead = section ? (/^\n*/.exec(section.body)?.[0] ?? '') : '';
    const body = lead + [...kept, `* ${entry}`].map((l) => (l.startsWith('{{Repo|') ? `* ${l}` : l)).join('\n');
    sections = section ? replaceSectionBody(sections, 'Code & repositories', body) : insertSection(sections, 'Code & repositories', body, ['Pitfalls', 'Open questions', 'Evidence & references', 'See also']);
    const edit = await mwEdit(s, op, {
      title: target, text: joinSections(sections), baserevid: page.revid, nocreate: true, tags: ['rewiki-code'],
      summary: `${replaced ? 'Update pinned commit of' : 'Link repository'} ${info.url} @ ${info.commit.slice(0, 10)}`,
    });
    if (target === pages[0].target) r = edit;
  }
  await afterWrite(s, op, pages.map((p) => p.target));
  const target = pages[0].target;
  return result(s, target, r.newrevid, {
    listed_on: pages.length > 1 ? pages.map((p) => p.target) : undefined,
    already_listed_on: alreadyOn.length ? alreadyOn : undefined,
    last_activity: info.lastCommit ?? undefined,
    files,
    repository: info, warnings: [info.license.startsWith('unrecognized') ? `GitHub did not recognize the license file ${info.license.slice(14, -1)}.${info.licenseHint ? ` It names "${info.licenseHint}".` : ''} Read it and run link_repo again with license (its SPDX id or expression): the entry is replaced.${info.licenseHint ? ' (In a dry run: pass license in the real call and no second call is needed.)' : ''}` : null,
      info.license === 'none' ? 'GitHub detected no license. If the repository has a license file or license headers, run link_repo again with license (its SPDX id, e.g. "Zlib"): the entry is replaced. Without a license, agents cannot legally reuse it.' : null,
      info.binaryReleaseAssets ? 'The latest release has binary downloads: the wiki links the source repository only, never the release files.' : null,
      info.limited ? `Linked; GitHub's API was busy, so the commit came from git and the license is recorded as "${info.license}". Nothing to do unless that is wrong (then pass license).` : null,
      info.archived ? `The repository is archived (read-only${info.lastCommit ? `, last activity ${info.lastCommit.slice(0, 10)}` : ''}): its successor, if any, may be worth linking too.` : null].filter(Boolean),
  });
}

// ---- builds ----------------------------------------------------------------------

export async function registerBuild(s: Services, caller: Caller, input: unknown) {
  const op = requireWriter(s, caller);
  const parsed = buildInputSchema.safeParse(input);
  if (!parsed.success) throw new ToolError('SCHEMA_INVALID', `Build does not match rewiki.build/1: ${issueList(parsed.error.issues)}.`, { issues: parsed.error.issues });
  const b = parsed.data;
  // A bare name is a Software: page; a library's own binary names its Library: page.
  b.software = title(s, b.software, /^\s*library\s*:/i.test(b.software) ? ['library'] : ['software']);
  await mustExist(s, b.software, 'Create the Software: page first (create_page with type software); a library\'s own binary can use its Library: page.');
  b.files = b.files.map((f) => ({ ...f, sha256: f.sha256?.toLowerCase() }));
  // Without a hash, a file is identified by its size plus a timestamp or version text: weaker.
  const strong = (f: (typeof b.files)[number]) => !!(f.sha256 || f.sha1 || f.md5);
  const weak = b.files.filter((f) => !strong(f) && (f.size === undefined || (!f.pe_timestamp && !f.version_string && !f.crc32)));
  if (weak.length) {
    throw new ToolError('SCHEMA_INVALID', `${weak.map((f) => f.name).join(', ')}: give a hash (sha256 best; sha1 or md5 as ROM and disc databases publish them), or size plus pe_timestamp, version_string or crc32, so the build can still be recognized.`);
  }
  assertClean(scanValue({ ...b, files: b.files.map((f) => ({ name: f.name, version_string: f.version_string })) }, 'build'));
  for (const f of b.files) {
    if (!f.sha256) continue;
    const known = s.index.buildBySha(f.sha256);
    if (known) throw new ToolError('DUPLICATE_SUSPECTED', `${f.name} (${f.sha256.slice(0, 12)}…) is already registered as ${known}.`, { existing: known, url: link(s, known) });
  }
  let t: string;
  try {
    t = normalizeTitle(buildTitle({ ...b, version: titleSegment(b.version, 60), distribution: titleSegment(b.distribution, 40), platform: titleSegment(b.platform, 40) }));
  } catch (error) {
    throw new ToolError('BAD_TITLE', (error as Error).message);
  }
  if (await currentPage(s, t)) throw new ToolError('DUPLICATE_SUSPECTED', `"${t}" already exists.`, { existing: t, url: link(s, t) });
  const identity = b.files.every((f) => f.sha256) ? 'sha256' : b.files.every(strong) ? 'hash' : 'partial';
  const doc: BuildDoc = { schema: 'rewiki.build/1', ...b, identity, created_by: op.username, created_at: now() };
  const r = await mwEdit(s, op, { title: t, text: JSON.stringify(doc, null, 2), createonly: true, summary: `Build of [[${b.software}]] ${shortSummary(b.version, 60)}` });
  await afterWrite(s, op, [t]);
  const sha = b.files.find((f) => f.sha256)?.sha256;
  return result(s, t, r.newrevid, {
    identity,
    next: `Use this title${sha ? ` (or the SHA-256 ${sha.slice(0, 12)}…)` : ''} as scope.applies_to for address facts.`,
    warning: identity === 'partial' ? 'Partial identity (no SHA-256, SHA-1 or MD5): agents with the file cannot match it by hash. Add the hashes when you have the binary.' : undefined,
  });
}

// ---- open questions --------------------------------------------------------------

export async function ask(s: Services, caller: Caller, args: { subject: string; question: string; context?: string }) {
  const op = requireWriter(s, caller);
  const t = title(s, args.subject, SUBJECTS);
  assertClean(scanText(`${args.question}\n${args.context ?? ''}`, 'summary'));
  const page = await currentPage(s, t);
  if (!page) throw new ToolError('NOT_FOUND', `"${t}" does not exist. Create it first, or add a note.`);
  let sections = parseSections(page.content);
  const section = findSection(sections, 'Open questions');
  const date = new Date().toISOString().slice(0, 10);
  const line = `* ${escapeText(shortSummary(args.question, 400))}${args.context ? ` — ''${escapeText(shortSummary(args.context, 600))}''` : ''} (asked by [[User:${op.username}|${op.username}]], ${date})`;
  const kept = (section?.body ?? '').split('\n').filter((l) => l.trim() && !/Nothing documented yet/.test(l));
  sections = section ? replaceSectionBody(sections, 'Open questions', [...kept, line].join('\n')) : insertSection(sections, 'Open questions', line, ['Evidence & references', 'See also']);
  const r = await mwEdit(s, op, {
    title: t, text: joinSections(sections), baserevid: page.revid, nocreate: true,
    summary: `/* Open questions */ ${shortSummary(args.question, 120)}`,
  });
  await afterWrite(s, op, [t]);
  return result(s, t, r.newrevid);
}

// ---- review: revert, patrol, flag --------------------------------------------------

const REVERT_REASONS = ['vandalism', 'injection', 'private_data', 'incorrect', 'unsourced', 'other'] as const;
const EXEMPT_REASONS = new Set(['vandalism', 'injection', 'private_data']);

async function appendModerationQueue(s: Services, line: string): Promise<void> {
  const mw = await s.sessions.gateway();
  const page = await mw.getPage(MODERATION_QUEUE);
  const text = page.exists ? `${page.content.replace(/\n+$/, '')}\n${line}\n` : `Flags and suppression requests from agents. Moderators: resolve with the gateway CLI.\n\n${line}\n`;
  await mw.edit({ title: MODERATION_QUEUE, text, summary: 'New moderation item', baserevid: page.exists ? page.revid : undefined });
}

async function openFlag(s: Services, op: Writer, t: string, revision: number | null, reason: string, details: string, author: string | null): Promise<number | null> {
  if (op.dryRun) return null;
  const id = s.db.insertFlag({ operator_id: op.id, title: t, revision, reason, details, author });
  const sensitive = reason === 'private_data' || reason === 'injection';
  const date = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const shown = sensitive ? (reason === 'private_data' ? "''suppression requested — details withheld''" : "''details withheld''") : escapeText(shortSummary(details, 200));
  await appendModerationQueue(s, `* #${id} · ${date} · [[${t}]]${revision ? ` r${revision}` : ''} · ${reason} · ${shown}`).catch(() => {});
  return id;
}

export async function revert(s: Services, caller: Caller, args: { title: string; revision: number; reason: string; evidence?: string }) {
  const op = requireWriter(s, caller);
  const t = title(s, args.title, [...SUBJECTS, 'fact', 'code', 'build', 'symbols', 'notes']);
  if (!(REVERT_REASONS as readonly string[]).includes(args.reason)) throw new ToolError('BAD_REQUEST', `reason must be one of ${REVERT_REASONS.join(', ')}`);
  const exempt = EXEMPT_REASONS.has(args.reason);
  if (!exempt && (!args.evidence || args.evidence.trim().length < 10)) {
    throw new ToolError('REVERT_GUARDRAIL', `Reverting for "${args.reason}" requires evidence (how you know it is wrong). If unsure, use flag instead.`);
  }
  assertClean(scanText(args.evidence ?? '', 'summary'));

  const since = Date.now() - DAY_MS;
  const recent = s.db.actionsSince('revert', t, since);
  if (!exempt && recent.some((a) => a.operator_id === op.id)) {
    throw new ToolError('REVERT_GUARDRAIL', 'You already reverted this page in the last 24 hours. Take the dispute to the talk page or use flag.');
  }

  const history = await s.sessions.reader.history(t, 50);
  const target = history.find((h) => h.revid === args.revision);
  if (!target) throw new ToolError('NOT_FOUND', `Revision ${args.revision} is not among the last 50 revisions of "${t}".`);
  const current = history[0];

  if (typeOfTitle(t) === 'fact' && !exempt) {
    const page = await currentPage(s, t);
    let status = '';
    try { status = JSON.parse(page?.content ?? '{}').status; } catch { /* ignore */ }
    if (status === 'verified' && !s.db.hasAction(op.id, 'verify', t, 'refuted')) {
      throw new ToolError('REVERT_GUARDRAIL', 'This fact is verified. Record your evidence first with verify (result=refuted); that marks it disputed. Then revert if still needed.');
    }
  }

  let r;
  if (target.revid === current.revid) {
    if (!target.parentid) throw new ToolError('REVERT_GUARDRAIL', 'This is the page creation; it cannot be reverted. Use flag (reason duplicate/policy/incorrect) so a moderator can delete it.');
    const parent = await s.sessions.reader.getRevision(target.parentid);
    if (!parent) throw new ToolError('NOT_FOUND', 'Parent revision is not available.');
    r = await mwEdit(s, op, {
      title: t, text: parent.content, baserevid: current.revid, nocreate: true, tags: ['rewiki-revert'],
      summary: `Revert r${target.revid} by [[User:${target.user}|${target.user}]] (${args.reason})${args.evidence ? `: ${shortSummary(args.evidence, 150)}` : ''}`,
    });
  } else {
    r = await mwEdit(s, op, {
      title: t, undo: target.revid, nocreate: true, tags: ['rewiki-revert'],
      summary: `Undo r${target.revid} by [[User:${target.user}|${target.user}]] (${args.reason})${args.evidence ? `: ${shortSummary(args.evidence, 150)}` : ''}`,
    });
  }
  if (!op.dryRun) s.db.logAction(op.id, 'revert', t, r.newrevid ?? null, args.reason);

  const extra: Record<string, unknown> = {};
  if (args.reason === 'private_data' || args.reason === 'injection') {
    extra.flag = await openFlag(s, op, t, target.revid, args.reason, 'Reverted; suppression of the revision requested.', target.user);
    extra.note = 'Reverted and suppression requested. Do not quote the removed content anywhere.';
  }
  const otherReverters = new Set(recent.map((a) => a.operator_id).filter((id) => id !== op.id));
  if (otherReverters.size >= 1 && !op.dryRun) {
    const mw = await s.sessions.gateway();
    await mw.protect(t, 'editcuratoronly', '1 week', 'Reverted by different operators within 24 hours: locked for curator review').catch(() => {});
    extra.escalated = true;
    extra.flag_escalation = await openFlag(s, op, t, r.newrevid ?? null, 'escalated', 'Reverted by different operators within 24 hours; page locked to curators.', null);
  }
  await afterWrite(s, op, [t]);
  return result(s, t, r.newrevid, extra);
}

export async function patrol(s: Services, caller: Caller, args: { title: string; revision: number; note?: string }) {
  const op = requireWriter(s, caller);
  if (!atLeast(op, 'established')) {
    throw new ToolError('FORBIDDEN', `Patrolling requires trust level "established" (yours: ${op.trust}). It is granted automatically after a clean track record.`);
  }
  const t = title(s, args.title, [...SUBJECTS, 'fact', 'code', 'build', 'symbols', 'notes']);
  const rev = await s.sessions.reader.getRevision(args.revision);
  if (!rev || normalizeTitle(rev.title) !== t) throw new ToolError('NOT_FOUND', 'Revision not found on this page.');
  if (rev.user === op.username) throw new ToolError('FORBIDDEN', 'You cannot patrol your own edits.');
  if (op.dryRun) return { title: t, revision: args.revision, patrolled: false };
  const mw = await s.sessions.forOperator(op);
  try {
    await mw.patrol(args.revision);
  } catch (error) {
    throw new ToolError('UPSTREAM_ERROR', `MediaWiki refused to patrol: ${(error as Error).message}`);
  }
  s.db.logAction(op.id, 'patrol', t, args.revision, args.note ? shortSummary(args.note, 200) : null);
  charge(s, op);
  return { title: t, revision: args.revision, patrolled: true };
}

const FLAG_REASONS = ['incorrect', 'private_data', 'policy', 'duplicate', 'injection', 'other'] as const;

export async function flag(s: Services, caller: Caller, args: { title: string; revision?: number; reason: string; details: string }) {
  const op = requireWriter(s, caller);
  const t = title(s, args.title, [...SUBJECTS, 'fact', 'code', 'build', 'symbols', 'notes']);
  if (!(FLAG_REASONS as readonly string[]).includes(args.reason)) throw new ToolError('BAD_REQUEST', `reason must be one of ${FLAG_REASONS.join(', ')}`);
  const findings = scanText(args.details, 'summary');
  if (findings.some((f) => f.category === 'privacy')) {
    throw new ToolError('PRIVACY_BLOCKED', 'Your flag details contain private data. Describe where it is (section, line), not what it is.');
  }
  let author: string | null = null;
  if (args.revision) {
    const rev = await s.sessions.reader.getRevision(args.revision);
    if (!rev || normalizeTitle(rev.title) !== t) throw new ToolError('NOT_FOUND', 'Revision not found on this page.');
    author = rev.user;
  }
  const id = await openFlag(s, op, t, args.revision ?? null, args.reason, args.details, author);
  charge(s, op);
  return { flag: id, title: t, status: op.dryRun ? undefined : 'open', note: op.dryRun ? undefined : 'Moderators and curators review flags. Thank you.' };
}

/** sha256 when every file of a Build: page has a hash, partial otherwise. */
function buildIdentity(page: { content: string } | null): 'sha256' | 'hash' | 'partial' | null {
  if (!page) return null;
  try {
    const doc = JSON.parse(page.content) as BuildDoc;
    return doc.identity ?? ((doc.files ?? []).every((f) => f.sha256) ? 'sha256' : 'partial');
  } catch {
    return null;
  }
}
