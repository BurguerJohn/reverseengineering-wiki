/**
 * OAuth 2.1 for remote MCP clients (design/08-accounts-and-auth.md#oauth).
 *
 * The MCP endpoint (/mcp) is the protected resource and the gateway is its own authorization
 * server: metadata (RFC 9728, RFC 8414), dynamic client registration (RFC 7591), the
 * authorization code flow with PKCE (S256 only) and token revocation (RFC 7009).
 *
 * The authorization page is where the human signs in with an emailed code (an email without an
 * account gets one, with a random username they can change), then lets the agent's client connect. Nothing runs on the user's machine, and the
 * access token goes to the MCP client, never to the model.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Services } from '../tools/context.ts';
import { AuthError, TOKEN_IDLE_DAYS, type AuthService } from '../auth/service.ts';
import type { Mode, OAuthClient } from '../db/accounts.ts';
import { pageUrl } from '../wiki/titles.ts';

export const SCOPE = 'wiki';
const CODE_TTL_MS = 5 * 60_000;
const FLOW_TTL_MS = 30 * 60_000;
const MAX_FORM = 64 * 1024;
const COOKIE = 'rewiki_oauth';

export function resourceUrl(s: Services): string {
  return `${s.config.publicUrl}/mcp`;
}

export function resourceMetadataUrl(s: Services): string {
  return `${s.config.publicUrl}/.well-known/oauth-protected-resource/mcp`;
}

/** The WWW-Authenticate header of a 401 from /mcp: where an MCP client finds how to log in. */
export function challengeHeader(s: Services, error?: 'invalid_token'): string {
  return `Bearer resource_metadata="${resourceMetadataUrl(s)}", scope="${SCOPE}"${error ? `, error="${error}"` : ''}`;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version',
};

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS, ...headers });
  res.end(JSON.stringify(body));
}

function oauthError(res: ServerResponse, status: number, error: string, description: string): void {
  json(res, status, { error, error_description: description });
}

/** Form (application/x-www-form-urlencoded) or JSON body as a flat string map. */
async function readParams(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_FORM) throw new AuthError('PAYLOAD_TOO_LARGE', 'Request body too large', 413);
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (String(req.headers['content-type'] ?? '').includes('application/json')) {
    try {
      const body = JSON.parse(text || '{}');
      return Object.fromEntries(Object.entries(body ?? {}).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
    } catch {
      throw new AuthError('BAD_REQUEST', 'Body must be JSON');
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_FORM) throw new AuthError('PAYLOAD_TOO_LARGE', 'Request body too large', 413);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return null;
  }
}

const base64url = (b: Buffer) => b.toString('base64url');
const hashCode = (code: string) => createHash('sha256').update(code).digest('hex');

// ---- redirect URIs ---------------------------------------------------------------------

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const FORBIDDEN_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'about:', 'blob:', 'ftp:', 'ws:', 'wss:']);

/** https, http on loopback (native apps, RFC 8252), or a private-use scheme like cursor://. No fragments. */
export function validRedirectUri(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.length > 500) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return LOOPBACK.has(url.hostname);
  return !FORBIDDEN_SCHEMES.has(url.protocol) && /^[a-z][a-z0-9+.-]*:$/.test(url.protocol);
}

/** Exact match, except that loopback redirects may use any port (RFC 8252 section 7.3). */
export function redirectMatches(registered: string[], given: string): boolean {
  if (registered.includes(given)) return true;
  let g: URL;
  try {
    g = new URL(given);
  } catch {
    return false;
  }
  if (g.protocol !== 'http:' || !LOOPBACK.has(g.hostname)) return false;
  return registered.some((r) => {
    try {
      const u = new URL(r);
      return u.protocol === 'http:' && u.hostname === g.hostname && u.pathname === g.pathname && u.search === g.search;
    } catch {
      return false;
    }
  });
}

// ---- the authorization page --------------------------------------------------------------

interface AuthRequest {
  clientId: string;
  clientName: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
}

