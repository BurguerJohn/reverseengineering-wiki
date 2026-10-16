/**
 * Login / registration (design/08-accounts-and-auth.md#flows). Questions go to
 * the human through MCP elicitation; the token goes straight to the keychain
 * and is never returned to the model.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ApiError, type GatewayApi } from './api.ts';
import { deleteToken, getToken, rememberedAccount, saveConfig, setToken } from './store.ts';

export interface Session {
  username: string;
  trust: string;
  mode: 'read' | 'review' | 'write';
}

interface Pending {
  kind: 'login' | 'register';
  challengeId: string;
  nonce: string;
  username: string;
}

export class AuthDeclined extends Error {}

/** Usernames cannot contain "@", so an identifier with one is an email. */
export function loginIdentity(identifier: string): { username: string } | { email: string } {
  const value = identifier.trim();
  return value.includes('@') ? { email: value } : { username: value };
}

export class AuthRequired extends Error {
  readonly instructions: string;
  constructor(instructions: string) {
    super('AUTH_REQUIRED');
    this.instructions = instructions;
  }
}

const fallbackInstructions = (remembered: string | null) => `Writing to ReverseEngineering.wiki needs an account and this MCP client cannot show login prompts.
Ask your user (the human operator):${remembered ? `
- This machine last used the account "${remembered}": ask whether to log in with it again (account_login with username "${remembered}").` : ''}
- If they already have a ReverseEngineering.wiki account: their username or the account's email, then call account_login.
- Otherwise: a public username (not their real name) and their email, and whether they accept the
  content policy and the licenses (text CC BY-SA 4.0, code MIT-0); then call account_register.
A 6-digit code is emailed to them; ask for it and call account_verify. Never guess these values.`;

export class Auth {
  private readonly server: Server;
  private readonly api: GatewayApi;
  private pending: Pending | null = null;
  private session: Session | null = null;
  private declined = false;

  constructor(server: Server, api: GatewayApi) {
    this.server = server;
    this.api = api;
  }

  private label(): string {
    const client = this.server.getClientVersion()?.name ?? 'MCP client';
    return `${client} via rewiki (${process.platform})`;
  }

  private canElicit(): boolean {
    return !!this.server.getClientCapabilities()?.elicitation;
  }

  async token(): Promise<string | null> {
    return getToken(this.api.server);
  }

