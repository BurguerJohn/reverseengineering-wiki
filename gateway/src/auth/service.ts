/**
 * Passwordless accounts (design/08-accounts-and-auth.md). Codes go by email,
 * are bound to the requesting client (nonce), and tokens are only ever
 * returned to the client package — never to the model.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Config } from '../config.ts';
import type { AccountsDb, Mode, Operator, TokenRow } from '../db/accounts.ts';
import type { Mailer } from '../mail/index.ts';
import { takeIdentifierAllowance, takeSendAllowance } from '../mail/index.ts';
import type { SessionPool } from '../mw/sessions.ts';
import {
  newAccessToken, newOneTimeCode, normalizeEmail, randomBase62, safeEqualHex, sha256, type Secrets,
} from '../util/crypto.ts';
import { checkUsername, randomUsername, suggestions, usernameKey } from './usernames.ts';
import { quota } from './trust.ts';

export const CODE_TTL_MINUTES = 10;
export const MAX_ATTEMPTS = 5;
export const TOKEN_IDLE_DAYS = 90;
/** Renames per account in 30 days. */
export const MAX_RENAMES = 3;

/** What every login start says, whether or not the account exists (no enumeration). */
export const LOGIN_SENT_EMAIL = 'If an account uses this email address, a 6-digit code was sent to it.';
export const LOGIN_SENT_USERNAME = 'If this account exists, a 6-digit code was sent to its email address.';
const TOO_MANY_ACCOUNTS = 'Too many different accounts tried from this connection. Wait and try again later.';

