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
const WIKI = process.env.WIKI_URL ?? 'http://127.0.0.1:8788';
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
  /** Cookies by name, as a browser keeps them (paths ignored: one site). */
  jar = new Map<string, string>();
  flow = '';
  get cookie(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  private keep(r: Response): void {
    for (const c of r.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const eq = pair.indexOf('=');
      this.jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
  }
  async open(url: URL | string): Promise<string> {
    const r = await fetch(url, { headers: { 'X-Forwarded-For': FAKE_IP, Cookie: this.cookie }, redirect: 'manual' });
    this.keep(r);
    const html = await r.text();
    this.flow = /name="flow" value="([^"]+)"/.exec(html)?.[1] ?? this.flow;
    return html;
  }
  async post(fields: Record<string, string>, cookie = this.cookie, url = `${GATEWAY}/oauth/authorize`): Promise<{ status: number; html: string; location: string | null }> {
    const r = await fetch(url, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie, 'X-Forwarded-For': FAKE_IP },
      body: new URLSearchParams({ ...(url.endsWith('/oauth/authorize') ? { flow: this.flow } : {}), ...fields }),
    });
    this.keep(r);
    const html = await r.text();
    this.flow = /name="flow" value="([^"]+)"/.exec(html)?.[1] ?? this.flow;
    return { status: r.status, html, location: r.headers.get('location') };
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

async function connect(provider: MemoryProvider, onElicit?: (message: string, params: any) => Record<string, unknown> | null): Promise<Client> {
  const client = new Client({ name: 'e2e-oauth', version: '0' }, { capabilities: onElicit ? { elicitation: {} } : {} });
  if (onElicit) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      const content = onElicit(String(req.params.message), req.params);
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
  const foreign = await browser.post({ action: 'email', email }, 'rewiki_oauth=someone-else');
  assert.equal(foreign.status, 400, 'a form posted without this browser\'s cookie is refused');
}
// An email without an account: the same page as a login, and the code creates the account.
let step1 = await browser.post({ action: 'email', email });
assert.match(step1.html, /Check your email/);
assert.match(step1.html, /We sent a 6-digit code to/);
const wrong = await browser.post({ action: 'verify', code: '000000' });
assert.match(wrong.html, /invalid or expired/);
step1 = await browser.post({ action: 'verify', code: await codeFor(email) });
assert.match(step1.html, /Create your account/);
const suggested = /name="username"[^>]*value="([^"]+)"/.exec(step1.html)?.[1] ?? '';
assert.match(suggested, /^[A-Z][a-z]+[A-Z][a-z]+\d{2,4}$/, `a random username is suggested (${suggested})`);
assert.match(step1.html, /value="review" checked/, 'new accounts start in review mode');
const noConsent = await browser.post({ action: 'create', username, mode: 'review' });
assert.match(noConsent.html, /Accept the content policy/);
const taken = await browser.post({ action: 'create', username: 'Admin', mode: 'review', accept_policy: '1', accept_licenses: '1' });
assert.match(taken.html, /reserved/);
const allowed = await browser.post({ action: 'create', username, mode: 'review', accept_policy: '1', accept_licenses: '1' });
assert.equal(allowed.status, 302);
const back = new URL(allowed.location!);
assert.equal(`${back.origin}${back.pathname}`, REDIRECT);
assert.equal(back.searchParams.get('state'), provider.stateValue);
assert.equal(back.searchParams.get('iss'), GATEWAY);
const code = back.searchParams.get('code')!;
await new StreamableHTTPClientTransport(new URL(`${GATEWAY}/mcp`), { authProvider: provider }).finishAuth(code);
assert.match(provider.saved?.access_token ?? '', /^rewiki_[A-Za-z0-9]{40}$/);
ok('SDK client: 401 → discovery → dynamic registration → PKCE; an email without an account gets a code that creates one (random name suggested, editable; terms required; wrong code and foreign cookie refused); code → token');

