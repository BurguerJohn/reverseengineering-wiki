/** Write tools (design/04-mcp-server.md#write). Every write needs an operator account. */
import { randomBytes } from 'node:crypto';
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
} from '../wiki/wikitext.ts';
import {
  buildArticle, redirectText, factInputSchema, checkFactData, unknownFactFields, FACT_DATA, factKey, buildInputSchema, buildTitle,
  codeMetaSchema, codeFileSchema, renderCodePage, parseCodePage, renderRepo, parseRepos, renderNote,
  symbolInputSchema, mergeSymbols, emptySymbolsDoc, topicPage, wordCount,
  LEADING_SECTIONS, TRAILING_SECTIONS, TOPIC_SPLIT_WORDS, MAX_SYMBOLS_PER_CALL, CODE_PAGE_LIMIT,
  type FactDoc, type BuildDoc, type CodeDoc, type SymbolsDoc, type SymbolInput, type SymbolConflict,
} from '../wiki/pages.ts';
import { resolveRepo } from './repos.ts';

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

function shortSummary(text: string, max = 200): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
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
  // A short key makes the list of notes readable; the random suffix keeps titles unique.
  const label = args.key ? ` ${titleSegment(args.key, 60)}` : '';
  const t = normalizeTitle(`Notes:${baseName(subject)}/${date}${label} ${randomBytes(2).toString('hex')}`);
  const text = renderNote({
    subject, confidence: args.confidence, bodyWikitext: markdownToWikitext(args.body, { topLevel: 2 }),
    evidenceWikitext: args.evidence ? markdownToWikitext(args.evidence, { topLevel: 3 }) : undefined,
  });
  const r = await mwEdit(s, op, { title: t, text, summary: `Field note on [[${subject}]]`, createonly: true, tags: ['rewiki-note'] });
  await afterWrite(s, op, [t]);
  return result(s, t, r.newrevid, { next: 'Curators distill notes into articles and facts. Precise claims can go straight to add_fact.' });
}

// ---- facts -----------------------------------------------------------------------

