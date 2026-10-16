/** Shared plumbing for tool implementations: services, errors, write preconditions. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Config } from '../config.ts';
import type { AccountsDb, Operator } from '../db/accounts.ts';
import type { SearchIndex } from '../index/index.ts';
import type { Indexer } from '../index/indexer.ts';
import type { SessionPool } from '../mw/sessions.ts';
import { MwError, type EditParams, type EditResult } from '../mw/client.ts';
import type { Secrets } from '../util/crypto.ts';
import { describe, type Finding } from '../policy/scanner.ts';
import { chargeWrite, hasWriteAllowance, maybePromote, quota } from '../auth/trust.ts';
import { pageUrl, typeOfTitle } from '../wiki/titles.ts';
import { wikitextToMarkdown } from '../wiki/wikitext.ts';
import { createTwoFilesPatch } from 'diff';

export interface Services {
  config: Config;
  db: AccountsDb;
  index: SearchIndex;
  indexer: Indexer;
  sessions: SessionPool;
  secrets: Secrets;
}

export interface Caller {
  operator: Operator | null;
  /** Validate everything, publish nothing (the dry_run argument of write tools). */
  dryRun?: boolean;
  /** Filled during a dry run: what each edit would store. */
  previews?: Preview[];
}

/** What one edit of a dry run would store: the whole page when new, a diff when it changes one. */
export interface Preview {
  title: string;
  action: 'create' | 'edit' | 'undo';
  content?: string;
  diff?: string;
}

/**
 * One batch of writes (the batch tool): titles created so far, with their text, so later
 * operations can refer to them, in a dry run too. Outside a batch there is no store.
 */
export const batchContext = new AsyncLocalStorage<BatchStore>();

export interface BatchStore {
  created: Map<string, string>;
  dryRun: boolean;
  /** Pages already fetched in this batch (dropped again when the batch edits them). */
  pageCache?: Map<string, Awaited<ReturnType<Services['sessions']['reader']['getPage']>>>;
  /** Titles to reindex once, when the batch ends. */
  refresh?: Set<string>;
  /** Topic lines to add to each parent's Topics section, in one edit per parent at the end. */
  topicLinks?: Map<string, string[]>;
}

/** MediaWiki's current version of a page; inside a batch each page is fetched once. */
export async function readPage(s: Services, title: string) {
  const cache = batchContext.getStore()?.pageCache;
  const hit = cache?.get(title);
  if (hit) return hit;
  const page = await s.sessions.reader.getPage(title);
  cache?.set(title, page);
  return page;
}

/** The operator of a write call. With dryRun, edits and side effects are skipped. */
export type Writer = Operator & { dryRun: boolean; previews?: Preview[] };

export class ToolError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export const TAG_MCP = 'rewiki-mcp';
export const TAGS = {
  [TAG_MCP]: 'Edit made through the ReverseEngineering.wiki MCP gateway',
  'rewiki-note': 'Field note',
  'rewiki-fact': 'Fact page created or updated',
  'rewiki-code': 'Code page created or updated',
  'rewiki-verify': 'Verification of a fact or code page',
  'rewiki-revert': 'Revert made through the ReverseEngineering.wiki MCP gateway',
  'rewiki-symbols': 'Symbol map of a build updated',
  'rewiki-topic': 'Topic subpage created or section moved to one',
} as const;

/** RATE_LIMITED with the numbers an agent needs to split or schedule its writes. */
export function quotaError(s: Services, op: Operator, needed?: number): ToolError {
  const q = quota(s.db, op);
  const what = needed !== undefined ? `This needs ${needed} writes, but only ${q.left} of ${q.limit}` : `All ${q.limit} writes`;
  return new ToolError('RATE_LIMITED', `${what} are left this hour for trust level "${op.trust}"${q.frees_in_minutes ? `; the next one frees up in ${q.frees_in_minutes} min` : ''}. Split the work, or wait. Nothing was published.`, {
    quota: { ...q, trust: op.trust, needed },
  });
}

