#!/usr/bin/env node
/**
 * rewiki — ReverseEngineering.wiki from an MCP client or from the command line.
 *
 *   rewiki                               MCP server on stdio (what MCP clients launch)
 *   rewiki use <site URL>                remember which ReverseEngineering.wiki server to use
 *   rewiki tools [name]                  list tools, or show one tool's input schema
 *   rewiki call <tool> [json|-|@file] [--dry-run | --confirm]
 *                                              call a tool once; arguments as JSON, stdin (-) or a file (@path)
 *   rewiki register start --username U --email E --accept-policy --accept-licenses
 *   rewiki register verify --code 123456
 *   rewiki login start --username U | --email E
 *   rewiki login verify --code 123456
 *   rewiki login                         interactive login/registration (terminal)
 *   rewiki status | logout
 *   rewiki download [file] [--out path]       the whole wiki (default text.zip), checksum verified
 *   rewiki skill diff [--path P]              compare the installed skill with the server's
 *   rewiki skill install [--path P]           operator only (interactive terminal): review and install it
 *   rewiki set-mode read|review|write    operator only: needs an interactive terminal
 *
 * The access token goes to the OS keychain and is never printed.
 * Server URL: REWIKI_SERVER, else ~/.rewiki/config.json, else the default.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline/promises';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { ApiError, GatewayApi } from './api.ts';
import { describeCheck, formatPreview, startProxy, summarize, VERSION } from './proxy.ts';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { loginIdentity } from './auth.ts';
import {
  clearPending, deleteToken, getToken, readConfig, readPending, readUpdateCheck, rememberedAccount, saveConfig, savePending, saveUpdateCheck, setToken,
} from './store.ts';

const DEFAULT_SERVER = 'http://localhost:8787';
const serverUrl = (process.env.REWIKI_SERVER ?? readConfig().server ?? DEFAULT_SERVER).replace(/\/$/, '');
const api = new GatewayApi(serverUrl);
const LABEL = `rewiki CLI ${VERSION} (${process.platform})`;

class CliError extends Error {}

function flags(args: string[]): { positional: string[]; options: Record<string, string | true> } {
  const positional: string[] = [];
  const options: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        options[key] = next;
        i++;
      } else {
        options[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, options };
}

function required(options: Record<string, string | true>, key: string): string {
  const value = options[key];
  if (typeof value !== 'string' || !value.trim()) throw new CliError(`--${key} is required`);
  return value.trim();
}

function newNonce(): { nonce: string; hash: string } {
  const nonce = randomBytes(32).toString('hex');
  return { nonce, hash: createHash('sha256').update(nonce).digest('hex') };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function connect(token: string | null): Promise<Client> {
  const headers: Record<string, string> = { 'X-REWiki-Client': 'rewiki' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const client = new Client({ name: 'rewiki-cli', version: VERSION });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${serverUrl}/mcp`), { requestInit: { headers } }));
  return client;
}

function print(result: CallToolResult): void {
  for (const block of result.content) if (block.type === 'text') console.log(block.text);
  if (result.isError) process.exitCode = 1;
}

// ---- tools / call -------------------------------------------------------------------------

async function tools(name?: string): Promise<void> {
  const client = await connect(null);
  const list = (await client.listTools()).tools;
  await client.close();
  if (name) {
    const tool = list.find((t) => t.name === name);
    if (!tool) throw new CliError(`Unknown tool "${name}". Run "rewiki tools".`);
    console.log(JSON.stringify({ name: tool.name, description: tool.description, writes: tool.annotations?.readOnlyHint !== true, inputSchema: tool.inputSchema }, null, 2));
    return;
  }
  for (const t of list) console.log(`${t.annotations?.readOnlyHint === true ? 'read ' : 'write'}  ${t.name.padEnd(15)} ${t.description ?? ''}`);
}

async function call(name: string, raw: string | undefined, confirm: boolean, dryRun = false): Promise<void> {
  let text = raw ?? '{}';
  if (text === '-') text = await readStdin();
  else if (text.startsWith('@')) text = readFileSync(text.slice(1), 'utf8');
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(text);
  } catch {
    throw new CliError('Arguments must be JSON (inline, "-" for stdin, or "@path/to/file.json").');
  }

  const probe = await connect(null);
  const list: Tool[] = (await probe.listTools()).tools;
  await probe.close();
  const tool = list.find((t) => t.name === name);
  if (!tool) throw new CliError(`Unknown tool "${name}". Run "rewiki tools".`);
  const writes = tool.annotations?.readOnlyHint !== true;

  let token: string | null = null;
  if (writes) {
    token = await getToken(serverUrl);
    if (!token) {
      throw new CliError('Not logged in. Ask your user for their ReverseEngineering.wiki username or account email (or, for a new account, a username + email), then run "rewiki login start --username U" (or --email E) or "rewiki register start ...".');
    }
    let status: Record<string, any>;
    try {
      status = await api.request('GET', '/auth/status', undefined, token);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        await deleteToken(serverUrl);
        throw new CliError('The stored login expired. Log in again with "rewiki login start --username U".');
      }
      throw error;
    }
    if (status.mode === 'read') throw new CliError('This account is in read-only mode (operator setting).');
    if (dryRun) args = { ...args, dry_run: true };
    else if (status.mode === 'review' && !confirm) {
      // Validate on the server first, so the user is only asked about something that will go through.
      const checker = await connect(token);
      const check = (await checker.callTool({ name, arguments: { ...args, dry_run: true } })) as CallToolResult;
      await checker.close();
      if (check.isError) {
        print(check);
        console.error('\nThe server rejected this; nothing was published and your user was not asked. Fix it and run the command again.');
        return;
      }
      const preview = formatPreview(check);
      console.log(`REVIEW_REQUIRED: this account is in review mode. ${describeCheck(check)} Show your user the text below (exactly what will be stored), get their explicit approval in the conversation, then repeat the same command with --confirm. No separate --dry-run is needed: this was the check.\n\n${preview || summarize(name, args)}`);
      process.exitCode = 2;
      return;
    }
  }
  const client = await connect(token);
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  await client.close();
  print(result);
}

// ---- skill updates -----------------------------------------------------------------------------
// Instructions must never replace themselves: the new skill is shown as a diff and installed
// only by the user, from an interactive terminal, after they read it.

function skillPath(option: string | true | undefined): string {
  if (typeof option === 'string') return resolve(option);
  return resolve(homedir(), '.claude', 'skills', 'rewiki', 'SKILL.md');
}

/** Minimal line diff (LCS) with two lines of context; enough for a one-page file. */
function lineDiff(before: string[], after: string[]): string[] {
  const n = before.length;
  const m = after.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops: Array<[' ' | '-' | '+', string]> = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) { ops.push([' ', before[i]]); i++; j++; }
    else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) { ops.push(['+', after[j]]); j++; }
    else { ops.push(['-', before[i]]); i++; }
  }
  const keep = new Set<number>();
  ops.forEach(([op], k) => { if (op !== ' ') for (let c = k - 2; c <= k + 2; c++) keep.add(c); });
  const out: string[] = [];
  let last = -1;
  ops.forEach(([op, line], k) => {
    if (!keep.has(k)) return;
    if (last >= 0 && k > last + 1) out.push('…');
    out.push(`${op} ${line}`);
    last = k;
  });
  return out;
}