interface Flow {
  id: string;
  cookie: string;
  created: number;
  request: AuthRequest;
  /** consent: an existing account allows the client; create: a new account (after its email code) does. */
  step: 'start' | 'code' | 'consent' | 'create';
  kind?: 'login' | 'signup';
  challengeId?: string;
  nonce?: string;
  operatorId?: number;
  /** The proven email of a new account, kept only until the account is created. */
  email?: string;
  suggested?: string;
  notice?: string;
}

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14" fill="#0f172a"/><path d="M12 21 L22 32 L12 43 M52 21 L42 32 L52 43" fill="none" stroke="#f8fafc" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="32" cy="32" r="4.5" fill="#22c55e"/></svg>';

const STYLE = `
:root{--ink:#0f172a;--muted:#475569;--line:#cbd5e1;--bg:#f8fafc;--card:#fff;--accent:#16a34a;--warn:#b45309;--err:#b91c1c}
@media (prefers-color-scheme:dark){:root{--ink:#e2e8f0;--muted:#94a3b8;--line:#334155;--bg:#0b1120;--card:#111827;--accent:#22c55e;--warn:#f59e0b;--err:#f87171}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:460px;margin:40px auto;padding:0 16px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
header{display:flex;align-items:center;gap:12px;margin-bottom:20px}header b{font-size:18px}header span{color:var(--accent);font-weight:700}
h1{font-size:20px;margin:0 0 8px}p{margin:8px 0}.muted{color:var(--muted);font-size:14px}
label{display:block;margin:14px 0 4px;font-weight:600;font-size:14px}input[type=email],input[type=text]{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font-size:16px}
.check{display:flex;gap:8px;align-items:flex-start;font-weight:400;margin:10px 0}.check input{margin-top:4px}
button{margin-top:18px;width:100%;padding:11px;border:0;border-radius:8px;background:var(--ink);color:var(--bg);font-size:16px;font-weight:600;cursor:pointer}
button.secondary{background:transparent;color:var(--ink);border:1px solid var(--line)}
.row{display:flex;gap:10px}.row button{flex:1}
details{margin-top:20px;border-top:1px solid var(--line);padding-top:14px}summary{cursor:pointer;font-weight:600}
.notice{border-left:3px solid var(--warn);padding:6px 10px;margin:12px 0;font-size:14px}.error{border-left-color:var(--err)}
.client{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:12px 0;font-size:14px}
code{font-size:13px}a{color:var(--accent)}`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ReverseEngineering.wiki</title><meta name="robots" content="noindex"><style>${STYLE}</style></head>
<body><main><header>${ICON}<b>ReverseEngineering<span>.wiki</span></b></header><div class="card">${body}</div></main></body></html>`;
}

export class OAuthServer {
  private readonly s: Services;
  private readonly auth: AuthService;
  private readonly flows = new Map<string, Flow>();

  constructor(s: Services, auth: AuthService) {
    this.s = s;
    this.auth = auth;
    setInterval(() => {
      const now = Date.now();
      for (const [id, flow] of this.flows) if (now - flow.created > FLOW_TTL_MS) this.flows.delete(id);
    }, 60_000).unref();
  }

  private get issuer(): string {
    return this.s.config.publicUrl;
  }

  authorizationServerMetadata() {
    const base = this.issuer;
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: [SCOPE],
      authorization_response_iss_parameter_supported: true,
      service_documentation: `${base}/llms.txt`,
    };
  }

  protectedResourceMetadata() {
    return {
      resource: resourceUrl(this.s),
      authorization_servers: [this.issuer],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: 'ReverseEngineering.wiki',
      resource_documentation: `${this.issuer}/llms.txt`,
    };
  }

  /** Handles the OAuth routes; false when the path is not one of them. */
  async handle(req: IncomingMessage, res: ServerResponse, path: string, ip: string): Promise<boolean> {
    const isOAuth = path.startsWith('/oauth/') || path.startsWith('/.well-known/oauth-');
    if (!isOAuth) return false;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...CORS, 'Access-Control-Max-Age': '86400' });
      res.end();
      return true;
    }
    switch (path) {
      case '/.well-known/oauth-protected-resource':
      case '/.well-known/oauth-protected-resource/mcp':
        json(res, 200, this.protectedResourceMetadata(), { 'Cache-Control': 'public, max-age=3600' });
        return true;
      case '/.well-known/oauth-authorization-server':
        json(res, 200, this.authorizationServerMetadata(), { 'Cache-Control': 'public, max-age=3600' });
        return true;
      case '/oauth/register':
        if (req.method !== 'POST') return this.notAllowed(res);
        await this.register(req, res, ip);
        return true;
      case '/oauth/authorize':
        if (req.method === 'GET') this.authorizeStart(req, res);
        else if (req.method === 'POST') await this.authorizeStep(req, res, ip);
        else this.notAllowed(res);
        return true;
      case '/oauth/token':
        if (req.method !== 'POST') return this.notAllowed(res);
        await this.token(req, res);
        return true;
      case '/oauth/revoke':
        if (req.method !== 'POST') return this.notAllowed(res);
        await this.revoke(req, res);
        return true;
    }
    json(res, 404, { error: 'not_found' });
    return true;
  }

  private notAllowed(res: ServerResponse): true {
    json(res, 405, { error: 'invalid_request', error_description: 'Method not allowed' });
    return true;
  }

  // ---- dynamic client registration (RFC 7591) ---------------------------------------------

  private async register(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
    if (!this.s.db.takeRate([{ scope: 'oauth-register', key: ip, max: 30, windowSeconds: 3600 }])) {
      oauthError(res, 429, 'invalid_request', 'Too many client registrations from this address. Try again later.');
      return;
    }
    const body = await readJson(req);
    if (!body || typeof body !== 'object') {
      json(res, 400, { error: 'invalid_client_metadata', error_description: 'Body must be a JSON object' });
      return;
    }
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every(validRedirectUri)) {
      json(res, 400, { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be 1-10 URLs: https, http on localhost/127.0.0.1, or a private-use scheme (no fragments)' });
      return;
    }
    const grants: unknown[] = Array.isArray(body.grant_types) ? body.grant_types : ['authorization_code'];
    if (!grants.includes('authorization_code')) {
      json(res, 400, { error: 'invalid_client_metadata', error_description: 'Only the authorization_code grant is supported' });
      return;
    }
    const name = String(body.client_name ?? 'Unnamed MCP client').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) || 'Unnamed MCP client';
    const client: OAuthClient = {
      client_id: `rwc_${randomBytes(18).toString('base64url')}`,
      name,
      redirect_uris: JSON.stringify(uris),
      created_at: new Date().toISOString(),
      ip,
    };
    this.s.db.insertOAuthClient(client);
    json(res, 201, {
      client_id: client.client_id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: uris,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPE,
    });
  }

  // ---- authorization ------------------------------------------------------------------------

  private html(res: ServerResponse, status: number, body: string, cookie?: string): void {
    const headers: Record<string, string> = {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'",
      'Referrer-Policy': 'no-referrer',
    };
    if (cookie) {
      const secure = this.issuer.startsWith('https://') ? '; Secure' : '';
      headers['Set-Cookie'] = `${COOKIE}=${cookie}; Path=/oauth; HttpOnly; SameSite=Lax; Max-Age=${FLOW_TTL_MS / 1000}${secure}`;
    }
    res.writeHead(status, headers);
    res.end(body);
  }

  private errorPage(res: ServerResponse, message: string): void {
    this.html(res, 400, page('Cannot connect', `<h1>This connection request is not valid</h1><p>${esc(message)}</p>