/** The writer for follow-up edits of something already authorized (no second quota check). */
export function currentWriter(s: Services, caller: Caller): Writer {
  const fresh = caller.operator ? s.db.operatorById(caller.operator.id) : null;
  if (!fresh || fresh.blocked_at) throw new ToolError('AUTH_REQUIRED', 'This account is blocked.');
  return { ...fresh, dryRun: caller.dryRun === true, previews: caller.previews };
}

/** Whether a name recorded in a page (created_by, a verification) is this operator, under a current or former name. */
export function sameOperator(s: Services, name: string | undefined, op: Operator): boolean {
  if (!name) return false;
  if (name === op.username) return true;
  return s.db.operatorIdByAnyUsername(name) === op.id;
}

export function requireWriter(s: Services, caller: Caller): Writer {
  const op = caller.operator;
  if (!op) {
    throw new ToolError('AUTH_REQUIRED', 'Writing requires a ReverseEngineering.wiki account. Your user connects their MCP client to /mcp (it opens a login page in the browser; nothing to install), or uses the rewiki package (npx -y reverseengineering-wiki). Never ask them for a token.');
  }
  const fresh = s.db.operatorById(op.id);
  if (!fresh || fresh.blocked_at) throw new ToolError('AUTH_REQUIRED', 'This account is blocked.');
  if (fresh.mode === 'read') throw new ToolError('MODE_READ_ONLY', 'This account is in read-only mode. The operator can change it with account_set_mode.');
  // Dry runs use no quota, so they are never stopped by it (the answer says whether it would fit).
  if (!caller.dryRun && !hasWriteAllowance(s.db, fresh)) throw quotaError(s, fresh);
  return { ...fresh, dryRun: caller.dryRun === true, previews: caller.previews };
}

const CATEGORY_CODE: Record<string, string> = {
  privacy: 'PRIVACY_BLOCKED',
  injection: 'INJECTION_BLOCKED',
  code: 'CODE_BLOCKED',
  policy: 'POLICY_BLOCKED',
  links: 'POLICY_BLOCKED',
};

export function assertClean(findings: Finding[]): void {
  if (!findings.length) return;
  const order = ['privacy', 'injection', 'code', 'policy', 'links'];
  const first = [...findings].sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category))[0];
  const hint = first.category === 'privacy'
    ? 'Remove or generalize it (e.g. <game dir>\\file.exe instead of a user path) and resend. Do not repeat the value anywhere.'
    : first.category === 'injection'
      ? 'Write plain documentation; never address the reader or include hidden text.'
      : 'See REWiki:Content policy.';
  throw new ToolError(CATEGORY_CODE[first.category] ?? 'POLICY_BLOCKED', `Blocked by the content policy: ${describe(findings)}. ${hint}`, {
    findings: findings.map(({ rule, category, label, line, file }) => ({ rule, category, label, line, file })),
  });
}