async function skillDiff(options: Record<string, string | true>): Promise<{ path: string; latest: string; changed: boolean }> {
  const path = skillPath(options.path);
  const response = await fetch(`${serverUrl}/skill/rewiki/SKILL.md`);
  if (!response.ok) throw new CliError(`Cannot fetch the skill: HTTP ${response.status}`);
  const latest = await response.text();
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (current === latest) {
    console.log(`${path} is up to date.`);
    return { path, latest, changed: false };
  }
  console.log(current ? `Changes from ${path} to the server's skill:\n` : `${path} does not exist; the server's skill:\n`);
  console.log(current ? lineDiff(current.split('\n'), latest.split('\n')).join('\n') : latest);
  return { path, latest, changed: true };
}

async function skillInstall(options: Record<string, string | true>): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new CliError('Only your user can install a skill update, from an interactive terminal: rewiki skill install. Show them "rewiki skill diff" meanwhile.');
  }
  const { path, latest, changed } = await skillDiff(options);
  if (!changed) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`\nInstall this skill to ${path}? Read the changes above first. [y/N] `);
    if (!answer.trim().toLowerCase().startsWith('y')) {
      console.log('Not installed.');
      return;
    }
  } finally {
    rl.close();
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, latest);
  console.log(`Installed ${path}. It loads in the next session.`);
}