export async function addFact(s: Services, caller: Caller, input: unknown) {
  const op = requireWriter(s, caller);
  const parsed = factInputSchema.safeParse(input);
  if (!parsed.success) throw new ToolError('SCHEMA_INVALID', `Fact does not match rewiki.fact/1: ${issueList(parsed.error.issues)}.`, { issues: parsed.error.issues });
  const fact = parsed.data;
  const askedSubject = title(s, fact.subject, SUBJECTS);
  fact.subject = subjectRoot(askedSubject);
  await mustExist(s, fact.subject, 'Create the subject page first (create_page).');
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
  if (problems.length) throw new ToolError('SCHEMA_INVALID', problems.join(' '), { problems });
  fact.scope.observed_in = await Promise.all(fact.scope.observed_in.map((o) => (SHA256_REF.test(o.trim()) ? buildRef(s, o) : s.index.resolveRedirect(normalizeTitle(o)))));
  const unknown = unknownFactFields(fact.kind, fact.data);
  const subjectNote = askedSubject !== fact.subject ? `Stored on ${fact.subject}: facts attach to the subject page, not to its topic pages; mention the fact on ${askedSubject} with a link if useful.` : undefined;
  const warnings = unknown.length || subjectNote
    ? [...(subjectNote ? [subjectNote] : []), ...(unknown.length ? [`data.${unknown.join(', data.')} ${unknown.length > 1 ? 'are' : 'is'} not standard for kind "${fact.kind}" (standard: ${[...FACT_DATA[fact.kind].required, ...(FACT_DATA[fact.kind].one_of ?? []), ...FACT_DATA[fact.kind].optional].join(', ')}). Kept, but tools like export_symbols and export_header only use standard fields. Several related addresses? One fact per address, or add_symbols for many names with their signatures.`] : [])]
    : undefined;
  const partialBuild = fact.scope.level === 'build' ? buildIdentity(await currentPage(s, fact.scope.applies_to)) === 'partial' : false;
  assertClean(scanValue(fact, 'fact'));

  const buildSuffix = fact.scope.level === 'build' ? ` @ ${titleSegment(baseName(fact.scope.applies_to).split('/').slice(1).join(' '), 60)}` : '';
  const t = normalizeTitle(`Fact:${baseName(fact.subject)}/${fact.kind}/${titleSegment(factKey(fact))}${buildSuffix}`);
  const existing = await currentPage(s, t);
  if (existing) {
    let doc: Partial<FactDoc> = {};
    try { doc = JSON.parse(existing.content); } catch { /* ignore */ }
    throw new ToolError('DUPLICATE_SUSPECTED', `A fact with this key already exists: ${t}. If yours agrees, call verify on it; if it contradicts, verify with result=refuted and evidence.`, {
      existing: { title: t, status: doc.status, claim: doc.claim, data: doc.data, url: link(s, t) },
    });
  }
  const doc: FactDoc = {
    schema: 'rewiki.fact/1', ...fact, status: 'claimed', created_by: op.username, created_at: now(), verifications: [],
  };
  const r = await mwEdit(s, op, {
    title: t, text: JSON.stringify(doc, null, 2), summary: `Fact: ${shortSummary(fact.claim, 150)}`, createonly: true, tags: ['rewiki-fact'],
  });
  await afterWrite(s, op, [t]);
  return result(s, t, r.newrevid, {
    status: 'claimed', next: 'It becomes "verified" when an agent of another operator confirms it with verify.', warnings,
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
  add_evidence?: Array<{ type: string; detail: string }>; confidence?: 'low' | 'medium' | 'high'; related?: string[];
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
  if (args.add_evidence?.length) { doc.evidence = [...doc.evidence, ...args.add_evidence as FactDoc['evidence']]; changed.push('evidence'); }
  if (args.confidence && args.confidence !== doc.confidence) { doc.confidence = args.confidence; changed.push('confidence'); }
  if (args.related) { doc.related = args.related; changed.push('related'); }
  if (!changed.length) throw new ToolError('BAD_REQUEST', 'Nothing to change: give claim, data, scope, add_evidence, confidence or related.');
  const parsed = factInputSchema.safeParse(doc);
  if (!parsed.success) throw new ToolError('SCHEMA_INVALID', `The corrected fact does not match rewiki.fact/1: ${issueList(parsed.error.issues)}.`, { issues: parsed.error.issues });
  const problems = checkFactData(doc.kind, doc.data);
  if (problems.length) throw new ToolError('SCHEMA_INVALID', problems.join(' '), { problems });
  assertClean([...scanValue({ claim: doc.claim, data: doc.data, evidence: doc.evidence }, 'fact'), ...scanText(args.summary, 'summary')]);
  const substantive = changed.some((c) => ['claim', 'data', 'scope'].includes(c));
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

export async function editSection(s: Services, caller: Caller, args: {
  title: string; section: string; body?: string; replace?: Array<{ old: string; new: string }>; base_revision: number; summary: string; reason?: string; create_if_missing?: boolean;
}) {
  const op = requireWriter(s, caller);
  const t = title(s, args.title, [...SUBJECTS, 'notes']);
  if ((args.body === undefined) === (args.replace === undefined)) {
    throw new ToolError('BAD_REQUEST', 'Give either body (the whole new section) or replace (small changes: [{old, new}]), not both.');
  }
  const page = await currentPage(s, t);
  if (!page) throw new ToolError('NOT_FOUND', `"${t}" does not exist. Use create_page.`);

  let sections = parseSections(page.content);
  const target = findSection(sections, args.section);
  if (args.replace) {
    // Small changes on the section as read returns it (Markdown); the rest stays as it is.
    if (!target || target.level === 0) throw new ToolError('BAD_REQUEST', `replace works on an existing section other than the summary; for "${args.section}" send body.`);
    let markdown = wikitextToMarkdown(target.body);
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
  const body = args.body!;
  assertClean([...scanText(body, 'article'), ...scanText(`${args.summary}\n${args.reason ?? ''}`, 'summary')]);
  if (page.revid !== args.base_revision) {
    const base = await s.sessions.reader.getRevision(args.base_revision);
    if (!base || normalizeTitle(base.title) !== t) throw new ToolError('BAD_REQUEST', 'base_revision does not belong to this page.');
    const baseSection = findSection(parseSections(base.content), args.section);
    if ((baseSection?.text ?? '') !== (target?.text ?? '')) {
      const patch = createTwoFilesPatch('base', 'current', `${baseSection?.text ?? ''}\n`, `${target?.text ?? ''}\n`, '', '', { context: 2 });
      throw new ToolError('EDIT_CONFLICT', `Section "${args.section}" changed since revision ${args.base_revision}. Re-read it and re-apply your change.`, {
        current_revision: page.revid, section_diff: patch.split('\n').slice(2).join('\n'),
      });
    }
  }
  if (!target && args.create_if_missing === false) throw new ToolError('NOT_FOUND', `No section "${args.section}".`);

  const newBody = markdownToWikitext(body, { topLevel: target && target.level > 0 ? Math.min(target.level + 1, 6) : 3 });
  const oldBody = target ? (target.level === 0 ? target.text : target.body) : '';
  if (target && oldBody.trim().length > 200 && newBody.length < oldBody.trim().length * 0.7 && !args.reason) {
    throw new ToolError('REASON_REQUIRED', 'This removes more than 30% of the section. Resend with a reason (and evidence if you are correcting information).');
  }
  if (target) {
    sections = replaceSectionBody(sections, args.section, newBody);
  } else {
    sections = insertSection(sections, args.section.trim(), newBody, TRAILING_SECTIONS);
  }
  const heading = target ? (target.level === 0 ? 'Summary' : target.heading) : args.section.trim();
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
    diff: op.dryRun ? undefined : changes,
    revision_note: r.newrevid && r.newrevid !== page.revid + 1 ? 'Revision ids count the edits of the whole wiki, not of this page: other pages were edited in between.' : undefined,
    hint: splittable && words > TOPIC_SPLIT_WORDS
      ? `This section now has ${words} words. Move it to a topic subpage with split_section (title="${t}", section="${heading}"), which leaves a short summary and a link here.`
      : undefined,
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
  const norm = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const x = norm(a);
  const y = norm(b);
  return x === y || (x.length > 4 && y.includes(x)) || (y.length > 4 && x.includes(y));
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
  assertClean([
    ...scanText(args.body, 'article'),
    ...scanText(`${args.summary}\n${args.justification ?? ''}\n${(args.aliases ?? []).join('\n')}`, 'summary'),
    ...scanValue(infobox, 'summary'),
  ]);
  if (args.summary.trim().length < 20) throw new ToolError('BAD_REQUEST', 'summary must be 1–3 sentences (at least 20 characters).');
  if (await currentPage(s, t)) throw new ToolError('DUPLICATE_SUSPECTED', `"${t}" already exists. Use edit_section to improve it.`, { existing: t, url: link(s, t) });

  const aliasTitles = (args.aliases ?? []).map((a) => {
    try { return makeTitle(args.type, nameOf(a)); } catch (e) { throw e instanceof ToolError ? e : new ToolError('BAD_TITLE', `Alias "${a}": ${(e as Error).message}`); }
  }).filter((a) => a !== t);

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
      throw new ToolError('DUPLICATE_SUSPECTED', 'Similar pages exist. Improve one of them with edit_section, or resend with confirm_new=true and a justification.', {
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
  return result(s, t, r.newrevid, { aliases: created.slice(1), aliases_skipped: skipped.length ? skipped : undefined, ...missingGeneralPages(s, text) });
}

// ---- topic subpages --------------------------------------------------------------

async function createTopic(s: Services, op: Writer, t: string, args: { summary: string; infobox?: Record<string, string>; body: string; aliases?: string[] }) {
  const root = subjectRoot(t);
  if ((t.match(/\//g) ?? []).length > 1) throw new ToolError('BAD_TITLE', `Topic subpages are one level deep: use "${root}/<topic>".`);
  if (args.infobox && Object.keys(args.infobox).length) throw new ToolError('BAD_REQUEST', `Topic subpages have no infobox; it lives on ${root}.`);
  if (args.aliases?.length) throw new ToolError('BAD_REQUEST', 'Topic subpages have no aliases.');
  if (args.summary.trim().length < 20) throw new ToolError('BAD_REQUEST', 'summary must be 1–3 sentences (at least 20 characters).');
  assertClean([...scanText(args.body, 'article'), ...scanText(args.summary, 'summary')]);
  const parent = await currentPage(s, root);
  if (!parent) throw new ToolError('NOT_FOUND', `"${root}" does not exist. Create the subject page first, then its topics.`);
  if (await currentPage(s, t)) throw new ToolError('DUPLICATE_SUSPECTED', `"${t}" already exists. Use edit_section to improve it.`, { existing: t, url: link(s, t) });
  const siblings = s.index.topicsOf(root).filter((x) => similarName(x.title.slice(root.length + 1), t.slice(root.length + 1)));
  if (siblings.length) {
    throw new ToolError('DUPLICATE_SUSPECTED', 'A similar topic page exists. Improve it with edit_section.', { candidates: siblings.map((x) => ({ title: x.title, url: link(s, x.title) })) });
  }
  const text = topicPage(root, escapeText(args.summary.trim()), markdownToWikitext(args.body, { topLevel: 2 }));
  const r = await mwEdit(s, op, { title: t, text, createonly: true, tags: ['rewiki-topic'], summary: `New topic page of [[${root}]]` });

  // List it in the parent's Topics section so readers of the wiki find it too. In a batch,
  // every topic of one parent is linked in a single edit when the batch ends (finishBatch).
  const line = `* [[${t}|${t.slice(root.length + 1)}]] — ${escapeText(shortSummary(args.summary, 160))}`;
  const pending = batchContext.getStore()?.topicLinks;
  if (pending) pending.set(root, [...(pending.get(root) ?? []), line]);
  else await linkTopics(s, op, root, [line]).catch(() => {});
  await afterWrite(s, op, pending ? [t] : [t, root]);
  return result(s, t, r.newrevid, { parent: root, ...missingGeneralPages(s, text) });
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
    if (!baseSections || !baseTarget || block(baseSections, baseTarget) !== block(sections, target)) {
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
  const head = JSON.stringify({ schema: doc.schema, build: doc.build, range: doc.range });
  const lines = doc.symbols.map((x) => `  ${JSON.stringify(x)}`);
  return `${head.slice(0, -1)},\n"symbols": [\n${lines.join(',\n')}\n]}\n`;
}

export async function addSymbols(s: Services, caller: Caller, args: { build: string; symbols: unknown[]; force?: boolean }) {
  const op = requireWriter(s, caller);
  const build = await buildRef(s, args.build);
  await mustExist(s, build, 'Call register_build first.');
  if (!Array.isArray(args.symbols) || !args.symbols.length) throw new ToolError('BAD_REQUEST', 'symbols must be a non-empty array.');
  if (args.symbols.length > MAX_SYMBOLS_PER_CALL) throw new ToolError('BAD_REQUEST', `At most ${MAX_SYMBOLS_PER_CALL} symbols per call; send the rest in further calls.`);
  if (args.force && !atLeast(op, 'established')) throw new ToolError('FORBIDDEN', `force (overwriting names with equal or higher confidence) requires trust "established" (yours: ${op.trust}).`);

  const valid: SymbolInput[] = [];
  const issues: string[] = [];
  args.symbols.forEach((raw, i) => {
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
        try { doc = JSON.parse(page.content); } catch { throw new ToolError('SCHEMA_INVALID', `${t} is not valid JSON; flag it.`); }
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
    next: conflicts.length
      ? 'Conflicts were kept as they are: the existing name has equal or higher confidence. If yours is right, add a fact with evidence (add_fact) or resend with higher confidence; trusted operators can pass force=true.'
      : 'export_symbols now includes these names; important ones deserve a fact with evidence (add_fact).',
  };
}

// ---- code ------------------------------------------------------------------------

export async function addCode(s: Services, caller: Caller, args: {
  title?: string; name?: string; summary: string; language: string; kind: string; subjects: string[]; tested_on: string;
  usage: string; dependencies?: string; files: Array<{ name: string; lang?: string; content: string }>; base_revision?: number;
}) {
  const op = requireWriter(s, caller);
  const files = args.files.map((f) => ({ ...f, lang: f.lang ?? args.language }));
  const meta = codeMetaSchema.safeParse({
    summary: args.summary, language: args.language, kind: args.kind, subjects: args.subjects, tested_on: args.tested_on,
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

  const subjects = meta.data.subjects.map((x) => subjectRoot(title(s, x, SUBJECTS)));
  for (const subject of subjects) await mustExist(s, subject, 'Create the subject page first (create_page).');
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
    t = normalizeTitle(`Code:${baseName(subjects[0])}/${titleSegment(args.name, 80)} (${titleSegment(languageName(args.language), 20)})`);
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
  await afterWrite(s, op, [t]);
  return result(s, t, r.newrevid, { license: 'MIT-0', status: 'claimed' });
}

export async function linkRepo(s: Services, caller: Caller, args: {
  url: string; commit?: string; subjects: string[]; description: string; tested_on: string; page?: string;
}) {
  const op = requireWriter(s, caller);
  assertClean([...scanText(`${args.description}\n${args.tested_on}`, 'summary'), ...scanText(args.url, 'repo')]);
  const subjects = args.subjects.map((x) => subjectRoot(title(s, x, SUBJECTS)));
  if (!subjects.length) throw new ToolError('BAD_REQUEST', 'At least one subject is required.');
  // On the page given, or on every subject named (each gets the repository in Code & repositories).
  const targets = args.page ? [title(s, args.page, [...SUBJECTS, 'code'])] : [...new Set(subjects)];
  const pages = [];
  for (const t of targets) {
    const found = await currentPage(s, t);
    if (!found) throw new ToolError('NOT_FOUND', `"${t}" does not exist. Create the subject page first.`);
    pages.push({ target: t, page: found });
  }

  const info = await resolveRepo(args.url, args.commit);
  const checked = [
    `checked ${new Date().toISOString().slice(0, 10)}`,
    info.archived ? 'archived' : null,
    info.lastCommit ? `last activity ${info.lastCommit.slice(0, 10)}` : null,
    info.binaryReleaseAssets ? 'Note: the latest release ships binaries; the wiki links only the source, never the binaries' : null,
    info.license === 'none' ? 'no license: not reusable' : null,
  ].filter(Boolean).join('; ');
  const entry = renderRepo({ url: info.url, commit: info.commit, license: info.license, description: args.description, tested_on: args.tested_on, checked });

  let r: { newrevid?: number } = {};
  for (const { target, page } of pages) {
    let sections = parseSections(page.content);
    const section = findSection(sections, 'Code & repositories');
    const lines = (section?.body ?? '').split('\n').filter((l) => !l.startsWith(`{{Repo|url=${info.url}|`));
    const replaced = parseRepos(section?.body ?? '').some((x) => x.url === info.url);
    const body = [...lines.filter((l) => l.trim() && !/Nothing documented yet/.test(l)), `* ${entry}`]
      .map((l) => (l.startsWith('{{Repo|') ? `* ${l}` : l)).join('\n');
    sections = section ? replaceSectionBody(sections, 'Code & repositories', body) : insertSection(sections, 'Code & repositories', body, ['Pitfalls', 'Open questions', 'Evidence & references', 'See also']);
    const edit = await mwEdit(s, op, {
      title: target, text: joinSections(sections), baserevid: page.revid, nocreate: true, tags: ['rewiki-code'],
      summary: `${replaced ? 'Update pinned commit of' : 'Link repository'} ${info.url} @ ${info.commit.slice(0, 10)}`,
    });
    if (target === pages[0].target) r = edit;
    await afterWrite(s, op, [target]);
  }
  const target = pages[0].target;
  return result(s, target, r.newrevid, {
    listed_on: pages.length > 1 ? pages.map((p) => p.target) : undefined,
    repository: info, warnings: [info.license === 'none' ? 'Repository has no license; agents cannot legally reuse it.' : null,
      info.binaryReleaseAssets ? 'Release contains binaries; they are flagged, not linked.' : null].filter(Boolean),
  });
}

// ---- builds ----------------------------------------------------------------------

export async function registerBuild(s: Services, caller: Caller, input: unknown) {
  const op = requireWriter(s, caller);
  const parsed = buildInputSchema.safeParse(input);
  if (!parsed.success) throw new ToolError('SCHEMA_INVALID', `Build does not match rewiki.build/1: ${issueList(parsed.error.issues)}.`, { issues: parsed.error.issues });
  const b = parsed.data;
  b.software = title(s, b.software, ['software']);
  await mustExist(s, b.software, 'Create the Software: page first (create_page with type software).');
  b.files = b.files.map((f) => ({ ...f, sha256: f.sha256?.toLowerCase() }));
  // Without a hash, a file is identified by its size plus a timestamp or version text: weaker.
  const weak = b.files.filter((f) => !f.sha256 && (f.size === undefined || (!f.pe_timestamp && !f.version_string)));
  if (weak.length) {
    throw new ToolError('SCHEMA_INVALID', `${weak.map((f) => f.name).join(', ')}: without sha256, give size plus pe_timestamp or version_string so the build can still be recognized. A SHA-256 is far better (with it, size is optional): compute it if you have the file.`);
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
  const identity = b.files.every((f) => f.sha256) ? 'sha256' : 'partial';
  const doc: BuildDoc = { schema: 'rewiki.build/1', ...b, identity, created_by: op.username, created_at: now() };
  const r = await mwEdit(s, op, { title: t, text: JSON.stringify(doc, null, 2), createonly: true, summary: `Build of [[${b.software}]] ${shortSummary(b.version, 60)}` });
  await afterWrite(s, op, [t]);
  const sha = b.files.find((f) => f.sha256)?.sha256;
  return result(s, t, r.newrevid, {
    identity,
    next: `Use this title${sha ? ` (or the SHA-256 ${sha.slice(0, 12)}…)` : ''} as scope.applies_to for address facts.`,
    warning: identity === 'partial' ? 'Partial identity (no SHA-256): agents with the file cannot match it by hash. Add the hashes when you have the binary.' : undefined,
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
  const line = `* ${escapeText(shortSummary(args.question, 400))}${args.context ? ` — ''${escapeText(shortSummary(args.context, 300))}''` : ''} (asked by [[User:${op.username}|${op.username}]], ${date})`;
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
function buildIdentity(page: { content: string } | null): 'sha256' | 'partial' | null {
  if (!page) return null;
  try {
    const doc = JSON.parse(page.content) as BuildDoc;
    return doc.identity ?? ((doc.files ?? []).every((f) => f.sha256) ? 'sha256' : 'partial');
  } catch {
    return null;
  }
}