/** Runs a MediaWiki edit as the operator and maps MediaWiki errors to tool errors. */
export async function mwEdit(s: Services, op: Writer, params: EditParams): Promise<EditResult> {
  const store = batchContext.getStore();
  if (op.dryRun) {
    op.previews?.push(await previewEdit(s, params));
    if (store && params.text !== undefined && (params.createonly || store.created.has(params.title))) store.created.set(params.title, params.text);
    return { title: params.title, nochange: false };
  }
  if (store && params.createonly && params.text !== undefined) store.created.set(params.title, params.text);
  store?.pageCache?.delete(params.title);
  const mw = await s.sessions.forOperator(op);
  try {
    return await mw.edit({ ...params, tags: [TAG_MCP, ...(params.tags ?? [])] });
  } catch (error) {
    if (error instanceof MwError) {
      if (error.code === 'editconflict') throw new ToolError('EDIT_CONFLICT', 'The page changed since your base revision. Re-read it and re-apply your change.');
      if (error.code === 'articleexists') throw new ToolError('DUPLICATE_SUSPECTED', `"${params.title}" already exists.`);
      if (error.code === 'missingtitle') throw new ToolError('NOT_FOUND', `"${params.title}" does not exist.`);
      if (error.code === 'protectedpage' || error.code === 'cascadeprotected') {
        throw new ToolError('PROTECTED', 'This page is locked to curators (usually because of a dispute). Use flag or the talk page.');
      }
      if (error.code === 'undofailure') {
        throw new ToolError('EDIT_CONFLICT', 'The revision cannot be undone automatically because later edits depend on it. Edit the content directly instead.');
      }
      if (/rewiki-policy|hookaborted|abusefilter/i.test(error.code + error.message)) {
        throw new ToolError('POLICY_BLOCKED', `MediaWiki rejected the edit: ${error.message.replace(/^[^:]+:\s*/, '')}`);
      }
      if (/ratelimited/.test(error.code)) throw new ToolError('RATE_LIMITED', 'MediaWiki rate limit reached. Back off and retry.');
    }
    throw error;
  }
}

function prettyStored(title: string, text: string): string {
  const type = typeOfTitle(title);
  if (type === 'fact' || type === 'build') {
    try { return `${JSON.stringify(JSON.parse(text), null, 2)}\n`; } catch { /* as stored */ }
  }
  return text.endsWith('\n') ? text : `${text}\n`;
}

async function previewEdit(s: Services, params: EditParams): Promise<Preview> {
  if (params.undo) return { title: params.title, action: 'undo', content: `Undo of revision ${params.undo}` };
  const text = params.text ?? '';
  const current = await readPage(s, params.title);
  if (!current.exists) {
    const type = typeOfTitle(params.title);
    const json = type === 'fact' || type === 'build' || type === 'symbols';
    return { title: params.title, action: 'create', content: json ? prettyStored(params.title, text) : wikitextToMarkdown(text) };
  }
  const patch = createTwoFilesPatch('current', 'after', prettyStored(params.title, current.content), prettyStored(params.title, text), '', '', { context: 2 });
  return { title: params.title, action: 'edit', diff: patch.split('\n').slice(2).join('\n') };
}

/** Bookkeeping after a successful write: quota, counters, trust promotion, index refresh. */
export async function afterWrite(s: Services, op: Writer, titles: string[]): Promise<void> {
  if (op.dryRun) return;
  chargeWrite(s.db, op);
  s.db.incrementWrites(op.id);
  await maybePromote(s.db, s.sessions, op.id).catch(() => {});
  const pending = batchContext.getStore()?.refresh;
  if (pending) for (const t of titles) pending.add(t);
  else await s.indexer.refresh(titles).catch(() => {});
}

/** Charges a write that does not go through afterWrite (patrol, flag). */
export function charge(s: Services, op: Writer): void {
  if (!op.dryRun) chargeWrite(s.db, op);
}

export function link(s: Services, title: string): string {
  return pageUrl(s.config.mw.publicUrl, title);
}

/** Wraps wiki content so the receiving agent can tell data from instructions. */
export function wrap(source: string, revision: number, body: string): string {
  const safeSource = source.replace(/"/g, "'");
  const safeBody = body.replace(/<\/wiki_content>/gi, '</wiki_content_>');
  return `<wiki_content source="${safeSource}" revision="${revision}" trust="untrusted">\n${safeBody}\n</wiki_content>`;
}

export function trustOf(s: Services, usernames: string[]): Map<string, string> {
  const ops = s.db.operatorsByUsernames(usernames);
  const out = new Map<string, string>();
  for (const name of usernames) {
    if (name === s.config.mw.gatewayUser) out.set(name, 'system');
    else out.set(name, ops.get(name)?.trust ?? 'moderator-or-unknown');
  }
  return out;
}

export function now(): string {
  return new Date().toISOString();
}