<p class="muted">Start the connection again from your AI agent's client. If it keeps failing, tell the client's developers.</p>`));
  }

  private redirect(res: ServerResponse, to: string): void {
    res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' });
    res.end();
  }

  private redirectWith(request: AuthRequest, params: Record<string, string>): string {
    const url = new URL(request.redirectUri);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (request.state !== undefined) url.searchParams.set('state', request.state);
    url.searchParams.set('iss', this.issuer);
    return url.toString();
  }

  private authorizeStart(req: IncomingMessage, res: ServerResponse): void {
    const q = new URL(req.url ?? '/', 'http://localhost').searchParams;
    const client = this.s.db.oauthClient(q.get('client_id') ?? '');
    if (!client) return this.errorPage(res, 'Unknown client_id. The client must register first (dynamic client registration).');
    const registered: string[] = JSON.parse(client.redirect_uris);
    const redirectUri = q.get('redirect_uri') ?? (registered.length === 1 ? registered[0] : '');
    if (!redirectUri || !redirectMatches(registered, redirectUri)) return this.errorPage(res, 'redirect_uri does not match the registered client.');
    // From here on, errors go back to the client.
    const request: AuthRequest = {
      clientId: client.client_id, clientName: client.name, redirectUri, state: q.get('state') ?? undefined,
      codeChallenge: q.get('code_challenge') ?? '',
    };
    const fail = (error: string, description: string) => this.redirect(res, this.redirectWith(request, { error, error_description: description }));
    if (q.get('response_type') !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported');
    if (q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(request.codeChallenge)) {
      return fail('invalid_request', 'PKCE is required: code_challenge with code_challenge_method=S256');
    }
    const resource = q.get('resource');
    if (resource && resource.replace(/\/$/, '') !== resourceUrl(this.s) && resource.replace(/\/$/, '') !== this.issuer) {
      return fail('invalid_target', `This server only issues tokens for ${resourceUrl(this.s)}`);
    }
    const flow: Flow = { id: randomBytes(18).toString('base64url'), cookie: randomBytes(18).toString('base64url'), created: Date.now(), request, step: 'start' };
    this.flows.set(flow.id, flow);
    this.html(res, 200, this.render(flow), flow.cookie);
  }

  private clientBox(request: AuthRequest): string {
    let host = request.redirectUri;
    try {
      const u = new URL(request.redirectUri);
      host = u.protocol === 'http:' || u.protocol === 'https:' ? u.host : u.protocol;
    } catch { /* shown as given */ }
    return `<div class="client"><b>${esc(request.clientName)}</b> <span class="muted">(name given by the app, not verified; it will return to <code>${esc(host)}</code>)</span></div>`;
  }

  private render(flow: Flow, error?: string, values: Record<string, string> = {}): string {
    const hidden = `<input type="hidden" name="flow" value="${esc(flow.id)}">`;
    const err = error ? `<p class="notice error">${esc(error)}</p>` : '';
    const notice = flow.notice ? `<p class="notice">${esc(flow.notice)}</p>` : '';
    const wiki = this.s.config.mw.publicUrl;
    if (flow.step === 'start') {
      return page('Connect an AI agent', `<h1>Connect an AI agent</h1>