export class AuthError extends Error {
  readonly code: string;
  readonly status: number;
  readonly extra: Record<string, unknown>;
  constructor(code: string, message: string, status = 400, extra: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[A-Za-z]{2,}$/;

export interface TokenGrant {
  token: string;
  expires_at: string;
  username: string;
  trust: string;
  mode: Mode;
}

export class AuthService {
  private readonly config: Config;
  private readonly db: AccountsDb;
  private readonly secrets: Secrets;
  private readonly mailer: Mailer;
  private readonly sessions: SessionPool;

  constructor(config: Config, db: AccountsDb, secrets: Secrets, mailer: Mailer, sessions: SessionPool) {
    this.config = config;
    this.db = db;
    this.secrets = secrets;
    this.mailer = mailer;
    this.sessions = sessions;
  }

  // ---- usernames ---------------------------------------------------------------

  private takenLocally(name: string): boolean {
    const check = checkUsername(name);
    return !!this.db.operatorByUsernameKey(check.key) || this.db.operatorsBySkeleton(check.skeleton).length > 0
      || this.db.usernameRetired(check.key, check.skeleton);
  }

  /** exceptOperatorId: the account being renamed (its own former names stay available to it). */
  async usernameAvailable(raw: string, exceptOperatorId?: number): Promise<{ available: boolean; username: string; reason?: string; suggestions: string[] }> {
    const check = checkUsername(String(raw ?? ''));
    const suggest = () => suggestions(check.username, (n) => this.takenLocally(n));
    if (!check.ok) return { available: false, username: check.username, reason: `Username ${check.reason}.`, suggestions: suggest() };
    const owner = this.db.operatorByUsernameKey(check.key);
    if (owner && owner.id !== exceptOperatorId) {
      return { available: false, username: check.username, reason: 'Username is already taken.', suggestions: suggest() };
    }
    if (this.db.operatorsBySkeleton(check.skeleton).some((o) => o.id !== exceptOperatorId)) {
      return { available: false, username: check.username, reason: 'Username is too similar to an existing one.', suggestions: suggest() };
    }
    if (this.db.usernameRetired(check.key, check.skeleton, exceptOperatorId)) {
      return { available: false, username: check.username, reason: 'Username was used by another account and stays reserved.', suggestions: suggest() };
    }
    const mw = await this.sessions.gateway();
    const exists = await mw.usersExist([check.username]);
    if (exists.get(check.username)) {
      return { available: false, username: check.username, reason: 'Username is already taken.', suggestions: suggest() };
    }
    return { available: true, username: check.username, suggestions: [] };
  }

  // ---- challenges --------------------------------------------------------------

  private codeHash(challengeId: string, code: string): string {
    return this.secrets.hmac(`${challengeId}:${code}`);
  }

  private newChallenge(fields: {
    kind: 'login' | 'register' | 'signup'; username: string; email?: string; operatorId?: number; nonceHash: string;
    ip: string; clientLabel: string; consent?: unknown; valid: boolean;
  }): { id: string; code: string } {
    const id = randomBase62(24);
    const code = newOneTimeCode();
    const now = new Date();
    this.db.insertChallenge({
      id,
      kind: fields.kind,
      username: fields.username,
      username_key: usernameKey(fields.username),
      email_enc: fields.email ? this.secrets.encrypt(fields.email) : null,
      email_hash: fields.email ? this.secrets.hmac(fields.email) : null,
      operator_id: fields.operatorId ?? null,
      code_hash: this.codeHash(id, code),
      nonce_hash: fields.nonceHash,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + CODE_TTL_MINUTES * 60_000).toISOString(),
      ip: fields.ip,
      client_label: fields.clientLabel.slice(0, 80),
      consent_json: fields.consent ? JSON.stringify(fields.consent) : null,
      valid: fields.valid ? 1 : 0,
    });
    return { id, code };
  }

  private checkNonceHash(nonceHash: unknown): string {
    if (typeof nonceHash !== 'string' || !/^[0-9a-f]{64}$/.test(nonceHash)) {
      throw new AuthError('BAD_REQUEST', 'client_nonce_hash must be the hex SHA-256 of a random client nonce');
    }
    return nonceHash;
  }

  private verifyChallenge(id: unknown, code: unknown, nonce: unknown, kind: 'login' | 'register' | 'signup') {
    const generic = new AuthError('INVALID_CODE', 'The code is invalid or expired. Request a new one if needed.', 401);
    if (typeof id !== 'string' || typeof code !== 'string' || typeof nonce !== 'string') throw generic;
    const challenge = this.db.challenge(id);
    if (!challenge || challenge.kind !== kind || challenge.consumed_at) throw generic;
    if (Date.parse(challenge.expires_at) < Date.now() || challenge.attempts >= MAX_ATTEMPTS) throw generic;
    this.db.bumpChallengeAttempts(id);
    const nonceOk = safeEqualHex(sha256(nonce), challenge.nonce_hash);
    const codeOk = safeEqualHex(this.codeHash(id, code.trim()), challenge.code_hash);
    if (!nonceOk || !codeOk || !challenge.valid) throw generic;
    this.db.consumeChallenge(id);
    return challenge;
  }

  // ---- registration ------------------------------------------------------------

  async registerStart(body: any, ip: string): Promise<{ challenge_id: string; expires_in_minutes: number; sent_to: string }> {
    const nonceHash = this.checkNonceHash(body?.client_nonce_hash);
    const email = normalizeEmail(String(body?.email ?? ''));
    if (!EMAIL.test(email)) throw new AuthError('INVALID_EMAIL', 'That does not look like a valid email address.');
    if (body?.consent?.policy !== true || body?.consent?.licenses !== true) {
      throw new AuthError('CONSENT_REQUIRED', 'You must accept the content policy and the licenses (CC BY-SA 4.0 for text, MIT-0 for code).');
    }
    const availability = await this.usernameAvailable(String(body?.username ?? ''));
    if (!availability.available) {
      throw new AuthError('USERNAME_UNAVAILABLE', availability.reason ?? 'Username unavailable.', 409, { suggestions: availability.suggestions });
    }
    const emailHash = this.secrets.hmac(email);
    if (!takeIdentifierAllowance(this.db, ip, emailHash)) throw new AuthError('RATE_LIMITED', TOO_MANY_ACCOUNTS, 429);
    if (!takeSendAllowance(this.db, { emailHash, ip })) {
      throw new AuthError('RATE_LIMITED', 'Too many codes requested. Wait a few minutes and try again.', 429);
    }
    const label = String(body?.client_label ?? '');
    const existing = this.db.operatorByEmailHash(emailHash);
    // Same response either way: the API never reveals whether an email is registered.
    const { id, code } = this.newChallenge({
      kind: 'register', username: availability.username, email, nonceHash, ip, clientLabel: label,
      consent: { ...body.consent, terms_version: this.config.termsVersion, at: new Date().toISOString() }, valid: !existing,
    });
    if (existing) {
      await this.mailer.sendMail({ to: email, template: 'account-exists', data: { username: existing.username, client_label: label }, idempotencyKey: id });
    } else {
      await this.mailer.sendMail({
        to: email, template: 'register-code', idempotencyKey: id,
        data: { code, username: availability.username, client_label: label, expires_minutes: String(CODE_TTL_MINUTES) },
      });
    }
    return { challenge_id: id, expires_in_minutes: CODE_TTL_MINUTES, sent_to: maskEmail(email) };
  }

  async registerVerify(body: any): Promise<TokenGrant> {
    const { operatorId, label } = await this.registerOperator(body);
    return this.issueToken(operatorId, String(body?.client_label ?? label));
  }

  /** Checks a registration code and creates the account (MediaWiki user included). */
  async registerOperator(body: any): Promise<{ operatorId: number; label: string }> {
    const challenge = this.verifyChallenge(body?.challenge_id, body?.code, body?.client_nonce, 'register');
    const consent = JSON.parse(challenge.consent_json ?? '{}');
    const operatorId = await this.createOperator({
      username: challenge.username, email: this.secrets.decrypt(challenge.email_enc!),
      termsVersion: consent.terms_version, termsAcceptedAt: consent.at,
    });
    return { operatorId, label: challenge.client_label };
  }

  /** Creates the account and its MediaWiki user. The email must already be proven (a checked code). */
  async createOperator(fields: { username: string; email: string; termsVersion?: string; termsAcceptedAt?: string; mode?: Mode }): Promise<number> {
    // Re-check: someone may have taken the name since the availability check.
    const availability = await this.usernameAvailable(fields.username);
    if (!availability.available) {
      throw new AuthError('USERNAME_UNAVAILABLE', `${availability.reason} Choose another username.`, 409, { suggestions: availability.suggestions });
    }
    const username = availability.username;
    const mwPassword = randomBase62(32);
    const mw = await this.sessions.gateway();
    await mw.createAccount(username, mwPassword);
    await mw.userRights(username, ['agent'], [], 'ReverseEngineering.wiki operator account');
    try {
      return this.db.insertOperator({
        username,
        username_key: usernameKey(username),
        skeleton: checkUsername(username).skeleton,
        email_enc: this.secrets.encrypt(fields.email),
        email_hash: this.secrets.hmac(fields.email),
        mw_password_enc: this.secrets.encrypt(mwPassword),
        trust: 'new',
        mode: fields.mode ?? 'review',
        terms_version: fields.termsVersion ?? this.config.termsVersion,
        terms_accepted_at: fields.termsAcceptedAt ?? new Date().toISOString(),
        created_at: new Date().toISOString(),
      });
    } catch {
      throw new AuthError('USERNAME_UNAVAILABLE', 'That username or email was registered a moment ago. Start again.', 409);
    }
  }

  // ---- email-first sign-in (the browser login page) ------------------------------------

  /**
   * One entry point for the browser: an email with an account gets a login code; an email
   * without one gets a code that creates the account once checked. The page says the same
   * thing in both cases; only the inbox owner learns which it was.
   */
  async emailCodeStart(body: any, ip: string): Promise<{ challenge_id: string; kind: 'login' | 'signup'; sent_to: string }> {
    const nonceHash = this.checkNonceHash(body?.client_nonce_hash);
    const email = normalizeEmail(String(body?.email ?? ''));
    if (!EMAIL.test(email)) throw new AuthError('INVALID_EMAIL', 'That does not look like a valid email address.');
    const label = String(body?.client_label ?? '');
    const emailHash = this.secrets.hmac(email);
    if (this.db.operatorByEmailHash(emailHash)) {
      const started = await this.loginStart({ email, client_nonce_hash: nonceHash, client_label: label }, ip);
      return { challenge_id: started.challenge_id, kind: 'login', sent_to: maskEmail(email) };
    }
    if (!takeIdentifierAllowance(this.db, ip, emailHash)) throw new AuthError('RATE_LIMITED', TOO_MANY_ACCOUNTS, 429);
    if (!takeSendAllowance(this.db, { emailHash, ip })) {
      throw new AuthError('RATE_LIMITED', 'Too many codes requested. Wait a few minutes and try again.', 429);
    }
    const { id, code } = this.newChallenge({ kind: 'signup', username: '', email, nonceHash, ip, clientLabel: label, valid: true });
    await this.mailer.sendMail({ to: email, template: 'signup-code', idempotencyKey: id, data: { code, client_label: label, expires_minutes: String(CODE_TTL_MINUTES) } });
    return { challenge_id: id, kind: 'signup', sent_to: maskEmail(email) };
  }

  /** Checks a signup code; returns the proven email (the account is created after the human accepts the terms). */
  signupVerify(body: any): { email: string } {
    const challenge = this.verifyChallenge(body?.challenge_id, body?.code, body?.client_nonce, 'signup');
    return { email: this.secrets.decrypt(challenge.email_enc!) };
  }

  /** A free random name for a new account. */
  suggestUsername(): string {
    return randomUsername((name) => this.takenLocally(name));
  }

  // ---- renaming ------------------------------------------------------------------------

  /**
   * Changes the public username. Edits stay attributed to the same account (MediaWiki keeps
   * them by user ID); the old name stays reserved for this account.
   */
  async rename(op: Operator, raw: unknown): Promise<{ username: string; previous: string }> {
    const availability = await this.usernameAvailable(String(raw ?? ''), op.id);
    if (!availability.available) {
      throw new AuthError('USERNAME_UNAVAILABLE', availability.reason ?? 'Username unavailable.', 409, { suggestions: availability.suggestions });
    }
    const next = availability.username;
    if (next === op.username) return { username: next, previous: op.username };
    if (!this.db.takeRate([{ scope: 'rename', key: String(op.id), max: MAX_RENAMES, windowSeconds: 30 * 86400 }])) {
      throw new AuthError('RATE_LIMITED', `At most ${MAX_RENAMES} renames in 30 days.`, 429);
    }
    const mw = this.config.mw;
    await promisify(execFile)(mw.phpBin, [
      'maintenance/run.php', 'renameUser', op.username, next,
      '--performer', mw.gatewayUser, '--reason', 'Renamed by the account owner',
    ], { cwd: mw.dir, env: mw.env, timeout: 120_000 });
    this.db.renameOperator(op.id, { username: next, username_key: usernameKey(next), skeleton: checkUsername(next).skeleton });
    this.sessions.forget(op.id);
    return { username: next, previous: op.username };
  }

  // ---- login -------------------------------------------------------------------

  /**
   * Log in with the username or the account's email (usernames cannot contain "@").
   * The response is the same whether or not the account exists, and an unknown address
   * gets no email at all: the system only ever writes to registered addresses.
   */
  async loginStart(body: any, ip: string): Promise<{ challenge_id: string; expires_in_minutes: number; message: string }> {
    const nonceHash = this.checkNonceHash(body?.client_nonce_hash);
    const identifier = String(body?.email ?? body?.username ?? '').trim();
    const byEmail = identifier.includes('@');
    let op: Operator | undefined;
    let typedEmail: string | undefined;
    let usernameKeyForLimit: string | undefined;
    let typedUsername = '';
    if (byEmail) {
      typedEmail = normalizeEmail(identifier);
      if (!EMAIL.test(typedEmail)) throw new AuthError('INVALID_EMAIL', 'That does not look like a valid email address.');
      op = this.db.operatorByEmailHash(this.secrets.hmac(typedEmail));
    } else {
      const check = checkUsername(identifier);
      op = this.db.operatorByUsernameKey(check.key);
      usernameKeyForLimit = check.key;
      typedUsername = check.username;
    }
    const emailHash = op?.email_hash ?? (typedEmail ? this.secrets.hmac(typedEmail) : undefined);
    // One account counts once, whether it was typed as username or email.
    const target = emailHash ?? this.secrets.hmac(`username:${usernameKeyForLimit}`);
    if (!takeIdentifierAllowance(this.db, ip, target)) throw new AuthError('RATE_LIMITED', TOO_MANY_ACCOUNTS, 429);
    if (!takeSendAllowance(this.db, { ip, username: op ? usernameKey(op.username) : usernameKeyForLimit, emailHash })) {
      throw new AuthError('RATE_LIMITED', 'Too many codes requested. Wait a few minutes and try again.', 429);
    }
    const label = String(body?.client_label ?? '');
    const usable = !!op && !op.blocked_at;
    const { id, code } = this.newChallenge({
      kind: 'login', username: op?.username ?? typedUsername, operatorId: op?.id, nonceHash, ip, clientLabel: label, valid: usable,
    });
    if (usable) {
      await this.mailer.sendMail({
        to: this.secrets.decrypt(op!.email_enc), template: 'login-code', idempotencyKey: id,
        data: { code, username: op!.username, client_label: label, expires_minutes: String(CODE_TTL_MINUTES) },
      });
    }
    return { challenge_id: id, expires_in_minutes: CODE_TTL_MINUTES, message: byEmail ? LOGIN_SENT_EMAIL : LOGIN_SENT_USERNAME };
  }

  /** The wiki's login form (custom/auth): email only, the browser's IP passed by MediaWiki. */
  async webLoginStart(body: any): Promise<{ challenge_id: string; expires_in_minutes: number; message: string }> {
    const email = String(body?.email ?? '').trim();
    if (!email.includes('@')) throw new AuthError('INVALID_EMAIL', 'Enter the email address of your account.');
    return this.loginStart({ email, client_nonce_hash: body?.client_nonce_hash, client_label: 'the wiki login page' }, String(body?.ip ?? 'unknown'));
  }

  /** Checks the code for the wiki and returns the account name; no API token is issued. */
  webLoginVerify(body: any): { username: string } {
    return { username: this.loginOperator(body).op.username };
  }

  async loginVerify(body: any): Promise<TokenGrant> {
    const { op, label } = this.loginOperator(body);
    return this.issueToken(op.id, String(body?.client_label ?? label));
  }

  /** Checks a login code and returns the account; no token is issued. */
  loginOperator(body: any): { op: Operator; label: string } {
    const challenge = this.verifyChallenge(body?.challenge_id, body?.code, body?.client_nonce, 'login');
    const op = this.db.operatorById(challenge.operator_id!);
    if (!op || op.blocked_at) throw new AuthError('INVALID_CODE', 'The code is invalid or expired.', 401);
    return { op, label: challenge.client_label };
  }

  // ---- tokens --------------------------------------------------------------------

  /** oauthClientId: tokens of remote MCP clients, for which the gateway itself enforces review mode. */
  issueToken(operatorId: number, label: string, oauthClientId: string | null = null): TokenGrant {
    const token = newAccessToken();
    const expires = new Date(Date.now() + TOKEN_IDLE_DAYS * 86_400_000).toISOString();
    this.db.insertToken(operatorId, sha256(token), label.slice(0, 80), expires, oauthClientId);
    const op = this.db.operatorById(operatorId)!;
    return { token, expires_at: expires, username: op.username, trust: op.trust, mode: op.mode };
  }

  authenticate(token: string | undefined): { operator: Operator; token: TokenRow } | null {
    if (!token || !/^rewiki_[A-Za-z0-9]{40}$/.test(token)) return null;
    const row = this.db.tokenByHash(sha256(token));
    if (!row || row.revoked_at || Date.parse(row.expires_at) < Date.now()) return null;
    const operator = this.db.operatorById(row.operator_id);
    if (!operator || operator.blocked_at) return null;
    if (Date.now() - Date.parse(row.last_used_at) > 3_600_000) {
      this.db.touchToken(row.id, new Date(Date.now() + TOKEN_IDLE_DAYS * 86_400_000).toISOString());
    }
    return { operator, token: row };
  }

  logout(tokenRow: TokenRow): void {
    this.db.revokeToken(tokenRow.id);
  }

  setMode(op: Operator, mode: unknown): Mode {
    if (mode !== 'read' && mode !== 'review' && mode !== 'write') throw new AuthError('BAD_REQUEST', 'mode must be read, review or write');
    this.db.setMode(op.id, mode);
    return mode;
  }

  status(op: Operator, token: TokenRow) {
    return {
      username: op.username, trust: op.trust, mode: op.mode, writes: op.writes,
      writes_this_hour: quota(this.db, op),
      token_label: token.label, token_expires_at: token.expires_at, created_at: op.created_at,
    };
  }
}

export function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  return `${user.slice(0, 2)}${'*'.repeat(Math.max(1, user.length - 2))}@${domain}`;
}
