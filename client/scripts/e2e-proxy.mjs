// End-to-end test of the rewiki package against a running gateway + Mailpit.
//   node scripts/e2e-proxy.mjs
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const GATEWAY = process.env.GATEWAY_URL ?? 'http://127.0.0.1:8787';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const run = randomBytes(3).toString('hex');
process.on('exit', () => {
  spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/cli.ts', 'delete-test-pages', run], {
    cwd: new URL('../../gateway/', import.meta.url), stdio: 'inherit',
  });
});
const home = mkdtempSync(join(tmpdir(), 'rewiki-e2e-'));
const username = `Proxy-${run}`;
const email = `proxy-${run}@wikivibe.test`;
let step = 0;
const ok = (m) => console.log(`  ✔ ${++step}. ${m}`);

async function codeFor(to) {
  for (let i = 0; i < 30; i++) {
    const s = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`)).json();
    const id = s.messages?.[0]?.ID;
    if (id) {
      const m = await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json();
      await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ IDs: [id] }) });
      return /\b(\d{6})\b/.exec(m.Text)[1];
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('no mail');
}

async function start(withElicitation, onElicit) {
  const client = new Client({ name: 'e2e-proxy', version: '0' }, { capabilities: withElicitation ? { elicitation: {} } : {} });
  if (withElicitation) client.setRequestHandler(ElicitRequestSchema, (req) => onElicit(req.params));
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: ['dist/index.js'],
    env: { ...process.env, REWIKI_SERVER: GATEWAY, REWIKI_HOME: home, REWIKI_NO_KEYCHAIN: '1' },
    stderr: 'pipe',
  }));
  return client;
}

const parse = (r) => ({ ...JSON.parse(r.content[0].text.split('\n\n')[0]), isError: !!r.isError });
const prompts = [];
const fullPrompts = [];

console.log(`rewiki e2e run ${run}`);
const client = await start(true, async (params) => {
  prompts.push(params.message.split('\n')[0]);
  fullPrompts.push(params.message);
  const props = Object.keys(params.requestedSchema.properties);
  if (props.includes('action')) return { action: 'accept', content: { action: 'register' } };
  if (props.includes('email')) return { action: 'accept', content: { username, email, accept_policy: true, accept_licenses: true } };
  if (props.includes('code')) return { action: 'accept', content: { code: await codeFor(email) } };
  if (props.includes('approve')) return { action: 'accept', content: { approve: true } };
  if (props.includes('confirm')) return { action: 'accept', content: { confirm: true } };
  return { action: 'decline' };
});

const tools = (await client.listTools()).tools.map((t) => t.name);
assert.ok(tools.includes('add_note') && tools.includes('account_status') && tools.includes('search'));
assert.match(client.getInstructions() ?? '', /PUBLIC wiki/);
ok(`proxy lists ${tools.length} tools (gateway + account tools) and forwards instructions`);

const before = parse(await client.callTool({ name: 'account_status', arguments: {} }));
assert.equal(before.logged_in, false);
const search = await client.callTool({ name: 'search', arguments: { query: 'E2E' } });
assert.ok(!search.isError);
ok('reads work without an account');

const subject = `Software:Proxy Game ${run}`;
const created = parse(await client.callTool({ name: 'create_page', arguments: {
  type: 'software', title: `Proxy Game ${run}`, summary: 'A fictional game created through the local MCP package.', body: '## Formats\n\nNothing special.',
} }));
assert.equal(created.title, subject, JSON.stringify(created));
assert.match(prompts[0], /^ReverseEngineering.wiki: publishing to the public wiki requires an account/);
assert.match(prompts[1], /^Create a ReverseEngineering.wiki account/);
assert.match(prompts[2], /^ReverseEngineering.wiki: enter the code sent to/);
assert.match(prompts[3], /review mode/);
assert.match(fullPrompts[3], /--- New page: Software:Proxy Game[\s\S]*Nothing special\./, 'the approval shows the whole page that will be stored');
assert.match(fullPrompts[3], /Checked by the server: valid \(page: Software:Proxy Game/, 'the approval prompt comes after a server-side check');
ok('first write → asked to register → form → emailed code → review approval → published');

const creds = readFileSync(join(home, 'credentials'), 'utf8');
assert.match(creds, /rewiki_[A-Za-z0-9]{40}/);
const allText = JSON.stringify(created) + JSON.stringify(await client.callTool({ name: 'account_status', arguments: {} }));
assert.doesNotMatch(allText, /rewiki_[A-Za-z0-9]{40}/);
ok('token stored locally and never returned to the model');

const declined = await start(true, async (params) => (Object.keys(params.requestedSchema.properties).includes('approve') ? { action: 'decline' } : { action: 'cancel' }));
const reviewNo = parse(await declined.callTool({ name: 'add_note', arguments: { subject, body: 'Something the operator does not want to publish.', confidence: 'low' } }));
assert.equal(reviewNo.error, 'REVIEW_DECLINED');
ok('review mode: operator declines → nothing published');

const promptsBefore = prompts.length;
const invalid = parse(await client.callTool({ name: 'add_note', arguments: { subject: 'NoNamespace', body: 'Rejected by the server before anyone is asked.', confidence: 'low' } }));
assert.equal(invalid.error, 'BAD_TITLE', JSON.stringify(invalid));
const dry = parse(await client.callTool({ name: 'add_note', arguments: { subject, body: 'Only checked, never published.', confidence: 'low', dry_run: true } }));
assert.equal(dry.dry_run, true, JSON.stringify(dry));
assert.equal(prompts.length, promptsBefore, 'no approval prompt for an invalid write or a dry run');
ok('review mode: the server checks first (invalid → error, operator not asked); dry_run needs no approval');

const toWrite = parse(await client.callTool({ name: 'account_set_mode', arguments: { mode: 'write' } }));
assert.equal(toWrite.mode, 'write');
const approvals = prompts.length;
const note = parse(await client.callTool({ name: 'add_note', arguments: { subject, body: 'Published directly in write mode.', confidence: 'medium' } }));
assert.ok(note.title, JSON.stringify(note));
assert.equal(prompts.length, approvals + 0, 'no approval prompt in write mode');
ok('set-mode write (confirmed by operator) → writes publish without prompts');

const noElicit = await start(false);
const blockedMode = parse(await noElicit.callTool({ name: 'account_set_mode', arguments: { mode: 'review' } }));
assert.equal(blockedMode.error, 'HUMAN_CONFIRMATION_REQUIRED');
await noElicit.callTool({ name: 'account_logout', arguments: {} });
const needsAuth = parse(await noElicit.callTool({ name: 'add_note', arguments: { subject, body: 'Should require login first.', confidence: 'low' } }));
assert.equal(needsAuth.error, 'AUTH_REQUIRED');
assert.match(needsAuth.message, /never guess/i);
ok('client without elicitation: agent cannot change mode; writes return AUTH_REQUIRED with instructions');

// The operator only remembers the email: account_login accepts it instead of the username.
const loginStart = parse(await noElicit.callTool({ name: 'account_login', arguments: { email } }));
assert.ok(!loginStart.isError, `account_login failed: ${JSON.stringify(loginStart)}`);
const verified = parse(await noElicit.callTool({ name: 'account_verify', arguments: { code: await codeFor(email) } }));
assert.equal(verified.logged_in, true);
assert.equal(verified.username, username);
const fallbackWrite = parse(await noElicit.callTool({ name: 'add_note', arguments: { subject, body: 'Written after the fallback login flow.', confidence: 'low' } }));
assert.ok(fallbackWrite.title, JSON.stringify(fallbackWrite));
ok('fallback login by email (account_login + account_verify) works');

// A new agent on the same machine after a logout: the remembered account is offered first.
await noElicit.callTool({ name: 'account_logout', arguments: {} });
const loggedOut = parse(await noElicit.callTool({ name: 'account_status', arguments: {} }));
assert.equal(loggedOut.last_account_on_this_machine, username, JSON.stringify(loggedOut));
const offered = [];
const again = await start(true, async (params) => {
  offered.push(params.message);
  const props = Object.keys(params.requestedSchema.properties);
  if (props.includes('action')) return { action: 'accept', content: { action: 'saved' } };
  if (props.includes('code')) return { action: 'accept', content: { code: await codeFor(email) } };
  if (props.includes('approve')) return { action: 'accept', content: { approve: true } };
  return { action: 'decline' };
});
const rewrite = parse(await again.callTool({ name: 'add_note', arguments: { subject, body: 'Written after logging in again with the remembered account.', confidence: 'low' } }));
assert.ok(rewrite.title, JSON.stringify(rewrite));
assert.match(offered[0], new RegExp(`Log in as "${username}", the account last used on this machine`));
assert.ok(!offered.some((m) => /requires an account\. Your username is public/.test(m)), 'not asked "do you have an account?" again');
await again.close();
ok('remembered account: status reports it; the next login offers it first (no "do you have an account?")');

await Promise.all([client.close(), declined.close(), noElicit.close()]);
rmSync(home, { recursive: true, force: true });
console.log(`\nAll ${step} checks passed.`);