<p>This app wants to use ReverseEngineering.wiki for you: read, and publish to the public wiki under your account.</p>
${this.clientBox(flow.request)}${err}
<form method="post" action="/oauth/authorize">${hidden}<input type="hidden" name="action" value="email">
<label for="email">Your email</label><input id="email" name="email" type="email" autocomplete="email" required autofocus value="${esc(values.email)}">
<p class="muted">We send you a 6-digit code. No password. No account yet? The code creates one.</p>
<button type="submit">Send code</button></form>`);
    }
    if (flow.step === 'code') {
      return page('Enter the code', `<h1>Check your email</h1>${notice}${err}
<form method="post" action="/oauth/authorize">${hidden}<input type="hidden" name="action" value="verify">
<label for="code">6-digit code</label><input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required autofocus>
<button type="submit">Continue</button></form>
<form method="post" action="/oauth/authorize">${hidden}<input type="hidden" name="action" value="restart"><button class="secondary" type="submit">Use another email</button></form>
<p class="muted">The code expires in 10 minutes. Nothing arrived? Check the spam folder.</p>`);
    }
    const modes = (current: Mode) => {
      const checked = (m: Mode) => (current === m || (current === 'read' && m === 'review') ? ' checked' : '');
      return `<label class="check"><input type="radio" name="mode" value="review"${checked('review')}> <span><b>Ask me before each publication</b> (recommended): the app shows you exactly what will be published and waits for your OK.</span></label>