// ---- download ------------------------------------------------------------------------------

async function download(file: string | undefined, out: string | undefined): Promise<void> {
  const index = await (await fetch(`${serverUrl}/dumps`)).json() as { editions?: Array<{ date: string; files: Array<{ kind: string; url: string; size: number; sha256: string | null }> }> };
  const kind = file ?? 'text.zip';
  const entry = index.editions?.flatMap((e) => e.files).find((f) => f.kind === kind);
  if (!entry) {
    const kinds = [...new Set(index.editions?.flatMap((e) => e.files.map((f) => f.kind)) ?? [])];
    throw new CliError(kinds.length ? `No file "${kind}". Available: ${kinds.join(', ')}` : 'No download is available yet.');
  }
  const target = resolve(out ?? basename(new URL(entry.url).pathname));
  const response = await fetch(entry.url);
  if (!response.ok || !response.body) throw new CliError(`Download failed: HTTP ${response.status}`);
  const hash = createHash('sha256');
  const tmp = `${target}.part`;
  const tap = new Transform({ transform(chunk, _enc, done) { hash.update(chunk); done(null, chunk); } });
  await pipeline(Readable.fromWeb(response.body as any), tap, createWriteStream(tmp));
  const digest = hash.digest('hex');
  if (entry.sha256 && digest !== entry.sha256) {
    rmSync(tmp, { force: true });
    throw new CliError(`Checksum mismatch for ${kind} (expected ${entry.sha256}, got ${digest}); nothing was kept. Try again.`);
  }
  renameSync(tmp, target);
  console.log(`Saved ${target} (${entry.size} bytes, SHA-256 ${entry.sha256 ? 'verified' : 'not published'}). Text CC BY-SA 4.0, code MIT-0. It is a snapshot: search and read have the current version.`);
}

// ---- accounts (non-interactive: the agent relays answers from its user) ------------------

async function registerStart(options: Record<string, string | true>): Promise<void> {
  if (options['accept-policy'] !== true || options['accept-licenses'] !== true) {
    throw new CliError('Your user must accept the content policy and the licenses (text CC BY-SA 4.0, code MIT-0): pass --accept-policy --accept-licenses only after they agreed.');
  }
  const username = required(options, 'username');
  const email = required(options, 'email');
  const { nonce, hash } = newNonce();
  const start = await api.request('POST', '/auth/register/start', {
    username, email, consent: { policy: true, licenses: true }, client_nonce_hash: hash, client_label: LABEL,
  });
  savePending({ server: serverUrl, kind: 'register', challengeId: start.challenge_id, nonce, username });
  console.log(`A 6-digit code was sent to ${start.sent_to} (valid ${start.expires_in_minutes} minutes). Ask your user for it, then run: rewiki register verify --code <code>`);
}

async function loginStart(options: Record<string, string | true>): Promise<void> {
  const identifier = typeof options.email === 'string' ? options.email : typeof options.username === 'string' ? options.username : null;
  if (!identifier) throw new CliError('Usage: rewiki login start --username U   (or --email E if your user does not remember the username)');
  const { nonce, hash } = newNonce();
  const start = await api.request('POST', '/auth/login/start', { ...loginIdentity(identifier), client_nonce_hash: hash, client_label: LABEL });
  savePending({ server: serverUrl, kind: 'login', challengeId: start.challenge_id, nonce, username: identifier });
  // The server never says whether the account exists; neither do we.
  console.log(`${start.message} It is valid ${start.expires_in_minutes} minutes. Ask your user for the code, then run: rewiki login verify --code <code>`);
}

