import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type TrustLevel = 'new' | 'established' | 'trusted' | 'curator';
export type Mode = 'read' | 'review' | 'write';

export interface Operator {
  id: number;
  username: string;
  username_key: string;
  skeleton: string;
  email_enc: string;
  email_hash: string;
  mw_password_enc: string;
  trust: TrustLevel;
  mode: Mode;
  terms_version: string;
  terms_accepted_at: string;
  created_at: string;
  blocked_at: string | null;
  writes: number;
}

export interface TokenRow {
  id: number;
  operator_id: number;
  token_hash: string;
  label: string;
  created_at: string;
  last_used_at: string;
  expires_at: string;
  revoked_at: string | null;
  /** Set when the token came from the OAuth flow (remote MCP): the gateway enforces review mode itself. */
  oauth_client_id: string | null;
}

/** A publication waiting for the operator's approval in the browser (review mode). */
export interface ReviewRow {
  id: string;
  operator_id: number;
  tool: string;
  args_hash: string;
  preview: string;
  created_at: number;
  expires_at: number;
  status: 'pending' | 'approved' | 'declined' | 'used';
}

export interface OAuthClient {
  client_id: string;
  name: string;
  redirect_uris: string;
  created_at: string;
  ip: string;
}

export interface OAuthCode {
  code_hash: string;
  client_id: string;
  operator_id: number;
  redirect_uri: string;
  code_challenge: string;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

export interface Challenge {
  id: string;
  /** signup: the browser login page's code for an email without an account (account created after it). */
  kind: 'login' | 'register' | 'signup';
  username: string;
  username_key: string;
  email_enc: string | null;
  email_hash: string | null;
  operator_id: number | null;
  code_hash: string;
  nonce_hash: string;
  attempts: number;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  ip: string;
  client_label: string;
  consent_json: string | null;
  valid: number;
}

export interface FlagRow {
  id: number;
  operator_id: number;
  title: string;
  revision: number | null;
  reason: string;
  details: string;
  /** MediaWiki user who made the flagged revision (resolved when the flag is created). */
  author: string | null;
  created_at: string;
  status: 'open' | 'upheld' | 'dismissed';
  resolved_at: string | null;
}

const SCHEMA = `
create table if not exists operators (
  id integer primary key,
  username text not null,
  username_key text not null unique,
  skeleton text not null,
  email_enc text not null,
  email_hash text not null unique,
  mw_password_enc text not null,
  trust text not null default 'new',
  mode text not null default 'review',
  terms_version text not null,
  terms_accepted_at text not null,
  created_at text not null,
  blocked_at text,
  writes integer not null default 0
);
create index if not exists operators_skeleton on operators(skeleton);

create table if not exists tokens (
  id integer primary key,
  operator_id integer not null references operators(id),
  token_hash text not null unique,
  label text not null default '',
  created_at text not null,
  last_used_at text not null,
  expires_at text not null,
  revoked_at text
);

-- Earlier names of renamed accounts: kept reserved, and used to tell who wrote a fact or code page
-- whose created_by still holds the old name.
create table if not exists username_history (
  operator_id integer not null references operators(id),
  username text not null,
  username_key text not null,
  skeleton text not null,
  renamed_at text not null
);
create index if not exists username_history_key on username_history(username_key);
create index if not exists username_history_skeleton on username_history(skeleton);

-- Browser sessions on the gateway's own pages (review approvals). Set when the human logs in
-- there or authorizes an MCP client; agents never see them.
create table if not exists web_sessions (
  token_hash text primary key,
  operator_id integer not null references operators(id),
  created_at integer not null,
  expires_at integer not null
);

create table if not exists reviews (
  id text primary key,
  operator_id integer not null references operators(id),
  tool text not null,
  args_hash text not null,
  preview text not null,
  created_at integer not null,
  expires_at integer not null,
  status text not null default 'pending'
);

create table if not exists oauth_clients (
  client_id text primary key,
  name text not null,
  redirect_uris text not null,
  created_at text not null,
  ip text not null
);

create table if not exists oauth_codes (
  code_hash text primary key,
  client_id text not null,
  operator_id integer not null references operators(id),
  redirect_uri text not null,
  code_challenge text not null,
  created_at integer not null,
  expires_at integer not null,
  consumed_at integer
);

create table if not exists challenges (
  id text primary key,
  kind text not null,
  username text not null,
  username_key text not null,
  email_enc text,
  email_hash text,
  operator_id integer,
  code_hash text not null,
  nonce_hash text not null,
  attempts integer not null default 0,
  created_at text not null,
  expires_at text not null,
  consumed_at text,
  ip text not null,
  client_label text not null default '',
  consent_json text,
  valid integer not null default 1
);

create table if not exists rate_events (
  scope text not null,
  key text not null,
  at integer not null
);
create index if not exists rate_events_lookup on rate_events(scope, key, at);

create table if not exists action_log (
  id integer primary key,
  operator_id integer not null,
  action text not null,
  title text not null,
  revision integer,
  reason text,
  at integer not null
);
create index if not exists action_log_lookup on action_log(action, title, at);

create table if not exists flags (
  id integer primary key,
  operator_id integer not null,
  title text not null,
  revision integer,
  reason text not null,
  details text not null default '',
  author text,
  created_at text not null,
  status text not null default 'open',
  resolved_at text
);

create table if not exists mail_outbox (
  id integer primary key,
  idempotency_key text not null unique,
  template text not null,
  to_enc text not null,
  to_hash text not null,
  data_enc text not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  next_attempt_at integer not null,
  provider_id text,
  error text,
  created_at integer not null,
  sent_at integer
);

create table if not exists suppressed_emails (
  email_hash text primary key,
  reason text not null,
  at integer not null
);
`;

export class AccountsDb {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 10000;');
    this.db.exec(SCHEMA);
    // Columns added after the first release (create table if not exists keeps old tables as they were).
    const tokenColumns = (this.db.prepare('pragma table_info(tokens)').all() as Array<{ name: string }>).map((c) => c.name);
    if (!tokenColumns.includes('oauth_client_id')) this.db.exec('alter table tokens add column oauth_client_id text');
  }