// ---- review mode, enforced by the server -------------------------------------------------
const prompts: string[] = [];
const schemas: any[] = [];
let answer: Record<string, unknown> | null = { approve: true };
const client = await connect(provider, (message, params) => {
  prompts.push(message);
  schemas.push(params.requestedSchema);
  return answer;
});
const tools = (await client.listTools()).tools;
assert.ok(tools.some((t) => t.name === 'add_note') && tools.some((t) => t.name === 'account_status'));
assert.ok('review_id' in ((tools.find((t) => t.name === 'add_note')!.inputSchema as any).properties ?? {}));
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
const linkInPrompt = new RegExp(`${GATEWAY.replace(/[.]/g, '\\.')}/review/[A-Za-z0-9_-]+`);
assert.match(prompts[0], linkInPrompt, 'the prompt links to the review page');
assert.match(schemas[0].properties.approve.description, linkInPrompt, 'the link sits next to the checkbox too (clients that show only the form)');
ok('review mode: the server shows the operator the whole page (elicitation, with a link to the review page), publishes after the OK');

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

// ---- a client without approval prompts: approval on the review page ---------------------------
const plain = await connect(provider);
const noteArgs = { subject, body: 'Approved by the operator on the review page.', confidence: 'medium' };
const asked = parse(await plain.callTool({ name: 'add_note', arguments: noteArgs }));
assert.equal(asked.error, 'REVIEW_REQUIRED', JSON.stringify(asked).slice(0, 300));
assert.match(asked.review_url, new RegExp(`/review/${asked.review_id}$`));
const early = parse(await plain.callTool({ name: 'add_note', arguments: { ...noteArgs, review_id: asked.review_id } }));
assert.equal(early.error, 'REVIEW_PENDING', 'nothing is published before the operator approves');
const other = parse(await plain.callTool({ name: 'add_note', arguments: { ...noteArgs, body: 'Different text than what was reviewed.', review_id: asked.review_id } }));
assert.equal(other.error, 'REVIEW_MISMATCH', 'an approval covers exactly the reviewed arguments');

// Anyone with the link sees the preview (the agent already knows it), but cannot approve without the operator's session.
const stranger = new Browser();
const strangerView = await stranger.open(asked.review_url);
assert.match(strangerView, /Approved by the operator on the review page\./, 'the preview needs no login');
assert.match(strangerView, /Approve it in your agent's app/);
assert.doesNotMatch(strangerView, /value="approve"/, "no approve button without the operator's session");
const forgedPost = await stranger.post({ action: 'approve', check: 'x' }, stranger.cookie, asked.review_url);
assert.doesNotMatch(forgedPost.html, /<h1>Approved/);
assert.equal(parse(await plain.callTool({ name: 'add_note', arguments: { ...noteArgs, review_id: asked.review_id } })).error, 'REVIEW_PENDING');

// The operator's browser has the session from the authorization: it sees the exact text and approves.
const reviewPage = await browser.open(asked.review_url);
assert.match(reviewPage, /Publish this on ReverseEngineering\.wiki\?/);
assert.match(reviewPage, /Approved by the operator on the review page\./);
const check = /name="check" value="([^"]+)"/.exec(reviewPage)![1];
const approvedPage = await browser.post({ action: 'approve', check }, browser.cookie, asked.review_url);
assert.match(approvedPage.html, /<h1>Approved/);
const published = parse(await plain.callTool({ name: 'add_note', arguments: { ...noteArgs, review_id: asked.review_id } }));
assert.ok(published.title && !published.isError, JSON.stringify(published));
const reused = parse(await plain.callTool({ name: 'add_note', arguments: { ...noteArgs, review_id: asked.review_id } }));
assert.equal(reused.error, 'REVIEW_USED', 'one approval, one publication');

// On another device: sign in with the email code, then approve.
const second = parse(await plain.callTool({ name: 'add_note', arguments: { subject, body: 'Approved from another device after the email code.', confidence: 'low' } }));
const device = new Browser();
await device.open(second.review_url);
const codePage = await device.post({ action: 'email', email }, device.cookie, second.review_url);
assert.match(codePage.html, /Check your email/);
const signedIn = await device.post({ action: 'verify', flow: /name="flow" value="([^"]+)"/.exec(codePage.html)![1], code: await codeFor(email) }, device.cookie, second.review_url);
assert.equal(signedIn.status, 303);
const deviceReview = await device.open(second.review_url);
assert.match(deviceReview, /Approved from another device/);
await device.post({ action: 'approve', check: /name="check" value="([^"]+)"/.exec(deviceReview)![1] }, device.cookie, second.review_url);
assert.ok(parse(await plain.callTool({ name: 'add_note', arguments: { subject, body: 'Approved from another device after the email code.', confidence: 'low', review_id: second.review_id } })).title);