async function verify(kind: 'login' | 'register', options: Record<string, string | true>): Promise<void> {
  const pending = readPending();
  if (!pending || pending.kind !== kind || pending.server !== serverUrl) {
    throw new CliError(`No pending ${kind}. Run "rewiki ${kind} start ..." first.`);
  }
  const grant = await api.request('POST', `/auth/${kind}/verify`, {
    challenge_id: pending.challengeId, code: required(options, 'code'), client_nonce: pending.nonce, client_label: LABEL,
  });
  const where = await setToken(serverUrl, grant.token);
  saveConfig({ username: grant.username, server: serverUrl });
  clearPending();
  console.log(`Logged in as ${grant.username} (trust: ${grant.trust}, mode: ${grant.mode}). The token is stored ${where === 'keychain' ? 'in the OS keychain' : 'in a local owner-only file'}.`);
}

async function terminalLogin(): Promise<void> {
  if (!process.stdin.isTTY) throw new CliError('Interactive login needs a terminal. Use "login start --username U" (or --email E) and "login verify --code C".');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const hasAccount = (await rl.question('Do you already have a ReverseEngineering.wiki account? [y/N] ')).trim().toLowerCase().startsWith('y');
    if (hasAccount) {
      const login = (await rl.question('Username or email: ')).trim();
      await loginStart(login.includes('@') ? { email: login } : { username: login });
      await verify('login', { code: (await rl.question('6-digit code: ')).trim() });
      return;
    }
    console.log('Your username is shown publicly on every edit: do not use your real name. Your email is never shown.');
    const username = (await rl.question('Public username: ')).trim();
    const available = await api.request('POST', '/auth/username-available', { username });
    if (!available.available) throw new CliError(`${available.reason} ${available.suggestions?.length ? `Try: ${available.suggestions.join(', ')}` : ''}`);
    const email = (await rl.question('Email: ')).trim();
    const policy = (await rl.question('Accept the ReverseEngineering.wiki content policy? [y/N] ')).trim().toLowerCase().startsWith('y');
    const licenses = (await rl.question('License your contributions as CC BY-SA 4.0 (text) and MIT-0 (code)? [y/N] ')).trim().toLowerCase().startsWith('y');
    await registerStart({ username, email, ...(policy ? { 'accept-policy': true as const } : {}), ...(licenses ? { 'accept-licenses': true as const } : {}) });
    await verify('register', { code: (await rl.question('6-digit code: ')).trim() });
  } finally {
    rl.close();
  }
}

async function setMode(mode: string | undefined): Promise<void> {
  if (!['read', 'review', 'write'].includes(mode ?? '')) throw new CliError('Usage: rewiki set-mode read|review|write');
  if (mode !== 'read') {
    // An agent must never lift its own review mode: require a human at a terminal.
    if (!process.stdin.isTTY) throw new CliError(`Only your user can change the mode to "${mode}", from an interactive terminal: rewiki set-mode ${mode}`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`Switch this ReverseEngineering.wiki account to "${mode}" mode? (write = your agent publishes without asking) [y/N] `);
    rl.close();
    if (!answer.trim().toLowerCase().startsWith('y')) throw new CliError('Cancelled.');
  }
  const token = await getToken(serverUrl);
  if (!token) throw new CliError('Not logged in.');
  const result = await api.request('POST', '/auth/mode', { mode }, token);
  console.log(`Mode is now "${result.mode}".`);
}

// ---- update notice -------------------------------------------------------------------------