  // ---- operators -----------------------------------------------------------

  operatorById(id: number): Operator | undefined {
    return this.db.prepare('select * from operators where id = ?').get(id) as Operator | undefined;
  }

  operatorByUsernameKey(key: string): Operator | undefined {
    return this.db.prepare('select * from operators where username_key = ?').get(key) as Operator | undefined;
  }

  operatorByEmailHash(hash: string): Operator | undefined {
    return this.db.prepare('select * from operators where email_hash = ?').get(hash) as Operator | undefined;
  }

  operatorsBySkeleton(skeleton: string): Operator[] {
    return this.db.prepare('select * from operators where skeleton = ?').all(skeleton) as unknown as Operator[];
  }

  insertOperator(op: Omit<Operator, 'id' | 'writes' | 'blocked_at'>): number {
    const result = this.db
      .prepare(`insert into operators (username, username_key, skeleton, email_enc, email_hash, mw_password_enc,
        trust, mode, terms_version, terms_accepted_at, created_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(op.username, op.username_key, op.skeleton, op.email_enc, op.email_hash, op.mw_password_enc,
        op.trust, op.mode, op.terms_version, op.terms_accepted_at, op.created_at);
    return Number(result.lastInsertRowid);
  }

/** Renames an account: the old name goes to the history (reserved), flags against it follow the account. */
  renameOperator(id: number, next: { username: string; username_key: string; skeleton: string }): void {
    const op = this.operatorById(id);
    if (!op) throw new Error(`No operator ${id}`);
    this.db.exec('begin');
    try {
      this.db.prepare('insert into username_history (operator_id, username, username_key, skeleton, renamed_at) values (?, ?, ?, ?, ?)')
        .run(id, op.username, op.username_key, op.skeleton, new Date().toISOString());
      this.db.prepare('update operators set username = ?, username_key = ?, skeleton = ? where id = ?')
        .run(next.username, next.username_key, next.skeleton, id);
      this.db.prepare('update flags set author = ? where author = ?').run(next.username, op.username);
      this.db.exec('commit');
    } catch (error) {
      this.db.exec('rollback');
      throw error;
    }
  }

  /** The account that uses or used this name (names are never reused), if any. */
  operatorIdByAnyUsername(name: string): number | undefined {
    const key = name.trim().toLowerCase().replace(/_/g, ' ');
    const current = this.db.prepare('select id from operators where username_key = ?').get(key) as { id: number } | undefined;
    if (current) return current.id;
    const old = this.db.prepare('select operator_id from username_history where username_key = ? order by renamed_at desc limit 1').get(key) as { operator_id: number } | undefined;
    return old?.operator_id;
  }

  /** Whether a former name of another account blocks this one (same name or look-alike). */
  usernameRetired(key: string, skeleton: string, exceptOperatorId?: number): boolean {
    const row = this.db.prepare('select operator_id from username_history where (username_key = ? or skeleton = ?) and operator_id != ? limit 1')
      .get(key, skeleton, exceptOperatorId ?? -1);
    return !!row;
  }

  setTrust(id: number, trust: TrustLevel): void {
    this.db.prepare('update operators set trust = ? where id = ?').run(trust, id);
  }

  setMode(id: number, mode: Mode): void {
    this.db.prepare('update operators set mode = ? where id = ?').run(mode, id);
  }

  setBlocked(id: number, blocked: boolean): void {
    this.db.prepare('update operators set blocked_at = ? where id = ?').run(blocked ? new Date().toISOString() : null, id);
  }

  incrementWrites(id: number): number {
    this.db.prepare('update operators set writes = writes + 1 where id = ?').run(id);
    return (this.operatorById(id)?.writes ?? 0);
  }

  operatorsByUsernames(usernames: string[]): Map<string, Operator> {
    const map = new Map<string, Operator>();
    for (const name of new Set(usernames)) {
      const op = this.db.prepare('select * from operators where username = ?').get(name) as Operator | undefined;
      if (op) map.set(name, op);
    }
    return map;
  }

  // ---- tokens --------------------------------------------------------------

  insertToken(operatorId: number, tokenHash: string, label: string, expiresAt: string, oauthClientId: string | null = null): void {
    const now = new Date().toISOString();
    this.db.prepare(`insert into tokens (operator_id, token_hash, label, created_at, last_used_at, expires_at, oauth_client_id)
      values (?, ?, ?, ?, ?, ?, ?)`).run(operatorId, tokenHash, label, now, now, expiresAt, oauthClientId);
  }

  tokenByHash(hash: string): TokenRow | undefined {
    return this.db.prepare('select * from tokens where token_hash = ?').get(hash) as TokenRow | undefined;
  }

  touchToken(id: number, expiresAt: string): void {
    this.db.prepare('update tokens set last_used_at = ?, expires_at = ? where id = ?')
      .run(new Date().toISOString(), expiresAt, id);
  }

  revokeToken(id: number): void {
    this.db.prepare('update tokens set revoked_at = ? where id = ? and revoked_at is null').run(new Date().toISOString(), id);
  }

  revokeAllTokens(operatorId: number): void {
    this.db.prepare('update tokens set revoked_at = ? where operator_id = ? and revoked_at is null')
      .run(new Date().toISOString(), operatorId);
  }

  // ---- browser sessions and reviews ----------------------------------------

  insertWebSession(tokenHash: string, operatorId: number, expiresAt: number): void {
    this.db.prepare('insert into web_sessions (token_hash, operator_id, created_at, expires_at) values (?, ?, ?, ?)').run(tokenHash, operatorId, Date.now(), expiresAt);
  }

  webSessionOperator(tokenHash: string): number | undefined {
    const row = this.db.prepare('select operator_id, expires_at from web_sessions where token_hash = ?').get(tokenHash) as { operator_id: number; expires_at: number } | undefined;
    return row && row.expires_at > Date.now() ? row.operator_id : undefined;
  }

  insertReview(review: Omit<ReviewRow, 'status'>): void {
    this.db.prepare('insert into reviews (id, operator_id, tool, args_hash, preview, created_at, expires_at) values (?, ?, ?, ?, ?, ?, ?)')
      .run(review.id, review.operator_id, review.tool, review.args_hash, review.preview, review.created_at, review.expires_at);
  }

  review(id: string): ReviewRow | undefined {
    return this.db.prepare('select * from reviews where id = ?').get(id) as ReviewRow | undefined;
  }

  /** Moves a review from one status to another; false if it was not in the expected status. */
  setReviewStatus(id: string, from: ReviewRow['status'], to: ReviewRow['status']): boolean {
    return this.db.prepare('update reviews set status = ? where id = ? and status = ?').run(to, id, from).changes === 1;
  }

  pruneReviews(): void {
    this.db.prepare('delete from reviews where expires_at < ?').run(Date.now() - 86_400_000);
    this.db.prepare('delete from web_sessions where expires_at < ?').run(Date.now());
  }

  // ---- OAuth (remote MCP clients) -------------------------------------------

  insertOAuthClient(client: OAuthClient): void {
    this.db.prepare('insert into oauth_clients (client_id, name, redirect_uris, created_at, ip) values (?, ?, ?, ?, ?)')
      .run(client.client_id, client.name, client.redirect_uris, client.created_at, client.ip);
  }

  oauthClient(clientId: string): OAuthClient | undefined {
    return this.db.prepare('select * from oauth_clients where client_id = ?').get(clientId) as OAuthClient | undefined;
  }

  insertOAuthCode(code: Omit<OAuthCode, 'consumed_at'>): void {
    this.db.prepare(`insert into oauth_codes (code_hash, client_id, operator_id, redirect_uri, code_challenge, created_at, expires_at)
      values (?, ?, ?, ?, ?, ?, ?)`).run(code.code_hash, code.client_id, code.operator_id, code.redirect_uri, code.code_challenge, code.created_at, code.expires_at);
  }

  /** Marks an authorization code used and returns it; undefined when unknown, expired or already used. */
  takeOAuthCode(codeHash: string): OAuthCode | undefined {
    const row = this.db.prepare('select * from oauth_codes where code_hash = ?').get(codeHash) as OAuthCode | undefined;
    if (!row || row.consumed_at || row.expires_at < Date.now()) return undefined;
    const taken = this.db.prepare('update oauth_codes set consumed_at = ? where code_hash = ? and consumed_at is null').run(Date.now(), codeHash);
    return taken.changes === 1 ? row : undefined;
  }

  // ---- challenges ----------------------------------------------------------

  insertChallenge(c: Omit<Challenge, 'attempts' | 'consumed_at'>): void {
    this.db.prepare(`insert into challenges (id, kind, username, username_key, email_enc, email_hash, operator_id,
        code_hash, nonce_hash, created_at, expires_at, ip, client_label, consent_json, valid)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(c.id, c.kind, c.username, c.username_key, c.email_enc, c.email_hash, c.operator_id, c.code_hash,
        c.nonce_hash, c.created_at, c.expires_at, c.ip, c.client_label, c.consent_json, c.valid);
  }

  challenge(id: string): Challenge | undefined {
    return this.db.prepare('select * from challenges where id = ?').get(id) as Challenge | undefined;
  }

  bumpChallengeAttempts(id: string): void {
    this.db.prepare('update challenges set attempts = attempts + 1 where id = ?').run(id);
  }

  consumeChallenge(id: string): void {
    this.db.prepare('update challenges set consumed_at = ? where id = ?').run(new Date().toISOString(), id);
  }

  // ---- rate limiting -------------------------------------------------------

  /** Records an event if under every limit; returns false (and records nothing) when a limit is hit. */
  /** True when every limit still has room; records nothing. */
  peekRate(limits: Array<{ scope: string; key: string; max: number; windowSeconds: number }>): boolean {
    const now = Date.now();
    return limits.every((limit) => {
      const row = this.db.prepare('select count(*) as n from rate_events where scope = ? and key = ? and at > ?')
        .get(limit.scope, limit.key, now - limit.windowSeconds * 1000) as { n: number };
      return row.n < limit.max;
    });
  }

  takeRate(limits: Array<{ scope: string; key: string; max: number; windowSeconds: number }>): boolean {
    const now = Date.now();
    for (const limit of limits) {
      const row = this.db.prepare('select count(*) as n from rate_events where scope = ? and key = ? and at > ?')
        .get(limit.scope, limit.key, now - limit.windowSeconds * 1000) as { n: number };
      if (row.n >= limit.max) return false;
    }
    const insert = this.db.prepare('insert into rate_events (scope, key, at) values (?, ?, ?)');
    for (const limit of limits) insert.run(limit.scope, limit.key, now);
    return true;
  }

  pruneRateEvents(olderThanSeconds = 2 * 86400): void {
    this.db.prepare('delete from rate_events where at < ?').run(Date.now() - olderThanSeconds * 1000);
  }

  // ---- action log, flags ---------------------------------------------------

  logAction(operatorId: number, action: string, title: string, revision: number | null, reason: string | null): void {
    this.db.prepare('insert into action_log (operator_id, action, title, revision, reason, at) values (?, ?, ?, ?, ?, ?)')
      .run(operatorId, action, title, revision, reason, Date.now());
  }

  actionsSince(action: string, title: string, sinceMs: number): Array<{ operator_id: number; at: number }> {
    return this.db.prepare('select operator_id, at from action_log where action = ? and title = ? and at > ?')
      .all(action, title, sinceMs) as Array<{ operator_id: number; at: number }>;
  }

  hasAction(operatorId: number, action: string, title: string, reason: string): boolean {
    return !!this.db.prepare('select 1 from action_log where operator_id = ? and action = ? and title = ? and reason = ?')
      .get(operatorId, action, title, reason);
  }

  insertFlag(f: Pick<FlagRow, 'operator_id' | 'title' | 'revision' | 'reason' | 'details' | 'author'>): number {
    const r = this.db.prepare(`insert into flags (operator_id, title, revision, reason, details, author, created_at)
      values (?, ?, ?, ?, ?, ?, ?)`)
      .run(f.operator_id, f.title, f.revision, f.reason, f.details, f.author, new Date().toISOString());
    return Number(r.lastInsertRowid);
  }

  flags(status?: FlagRow['status']): FlagRow[] {
    return (status
      ? this.db.prepare('select * from flags where status = ? order by id').all(status)
      : this.db.prepare('select * from flags order by id').all()) as unknown as FlagRow[];
  }

  resolveFlag(id: number, status: 'upheld' | 'dismissed'): void {
    this.db.prepare('update flags set status = ?, resolved_at = ? where id = ?').run(status, new Date().toISOString(), id);
  }

  upheldFlagsAgainst(username: string): number {
    const row = this.db.prepare("select count(*) as n from flags where status = 'upheld' and author = ?")
      .get(username) as { n: number };
    return row.n;
  }

  // ---- email suppression ---------------------------------------------------

  isSuppressed(emailHash: string): boolean {
    return !!this.db.prepare('select 1 from suppressed_emails where email_hash = ?').get(emailHash);
  }

  suppress(emailHash: string, reason: string): void {
    this.db.prepare('insert or replace into suppressed_emails (email_hash, reason, at) values (?, ?, ?)')
      .run(emailHash, reason, Date.now());
  }
}
