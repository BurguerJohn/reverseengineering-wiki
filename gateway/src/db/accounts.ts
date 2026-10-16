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
}

export interface Challenge {
  id: string;
  kind: 'login' | 'register';
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
    this.db.exec('pragma journal_mode = wal; pragma foreign_keys = on;');
    this.db.exec(SCHEMA);
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

  insertToken(operatorId: number, tokenHash: string, label: string, expiresAt: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`insert into tokens (operator_id, token_hash, label, created_at, last_used_at, expires_at)
      values (?, ?, ?, ?, ?, ?)`).run(operatorId, tokenHash, label, now, now, expiresAt);
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