function newer(a: string, b: string): boolean {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/**
 * Once a day, asks the server which package version it serves. Old versions keep
 * working (the server keeps their tarballs); this only tells the agent to refresh
 * the skill, whose command line points at the current package.
 */
async function updateNotice(): Promise<void> {
  try {
    let check = readUpdateCheck();
    if (!check || Date.now() - check.checkedAt > 86_400_000) {
      const response = await fetch(`${serverUrl}/.well-known/mcp.json`, { signal: AbortSignal.timeout(3000) });
      const info = (await response.json()) as { packages?: Array<{ version?: string | null }> };
      check = { checkedAt: Date.now(), latest: info.packages?.[0]?.version ?? null };
      saveUpdateCheck(check);
    }
    if (check.latest && newer(check.latest, VERSION)) {
      process.stderr.write(`[rewiki] Version ${check.latest} is available (this is ${VERSION}, which keeps working). Tell your user; do not update the skill yourself. They can review the new skill with "rewiki skill diff" and install it with "rewiki skill install" in their own terminal.\n`);
    }
  } catch {
    // Offline or old server: no notice.
  }
}

// ---- main --------------------------------------------------------------------------------

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, options } = flags(rest);
  if (command && command !== 'serve' && command !== 'use') await updateNotice();
  switch (command) {
    case undefined:
    case 'serve':
      await startProxy(serverUrl, new StdioServerTransport());
      return;
    case 'use': {
      const url = positional[0];
      if (!url || !/^https?:\/\//.test(url)) throw new CliError('Usage: rewiki use <site URL>');
      saveConfig({ server: url.replace(/\/$/, '') });
      console.log(`Using ${url.replace(/\/$/, '')}.`);
      return;
    }
    case 'skill':
      if (positional[0] === 'diff') return void (await skillDiff(options));
      if (positional[0] === 'install') return skillInstall(options);
      throw new CliError('Usage: rewiki skill diff|install [--path path/to/SKILL.md]');
    case 'download':
      return download(positional[0], typeof options.out === 'string' ? options.out : undefined);
    case 'tools':
      return tools(positional[0]);
    case 'call':
      if (!positional[0]) throw new CliError('Usage: rewiki call <tool> [json|-|@file] [--dry-run | --confirm]');
      if (options['dry-run'] === true && options.confirm === true) throw new CliError('Use either --dry-run (check only) or --confirm (publish), not both.');
      return call(positional[0], positional[1], options.confirm === true, options['dry-run'] === true);
    case 'register':
      if (positional[0] === 'start') return registerStart(options);
      if (positional[0] === 'verify') return verify('register', options);
      throw new CliError('Usage: rewiki register start|verify ...');
    case 'login':
      if (positional[0] === 'start') return loginStart(options);
      if (positional[0] === 'verify') return verify('login', options);
      return terminalLogin();
    case 'status': {
      const token = await getToken(serverUrl);
      const notLoggedIn = (why: string) => {
        const remembered = rememberedAccount(serverUrl);
        console.log(remembered
          ? `${why} The account last used on this machine is "${remembered}": ask your user whether to log in as ${remembered} again (rewiki login start --username ${remembered}); otherwise ask for their account or create one.`
          : `${why} No account has been used on this machine yet: ask your user whether they have one (username or email) or want to create one.`);
      };
      if (!token) return notLoggedIn(`Not logged in to ${serverUrl}.`);
      try {
        const s = await api.request('GET', '/auth/status', undefined, token);
        const q = s.writes_this_hour;
        console.log(`Logged in to ${serverUrl} as ${s.username} — trust: ${s.trust}, mode: ${s.mode}${q ? `, writes left this hour: ${q.left} of ${q.limit}${q.left < q.limit && q.frees_in_minutes ? ` (next frees up in ${q.frees_in_minutes} min)` : ''}` : ''}. Writes are published as ${s.username}; there is no need to ask your user for an account.`);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          await deleteToken(serverUrl);
          return notLoggedIn('The stored login expired.');
        }
        console.log((error as Error).message);
      }
      return;
    }
    case 'set-mode':
      return setMode(positional[0]);
    case 'logout': {
      const token = await getToken(serverUrl);
      if (token) await api.request('POST', '/auth/logout', {}, token).catch(() => {});
      await deleteToken(serverUrl);
      console.log('Logged out; token revoked and removed.');
      return;
    }
    default:
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*\n/, ''));
      process.exitCode = 1;
  }
}

main().catch((error) => {
  if (error instanceof ApiError) console.error(`${error.code}: ${error.message}`);
  else console.error(error instanceof Error ? error.message : error);
  process.exitCode = process.exitCode || 1;
});