<label class="check"><input type="radio" name="mode" value="write"${checked('write')}> <span><b>Publish directly</b>: the agent publishes without asking. Your account, your responsibility.</span></label>`;
    };
    const buttons = (allow: string) => `<div class="row"><button class="secondary" type="submit" name="action" value="deny">Deny</button><button type="submit" name="action" value="${allow}">Allow</button></div>`;
    if (flow.step === 'create') {
      const policy = pageUrl(wiki, 'REWiki:Content policy');
      return page('Create your account', `<h1>Create your account</h1>${err}
<p>There is no account with this email yet. This one is created when you allow the app.</p>${this.clientBox(flow.request)}
<form method="post" action="/oauth/authorize">${hidden}
<label for="username">Public username</label><input id="username" name="username" type="text" autocomplete="username" required maxlength="32" value="${esc(values.username ?? flow.suggested)}">
<p class="muted">Shown on every edit. Picked at random: keep it, change it now, or later with your agent (account_rename). Not your real name. Your email is never shown.</p>
<label class="check"><input type="checkbox" name="accept_policy" value="1" required> <span>I accept the <a href="${esc(policy)}" target="_blank" rel="noopener">content policy</a>: no private data, no keys, no piracy.</span></label>
<label class="check"><input type="checkbox" name="accept_licenses" value="1" required> <span>What my agent publishes is licensed CC BY-SA 4.0 (text) and MIT-0 (code).</span></label>
${modes('review')}
${buttons('create')}</form>`);
    }
    const op = this.s.db.operatorById(flow.operatorId!)!;
    return page('Allow access', `<h1>Allow this app?</h1>${err}