const modeBlocked = parse(await plain.callTool({ name: 'account_set_mode', arguments: { mode: 'write' } }));
assert.equal(modeBlocked.error, 'HUMAN_CONFIRMATION_REQUIRED');
await plain.close();
ok('client without prompts: REVIEW_REQUIRED with a review link; only the operator\'s browser (authorization session, or email code on another device) sees and approves it; one approval = one publication of exactly those arguments; the agent cannot switch to write mode');

answer = { confirm: true };
const toWrite = parse(await client.callTool({ name: 'account_set_mode', arguments: { mode: 'write' } }));
assert.equal(toWrite.mode, 'write');
const promptsNow = prompts.length;
const direct = parse(await client.callTool({ name: 'add_note', arguments: { subject, body: 'Published directly in write mode.', confidence: 'low' } }));
assert.ok(direct.title, JSON.stringify(direct));
assert.equal(prompts.length, promptsNow, 'no prompt in write mode');
ok('write mode after the operator confirms in the client: publishes without prompts');

// ---- renaming: same account, new public name ---------------------------------------------
const renamedTo = `OAuthRenamed-${run}`;
answer = { confirm: true };
const renamed = parse(await client.callTool({ name: 'account_rename', arguments: { username: renamedTo } }));
assert.equal(renamed.username, renamedTo, JSON.stringify(renamed));
assert.equal(renamed.previous, username);
assert.match(prompts.at(-1)!, new RegExp(`from "${username}" to "${renamedTo}"`), 'the operator confirms the new name');
const users = await (await fetch(`${WIKI}/api.php?action=query&list=users&ususers=${encodeURIComponent(`${renamedTo}|${username}`)}&format=json`)).json() as any;
assert.ok(users.query.users.some((u: any) => u.name === renamedTo && u.userid), 'the MediaWiki user was renamed');
assert.ok(users.query.users.some((u: any) => u.name === username && 'missing' in u), 'the old MediaWiki name is free in the wiki');
const oldName = await (await fetch(`${GATEWAY}/auth/username-available`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username }) })).json() as any;
assert.equal(oldName.available, false, 'the old name stays reserved for this account');
assert.equal(parse(await client.callTool({ name: 'account_status', arguments: {} })).username, renamedTo);
const afterRename = parse(await client.callTool({ name: 'add_note', arguments: { subject, body: 'Published after renaming the account.', confidence: 'low' } }));
assert.ok(afterRename.title, JSON.stringify(afterRename));
const history = await (await fetch(`${WIKI}/api.php?action=query&prop=revisions&titles=${encodeURIComponent(subject)}&rvlimit=1&rvdir=newer&rvprop=user&format=json`)).json() as any;
assert.equal((Object.values(history.query.pages)[0] as any).revisions[0].user, renamedTo, 'past edits now show the new name');
await client.close();
ok('account_rename: confirmed by the operator; MediaWiki user renamed with its past edits; old name reserved; publishing keeps working');

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
  const sent = await second.post({ action: 'email', email });
  assert.match(sent.html, /We sent a 6-digit code to/, 'the same answer as for an email without an account');
  const signedIn = await second.post({ action: 'verify', code: await codeFor(email) });
  assert.match(signedIn.html, new RegExp(`Signed in as <b>${renamedTo}</b>`), 'an email with an account logs in to it');
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

  // A fresh code, then revocation ends the token. This is the fourth code to the same address in a
  // few minutes, past the anti-flood limit (3 per 15 minutes): clear it in the test database.
  {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(new URL('../data-test/gateway.sqlite', import.meta.url));
    db.exec("delete from rate_events where scope like 'mail-%'");
    db.close();
  }
  const third = new Browser();
  await third.open(authorize({ state: 's2' }));
  await third.post({ action: 'email', email });
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