  /** Current session if the stored token is valid; clears an invalid token. */
  async current(): Promise<Session | null> {
    if (this.session) return this.session;
    const token = await this.token();
    if (!token) return null;
    try {
      const status = await this.api.request('GET', '/auth/status', undefined, token);
      this.session = { username: status.username, trust: status.trust, mode: status.mode };
      return this.session;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        await deleteToken(this.api.server);
        return null;
      }
      throw error;
    }
  }

  invalidate(): void {
    this.session = null;
  }

  async logout(): Promise<void> {
    const token = await this.token();
    if (token) await this.api.request('POST', '/auth/logout', {}, token).catch(() => {});
    await deleteToken(this.api.server);
    this.session = null;
  }

  /** Ensures a valid session, running the interactive flow if needed. */
  async ensure(): Promise<Session> {
    const existing = await this.current();
    if (existing) return existing;
    if (this.declined) throw new AuthDeclined();
    if (!this.canElicit()) throw new AuthRequired(fallbackInstructions(rememberedAccount(this.api.server)));

    const saved = rememberedAccount(this.api.server);
    if (saved) {
      const again = await this.server.elicitInput({
        message: `ReverseEngineering.wiki: publishing needs a login. Log in as "${saved}", the account last used on this machine? A code will be sent to its email.`,
        requestedSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string', title: 'Account', enum: ['saved', 'login', 'register'],
              enumNames: [`Yes, log in as ${saved}`, 'Another existing account', 'Create a new account'],
            },
          },
          required: ['action'],
        },
      });
      if (again.action !== 'accept') {
        this.declined = true;
        throw new AuthDeclined();
      }
      if (again.content?.action === 'saved') return this.interactiveLogin(saved);
      return again.content?.action === 'register' ? this.interactiveRegister() : this.interactiveLogin();
    }

    const choice = await this.server.elicitInput({
      message: 'ReverseEngineering.wiki: publishing to the public wiki requires an account. Your username is public on every edit; your email is never shown. Create one now?',
      requestedSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string', title: 'What do you want to do?', enum: ['register', 'login'],
            enumNames: ['Create a new account', 'I already have an account'],
          },
        },
        required: ['action'],
      },
    });
    if (choice.action !== 'accept') {
      this.declined = true;
      throw new AuthDeclined();
    }
    return choice.content?.action === 'login' ? this.interactiveLogin() : this.interactiveRegister();
  }

  private newNonce(): { nonce: string; hash: string } {
    const nonce = randomBytes(32).toString('hex');
    return { nonce, hash: createHash('sha256').update(nonce).digest('hex') };
  }

  private async askCode(message: string): Promise<string> {
    const answer = await this.server.elicitInput({
      message,
      requestedSchema: {
        type: 'object',
        properties: { code: { type: 'string', title: '6-digit code', minLength: 6, maxLength: 6 } },
        required: ['code'],
      },
    });
    if (answer.action !== 'accept' || typeof answer.content?.code !== 'string') {
      this.declined = true;
      throw new AuthDeclined();
    }
    return answer.content.code.trim();
  }

  private async finish(grant: Record<string, any>): Promise<Session> {
    await setToken(this.api.server, grant.token);
    saveConfig({ username: grant.username, server: this.api.server });
    this.session = { username: grant.username, trust: grant.trust, mode: grant.mode };
    return this.session;
  }

  private async interactiveLogin(identifier?: string): Promise<Session> {
    if (!identifier) {
      const answer = await this.server.elicitInput({
        message: 'ReverseEngineering.wiki login: your username, or the email of your account.',
        requestedSchema: { type: 'object', properties: { login: { type: 'string', title: 'Username or email' } }, required: ['login'] },
      });
      if (answer.action !== 'accept' || typeof answer.content?.login !== 'string') {
        this.declined = true;
        throw new AuthDeclined();
      }
      identifier = answer.content.login.trim();
    }
    const { nonce, hash } = this.newNonce();
    const start = await this.api.request('POST', '/auth/login/start', { ...loginIdentity(identifier), client_nonce_hash: hash, client_label: this.label() });
    let message = `ReverseEngineering.wiki: ${start.message} Enter it here; it expires in ${start.expires_in_minutes} minutes.`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = await this.askCode(message);
      try {
        const grant = await this.api.request('POST', '/auth/login/verify', { challenge_id: start.challenge_id, code, client_nonce: nonce, client_label: this.label() });
        return this.finish(grant);
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'INVALID_CODE') throw error;
        message = 'That code did not work. Check the latest ReverseEngineering.wiki email and try again.';
      }
    }
    throw new AuthDeclined();
  }

  private async interactiveRegister(): Promise<Session> {
    let note = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      const form = await this.server.elicitInput({
        message: `${note}Create a ReverseEngineering.wiki account. Your username is shown publicly on every edit: do not use your real name. Your email only receives login codes and is never shown.`,
        requestedSchema: {
          type: 'object',
          properties: {
            username: { type: 'string', title: 'Public username', description: '3–32 letters, digits, "-" or "_"', minLength: 3, maxLength: 32 },
            email: { type: 'string', title: 'Email', format: 'email' },
            accept_policy: { type: 'boolean', title: 'I accept the ReverseEngineering.wiki content policy (no private data, no piracy/DRM/anti-cheat bypass, no malware)' },
            accept_licenses: { type: 'boolean', title: 'I license my contributions: text CC BY-SA 4.0, code MIT-0' },
          },
          required: ['username', 'email', 'accept_policy', 'accept_licenses'],
        },
      });
      if (form.action !== 'accept' || !form.content) {
        this.declined = true;
        throw new AuthDeclined();
      }
      const { username, email, accept_policy, accept_licenses } = form.content as Record<string, any>;
      if (accept_policy !== true || accept_licenses !== true) {
        note = 'Both the content policy and the licenses must be accepted to publish. ';
        continue;
      }
      const available = await this.api.request('POST', '/auth/username-available', { username });
      if (!available.available) {
        note = `"${username}" is not available: ${available.reason}${available.suggestions?.length ? ` Suggestions: ${available.suggestions.join(', ')}.` : ''} `;
        continue;
      }
      const { nonce, hash } = this.newNonce();
      let start: Record<string, any>;
      try {
        start = await this.api.request('POST', '/auth/register/start', {
          username, email, consent: { policy: true, licenses: true }, client_nonce_hash: hash, client_label: this.label(),
        });
      } catch (error) {
        if (error instanceof ApiError && ['USERNAME_UNAVAILABLE', 'INVALID_EMAIL'].includes(error.code)) {
          note = `${error.message} `;
          continue;
        }
        throw error;
      }
      let message = `ReverseEngineering.wiki: enter the code sent to ${start.sent_to}. It expires in ${start.expires_in_minutes} minutes.`;
      for (let codeAttempt = 0; codeAttempt < 3; codeAttempt++) {
        const code = await this.askCode(message);
        try {
          const grant = await this.api.request('POST', '/auth/register/verify', { challenge_id: start.challenge_id, code, client_nonce: nonce, client_label: this.label() });
          return this.finish(grant);
        } catch (error) {
          if (error instanceof ApiError && error.code === 'USERNAME_UNAVAILABLE') {
            note = `${error.message} `;
            break;
          }
          if (!(error instanceof ApiError) || error.code !== 'INVALID_CODE') throw error;
          message = 'That code did not work. If this email already has an account, you received a different email: use "I already have an account" instead.';
        }
      }
    }
    throw new AuthDeclined();
  }

  // ---- fallback for clients without elicitation (the model relays answers) ----------------

  async startRegister(args: { username: string; email: string; accept_policy: boolean; accept_licenses: boolean }) {
    if (args.accept_policy !== true || args.accept_licenses !== true) {
      throw new ApiError(400, { error: 'CONSENT_REQUIRED', message: 'The user must accept the content policy and the licenses.' });
    }
    const { nonce, hash } = this.newNonce();
    const start = await this.api.request('POST', '/auth/register/start', {
      username: args.username, email: args.email, consent: { policy: true, licenses: true }, client_nonce_hash: hash, client_label: this.label(),
    });
    this.pending = { kind: 'register', challengeId: start.challenge_id, nonce, username: args.username };
    this.declined = false;
    return { sent_to: start.sent_to, expires_in_minutes: start.expires_in_minutes, next: 'Ask the user for the 6-digit code from the email, then call account_verify.' };
  }

  /** `identifier` is the username or the account's email. */
  async startLogin(identifier: string) {
    const { nonce, hash } = this.newNonce();
    const start = await this.api.request('POST', '/auth/login/start', { ...loginIdentity(identifier), client_nonce_hash: hash, client_label: this.label() });
    this.pending = { kind: 'login', challengeId: start.challenge_id, nonce, username: identifier };
    this.declined = false;
    return { message: start.message, expires_in_minutes: start.expires_in_minutes, next: 'Ask the user for the 6-digit code from the email, then call account_verify. If no code arrives, the address or username may not have an account.' };
  }

  async verifyPending(code: string): Promise<Session> {
    if (!this.pending) throw new ApiError(400, { error: 'NO_PENDING_LOGIN', message: 'Call account_login or account_register first.' });
    const p = this.pending;
    const grant = await this.api.request('POST', `/auth/${p.kind}/verify`, { challenge_id: p.challengeId, code: code.trim(), client_nonce: p.nonce, client_label: this.label() });
    this.pending = null;
    return this.finish(grant);
  }

  async setMode(mode: string): Promise<string> {
    const token = await this.token();
    if (!token) throw new ApiError(401, { error: 'AUTH_REQUIRED', message: 'Not logged in.' });
    if (!this.canElicit() && mode !== 'read') {
      // Without a prompt the human can't confirm, and the agent must not lift its own review mode.
      throw new ApiError(403, {
        error: 'HUMAN_CONFIRMATION_REQUIRED',
        message: `This client cannot ask your operator for confirmation. They can run "npx -y rewiki set-mode ${mode}" in a terminal.`,
      });
    }
    if (this.canElicit()) {
      const confirm = await this.server.elicitInput({
        message: `ReverseEngineering.wiki: switch this account to "${mode}" mode? (read = no writes; review = you approve each publication; write = the agent publishes directly)`,
        requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean', title: `Switch to ${mode}` } }, required: ['confirm'] },
      });
      if (confirm.action !== 'accept' || confirm.content?.confirm !== true) throw new AuthDeclined();
    }
    const result = await this.api.request('POST', '/auth/mode', { mode }, token);
    if (this.session) this.session.mode = result.mode;
    return result.mode;
  }
}