<p>Signed in as <b>${esc(op.username)}</b>.</p>${this.clientBox(flow.request)}
<p>It will be able to search and read the wiki and publish under <b>${esc(op.username)}</b>. Everything it publishes is public.</p>
<form method="post" action="/oauth/authorize">${hidden}
${modes(op.mode)}
<p class="muted">This setting is for your account, in every app. You can disconnect the app at any time in its settings.</p>
${buttons('allow')}</form>`);
  }

  private async authorizeStep(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
    const form = await readParams(req);
    const flow = this.flows.get(form.flow ?? '');
    const cookie = String(req.headers.cookie ?? '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? '';
    const sameBrowser = !!flow && cookie.length === flow.cookie.length && timingSafeEqual(Buffer.from(cookie), Buffer.from(flow.cookie));
    if (!flow || !sameBrowser || Date.now() - flow.created > FLOW_TTL_MS) {
      return this.errorPage(res, 'This page expired or was opened in another browser. Start the connection again from your AI agent\'s client.');
    }
    const label = `${flow.request.clientName} (remote MCP)`;
    try {
      switch (form.action) {
        case 'email': {
          if (flow.step !== 'start') break;
          const nonce = randomBytes(24).toString('base64url');
          const started = await this.auth.emailCodeStart({ email: form.email, client_nonce_hash: createHash('sha256').update(nonce).digest('hex'), client_label: label }, ip);
          // The same page either way: the inbox owner learns whether an account exists, nobody else.
          Object.assign(flow, { step: 'code', kind: started.kind, challengeId: started.challenge_id, nonce, notice: `We sent a 6-digit code to ${started.sent_to}.` });
          break;
        }
        case 'verify': {
          if (flow.step !== 'code') break;
          const body = { challenge_id: flow.challengeId, code: String(form.code ?? '').replace(/\s/g, ''), client_nonce: flow.nonce };
          if (flow.kind === 'signup') {
            const { email } = this.auth.signupVerify(body);
            Object.assign(flow, { step: 'create', email, suggested: this.auth.suggestUsername(), challengeId: undefined, nonce: undefined, notice: undefined });
          } else {
            flow.operatorId = this.auth.loginOperator(body).op.id;
            Object.assign(flow, { step: 'consent', challengeId: undefined, nonce: undefined, notice: undefined });
          }
          break;
        }
        case 'create': {
          if (flow.step !== 'create' || !flow.email) break;
          if (form.accept_policy !== '1' || form.accept_licenses !== '1') {
            throw new AuthError('CONSENT_REQUIRED', 'Accept the content policy and the licenses to create the account.');
          }
          flow.operatorId = await this.auth.createOperator({
            username: form.username, email: flow.email, mode: form.mode === 'write' ? 'write' : 'review',
          });
          flow.email = undefined;
          return this.grant(res, flow);
        }
        case 'restart':
          Object.assign(flow, { step: 'start', kind: undefined, challengeId: undefined, nonce: undefined, notice: undefined });
          break;
        case 'deny':
          if (flow.step !== 'consent' && flow.step !== 'create') break;
          this.flows.delete(flow.id);
          return this.redirect(res, this.redirectWith(flow.request, { error: 'access_denied', error_description: 'The user denied access' }));
        case 'allow': {
          if (flow.step !== 'consent') break;
          const op = this.s.db.operatorById(flow.operatorId!);
          if (!op || op.blocked_at) throw new AuthError('BLOCKED', 'This account is blocked.');
          // The human is here and logged in: the right place to choose the contribution mode.
          if (form.mode === 'review' || form.mode === 'write') this.auth.setMode(op, form.mode);
          return this.grant(res, flow);
        }
      }
      this.html(res, 200, this.render(flow));
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      // A wrong or expired code: stay on the code step (the challenge counts attempts).
      this.html(res, error.status === 429 ? 429 : 400, this.render(flow, error.message, form));
    }
  }

  /** Issues the authorization code and sends the browser back to the client. */
  private grant(res: ServerResponse, flow: Flow): void {
    const code = randomBytes(32).toString('base64url');
    this.s.db.insertOAuthCode({
      code_hash: hashCode(code), client_id: flow.request.clientId, operator_id: flow.operatorId!, redirect_uri: flow.request.redirectUri,
      code_challenge: flow.request.codeChallenge, created_at: Date.now(), expires_at: Date.now() + CODE_TTL_MS,
    });
    this.flows.delete(flow.id);
    this.redirect(res, this.redirectWith(flow.request, { code }));
  }

  // ---- token & revocation ---------------------------------------------------------------------

  private async token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const p = await readParams(req);
    if (p.grant_type !== 'authorization_code') return oauthError(res, 400, 'unsupported_grant_type', 'Only authorization_code is supported');
    if (!p.code || !p.code_verifier || !p.redirect_uri) return oauthError(res, 400, 'invalid_request', 'code, code_verifier and redirect_uri are required');
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(p.code_verifier)) return oauthError(res, 400, 'invalid_grant', 'Malformed code_verifier');
    const row = this.s.db.takeOAuthCode(hashCode(p.code));
    const invalid = () => oauthError(res, 400, 'invalid_grant', 'The authorization code is invalid, expired or already used');
    if (!row) return invalid();
    if (p.client_id && p.client_id !== row.client_id) return invalid();
    if (p.redirect_uri !== row.redirect_uri) return invalid();
    const challenge = base64url(createHash('sha256').update(p.code_verifier).digest());
    if (challenge.length !== row.code_challenge.length || !timingSafeEqual(Buffer.from(challenge), Buffer.from(row.code_challenge))) return invalid();
    if (p.resource && p.resource.replace(/\/$/, '') !== resourceUrl(this.s) && p.resource.replace(/\/$/, '') !== this.issuer) {
      return oauthError(res, 400, 'invalid_target', `This server only issues tokens for ${resourceUrl(this.s)}`);
    }
    const client = this.s.db.oauthClient(row.client_id);
    const op = this.s.db.operatorById(row.operator_id);
    if (!client || !op || op.blocked_at) return invalid();
    const grant = this.auth.issueToken(op.id, `${client.name} (remote MCP)`, client.client_id);
    json(res, 200, { access_token: grant.token, token_type: 'Bearer', expires_in: TOKEN_IDLE_DAYS * 86400, scope: SCOPE });
  }

  private async revoke(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const p = await readParams(req);
    const session = this.auth.authenticate(p.token);
    if (session) this.auth.logout(session.token);
    // RFC 7009: the same answer whether or not the token was valid.
    json(res, 200, {});
  }
}
