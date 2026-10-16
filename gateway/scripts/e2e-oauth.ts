/**
 * End-to-end check of remote MCP with OAuth (http/oauth.ts) against the test gateway + Mailpit:
 * the MCP SDK's own client does discovery, registration, PKCE and the token exchange, the way an
 * MCP client like Claude Code does; this script plays the browser on the authorization page.
 *   node scripts/e2e-oauth.ts   (run by "npm run e2e")
 */
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

if (process.env.REWIKI_ENV_FILE !== '.env.test') {
  console.error('Run the end-to-end tests with "npm run e2e": they use the separate test wiki, never the real one.');
  process.exit(2);
}
const GATEWAY = process.env.GATEWAY_URL ?? 'http://127.0.0.1:8789';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const run = randomBytes(3).toString('hex');
process.on('exit', () => {
  if (process.env.E2E_KEEP === '1') return;
  spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/cli.ts', 'delete-test-pages', run], {
    cwd: new URL('..', import.meta.url), stdio: 'inherit',
  });
});
const FAKE_IP = `198.19.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
const REDIRECT = 'http://127.0.0.1:33418/callback';
let step = 0;
const ok = (msg: string) => console.log(`  ✔ ${++step}. ${msg}`);

async function codeFor(email: string): Promise<string> {
  for (let i = 0; i < 30; i++) {
    const search = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json() as any;
    const id = search.messages?.[0]?.ID;
    if (id) {
      const message = await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json() as any;
      await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ IDs: [id] }) });
      return /\b(\d{6})\b/.exec(message.Text)![1];
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`no email for ${email}`);
}

/** The human's browser on the authorization page: keeps the flow cookie, posts the forms. */
class Browser {
  cookie = '';
  flow = '';
  async open(url: URL | string): Promise<string> {
    const r = await fetch(url, { headers: { 'X-Forwarded-For': FAKE_IP }, redirect: 'manual' });
    const set = r.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const html = await r.text();
    this.flow = /name="flow" value="([^"]+)"/.exec(html)?.[1] ?? this.flow;
    return html;
  }
  async post(fields: Record<string, string>, cookie = this.cookie): Promise<{ status: number; html: string; location: string | null }> {
    const r = await fetch(`${GATEWAY}/oauth/authorize`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie, 'X-Forwarded-For': FAKE_IP },
      body: new URLSearchParams({ flow: this.flow, ...fields }),
    });
    return { status: r.status, html: await r.text(), location: r.headers.get('location') };
  }
}

/** An MCP client's OAuth storage, in memory (Claude Code keeps it in its credentials store). */
class MemoryProvider implements OAuthClientProvider {
  info: any;
  saved: any;
  verifier = '';
  authorizationUrl?: URL;
  readonly stateValue = randomBytes(8).toString('hex');
  get redirectUrl() { return REDIRECT; }
  get clientMetadata() {
    return { client_name: 'E2E MCP client', redirect_uris: [REDIRECT], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' };
  }
  state() { return this.stateValue; }
  clientInformation() { return this.info; }
  saveClientInformation(info: any) { this.info = info; }
  tokens() { return this.saved; }
  saveTokens(tokens: any) { this.saved = tokens; }
  redirectToAuthorization(url: URL) { this.authorizationUrl = url; }
  saveCodeVerifier(v: string) { this.verifier = v; }
  codeVerifier() { return this.verifier; }
}

async function connect(provider: MemoryProvider, onElicit?: (message: string) => Record<string, unknown> | null): Promise<Client> {
  const client = new Client({ name: 'e2e-oauth', version: '0' }, { capabilities: onElicit ? { elicitation: {} } : {} });
  if (onElicit) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      const content = onElicit(String(req.params.message));
      return content ? { action: 'accept', content } : { action: 'decline' };
    });
  }
  await client.connect(new StreamableHTTPClientTransport(new URL(`${GATEWAY}/mcp`), { authProvider: provider }));
  return client;
}

const parse = (r: any) => ({ ...(r.structuredContent ?? JSON.parse(r.content[0].text.split('\n\n')[0])), isError: !!r.isError });

console.log(`OAuth e2e run ${run}`);

// ---- discovery -----------------------------------------------------------------------------
{
  const prm = await (await fetch(`${GATEWAY}/.well-known/oauth-protected-resource/mcp`)).json() as any;
  assert.equal(prm.resource, `${GATEWAY}/mcp`);
  assert.deepEqual(prm.authorization_servers, [GATEWAY]);
  const as = await (await fetch(`${GATEWAY}/.well-known/oauth-authorization-server`)).json() as any;
  assert.equal(as.issuer, GATEWAY);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.ok(as.registration_endpoint && as.token_endpoint && as.authorization_endpoint);
  const bad = await fetch(`${GATEWAY}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'x', redirect_uris: ['javascript:alert(1)'] }) });
  assert.equal(bad.status, 400);
  const remote = await fetch(`${GATEWAY}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'x', redirect_uris: ['http://evil.example/cb'] }) });
  assert.equal(remote.status, 400, 'plain http is only allowed on loopback');
  ok('metadata (RFC 9728, RFC 8414) served; registration refuses javascript: and non-loopback http redirects');
}

// ---- first connection: register a new account on the authorization page ------------------
const username = `OAuth-${run}`;
const email = `oauth-${run}@wikivibe.test`;
const provider = new MemoryProvider();
await assert.rejects(connect(provider), UnauthorizedError);
assert.ok(provider.info?.client_id?.startsWith('rwc_'), 'the SDK registered the client dynamically');
const authUrl = provider.authorizationUrl!;
assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
assert.equal(authUrl.searchParams.get('resource'), `${GATEWAY}/mcp`);
const browser = new Browser();
let html = await browser.open(authUrl);
assert.match(html, /E2E MCP client/);
assert.match(html, /not verified; it will return to <code>127\.0\.0\.1:33418<\/code>/);
{
  const foreign = await browser.post({ action: 'login', email }, 'rewiki_oauth=someone-else');
  assert.equal(foreign.status, 400, 'a form posted without this browser\'s cookie is refused');
}
let step1 = await browser.post({ action: 'register', username, email, accept_policy: '1', accept_licenses: '1' });
assert.match(step1.html, /Check your email/);
const wrong = await browser.post({ action: 'verify', code: '000000' });
assert.match(wrong.html, /invalid or expired/);
step1 = await browser.post({ action: 'verify', code: await codeFor(email) });
assert.match(step1.html, new RegExp(`Signed in as <b>${username}</b>`));
assert.match(step1.html, /value="review" checked/, 'new accounts start in review mode');
const allowed = await browser.post({ action: 'allow', mode: 'review' });
assert.equal(allowed.status, 302);
const back = new URL(allowed.location!);
assert.equal(`${back.origin}${back.pathname}`, REDIRECT);
assert.equal(back.searchParams.get('state'), provider.stateValue);
assert.equal(back.searchParams.get('iss'), GATEWAY);
const code = back.searchParams.get('code')!;
await new StreamableHTTPClientTransport(new URL(`${GATEWAY}/mcp`), { authProvider: provider }).finishAuth(code);
assert.match(provider.saved?.access_token ?? '', /^rewiki_[A-Za-z0-9]{40}$/);
ok('SDK client: 401 → discovery → dynamic registration → PKCE; the human creates an account with an emailed code (wrong code and foreign cookie refused) and allows; code → token');

// ---- review mode, enforced by the server -------------------------------------------------
const prompts: string[] = [];
let answer: Record<string, unknown> | null = { approve: true };
const client = await connect(provider, (message) => {
  prompts.push(message);
  return answer;
});
const tools = (await client.listTools()).tools;
assert.ok(tools.some((t) => t.name === 'add_note') && tools.some((t) => t.name === 'account_status'));
assert.ok('operator_approved' in ((tools.find((t) => t.name === 'add_note')!.inputSchema as any).properties ?? {}));
assert.match(client.getInstructions() ?? '', new RegExp(`logged in as ${username}`));
const status = parse(await client.callTool({ name: 'account_status', arguments: {} }));
assert.equal(status.username, username);
assert.equal(status.mode, 'review');
ok('connected with the token: write tools and account tools; instructions say who the agent publishes as');

const subject = `Software:E2E OAuth Game ${run}`;
const created = parse(await client.callTool({ name: 'create_page', arguments: {
  type: 'software', title: `E2E OAuth Game ${run}`, summary: 'A fictional game created through remote MCP with OAuth.', body: '## Formats\n\nNothing special yet.',
} }));
assert.equal(created.title, subject, JSON.stringify(created));
assert.equal(prompts.length, 1);
assert.match(prompts[0], /review mode/);
assert.match(prompts[0], /--- New page: Software:E2E OAuth Game [\s\S]*Nothing special yet\./, 'the operator sees exactly what will be stored');
ok('review mode: the server shows the operator the whole page (elicitation), publishes after the OK');

answer = null;
const declined = parse(await client.callTool({ name: 'add_note', arguments: { subject, body: 'The operator will not approve this one.', confidence: 'low' } }));
assert.equal(declined.error, 'REVIEW_DECLINED');
const before = prompts.length;
const invalid = parse(await client.callTool({ name: 'add_note', arguments: { subject: 'NoNamespace', body: 'Rejected before anyone is asked.', confidence: 'low' } }));
assert.equal(invalid.error, 'BAD_TITLE', JSON.stringify(invalid));
const dry = parse(await client.callTool({ name: 'add_note', arguments: { subject, body: 'Only checked, never published.', confidence: 'low', dry_run: true } }));
assert.equal(dry.dry_run, true);
assert.equal(prompts.length, before, 'no prompt for an invalid write or a dry run');
ok('declined → REVIEW_DECLINED, nothing published; invalid writes and dry runs never reach the operator');

// ---- a client without approval prompts: approval in the conversation ------------------------
const plain = await connect(provider);
const noteArgs = { subject, body: 'Approved by the operator in the conversation.', confidence: 'medium' };
const forged = parse(await plain.callTool({ name: 'add_note', arguments: { ...noteArgs, operator_approved: true } }));
assert.equal(forged.error, 'REVIEW_REQUIRED', 'operator_approved alone, without a preview first, does not publish');
assert.match(forged.preview, /Approved by the operator in the conversation\./);
const approved = parse(await plain.callTool({ name: 'add_note', arguments: { ...noteArgs, operator_approved: true } }));
assert.ok(approved.title && !approved.isError, JSON.stringify(approved));
const modeBlocked = parse(await plain.callTool({ name: 'account_set_mode', arguments: { mode: 'write' } }));
assert.equal(modeBlocked.error, 'HUMAN_CONFIRMATION_REQUIRED');
await plain.close();
ok('client without prompts: REVIEW_REQUIRED with the preview, publishes only on a repeat after it; the agent cannot switch to write mode');

answer = { confirm: true };
const toWrite = parse(await client.callTool({ name: 'account_set_mode', arguments: { mode: 'write' } }));
assert.equal(toWrite.mode, 'write');
const promptsNow = prompts.length;
const direct = parse(await client.callTool({ name: 'add_note', arguments: { subject, body: 'Published directly in write mode.', confidence: 'low' } }));
assert.ok(direct.title, JSON.stringify(direct));
assert.equal(prompts.length, promptsNow, 'no prompt in write mode');
await client.close();
ok('write mode after the operator confirms in the client: publishes without prompts');

// ---- second app: log in with the email; code and token rules --------------------------------
{
  const reg = await (await fetch(`${GATEWAY}/oauth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Second app', redirect_uris: ['http://localhost/cb'] }),
  })).json() as any;
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = (extra: Record<string, string> = {}) => `${GATEWAY}/oauth/authorize?${new URLSearchParams({
    response_type: 'code', client_id: reg.client_id, redirect_uri: 'http://localhost:51234/cb', code_challenge: challenge, code_challenge_method: 'S256', state: 's1', ...extra,
  })}`;
  const noPkce = await fetch(authorize({ code_challenge_method: 'plain' }), { redirect: 'manual' });
  assert.match(noPkce.headers.get('location') ?? '', /error=invalid_request/, 'PKCE S256 is required');
  const second = new Browser();
  html = await second.open(authorize());
  assert.match(html, /Second app/, 'loopback redirect on any port (RFC 8252)');
  const sent = await second.post({ action: 'login', email });
  assert.match(sent.html, /If an account uses this email address, a 6-digit code was sent/);
  await second.post({ action: 'verify', code: await codeFor(email) });
  const allow = await second.post({ action: 'allow', mode: 'review' });
  const secondCode = new URL(allow.location!).searchParams.get('code')!;
  const exchange = (v: string) => fetch(`${GATEWAY}/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: secondCode, code_verifier: v, redirect_uri: 'http://localhost:51234/cb', client_id: reg.client_id }),
  }).then(async (r) => ({ status: r.status, ...(await r.json() as any) }));
  const bad = await exchange(randomBytes(32).toString('base64url'));
  assert.equal(bad.error, 'invalid_grant', 'wrong PKCE verifier');
  const reused = await exchange(verifier);
  assert.equal(reused.error, 'invalid_grant', 'a code is single-use, even after a failed exchange');
  ok('second app: login by email on the page; PKCE S256 required; wrong verifier refused and the code burned');

  // A fresh code, then revocation ends the token.
  const third = new Browser();
  await third.open(authorize({ state: 's2' }));
  await third.post({ action: 'login', email });
  await third.post({ action: 'verify', code: await codeFor(email) });
  const allow3 = await third.post({ action: 'allow', mode: 'review' });
  const code3 = new URL(allow3.location!).searchParams.get('code')!;
  const token = await (await fetch(`${GATEWAY}/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: code3, code_verifier: verifier, redirect_uri: 'http://localhost:51234/cb' }),
  })).json() as any;
  assert.match(token.access_token, /^rewiki_/);
  await fetch(`${GATEWAY}/oauth/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: token.access_token }) });
  const after = await fetch(`${GATEWAY}/mcp`, {
    method: 'POST', headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(after.status, 401);
  assert.match(after.headers.get('www-authenticate') ?? '', /error="invalid_token"/);
  ok('token exchange → access token; revocation (RFC 7009) → /mcp answers 401 invalid_token');
}

console.log(`\nAll ${step} OAuth checks passed.`);
