/**
 * The end-to-end test environment: a separate MediaWiki database (rewiki_test) served by
 * PHP's built-in server on 127.0.0.1:8788, and a second gateway on 127.0.0.1:8789 with its
 * own data directory (data-test/). The real wiki is never touched.
 *
 *   node scripts/test-env.mjs setup   (re)create the test wiki: database, accounts, templates
 *   node scripts/test-env.mjs run     start both, run the gateway and client suites, stop
 *
 * Needs: MySQL root access without password (Laragon default), Mailpit, a built client tarball
 * (npm run cli -- pack-client).
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const GATEWAY_DIR = resolve(import.meta.dirname, '..');
const REPO_DIR = resolve(GATEWAY_DIR, '..');
const WIKI_PORT = 8788;
const GATEWAY_PORT = 8789;
const WIKI_URL = `http://127.0.0.1:${WIKI_PORT}`;
const GATEWAY_URL = `http://127.0.0.1:${GATEWAY_PORT}`;
const TEST_DB = 'rewiki_test';

const parseEnv = (text) => Object.fromEntries(text.split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => {
  const i = l.indexOf('=');
  return [l.slice(0, i), l.slice(i + 1).replace(/^"(.*)"$/, '$1')];
}));
const env = parseEnv(readFileSync(join(GATEWAY_DIR, '.env'), 'utf8'));
const php = env.PHP_BIN;
const mysqlBin = (() => {
  const base = 'C:/laragon/bin/mysql';
  const dir = existsSync(base) ? readdirSync(base).find((d) => d.startsWith('mysql')) : null;
  return dir ? join(base, dir, 'bin', 'mysql.exe') : 'mysql';
})();
const wikiEnv = { ...process.env, REWIKI_WIKI: 'test', REWIKI_TEST_DB: TEST_DB, REWIKI_TEST_SERVER: WIKI_URL, REWIKI_TEST_GATEWAY: GATEWAY_URL };
const testEnv = { ...process.env, REWIKI_ENV_FILE: '.env.test', GATEWAY_URL, WIKI_URL };

function must(command, args, opts = {}) {
  const r = spawnSync(command, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${command} ${args.slice(0, 3).join(' ')} … exited with ${r.status}`);
}

async function waitFor(url, label, ms = 60_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label} did not start (${url})`);
}

function startWiki() {
  // OPcache only for this process: the machine's php.ini is not touched.
  return spawn(php, ['-d', 'zend_extension=opcache', '-d', 'opcache.enable_cli=1', '-d', 'opcache.memory_consumption=256', '-d', 'opcache.max_accelerated_files=20000',
    '-S', `127.0.0.1:${WIKI_PORT}`, '-t', REPO_DIR], { cwd: REPO_DIR, env: wikiEnv, stdio: 'ignore' });
}

function startGateway() {
  return spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.ts'], { cwd: GATEWAY_DIR, env: testEnv, stdio: ['ignore', 'ignore', 'inherit'] });
}

function writeTestEnvFile() {
  const overrides = {
    HOST: '127.0.0.1', PORT: String(GATEWAY_PORT), PUBLIC_URL: GATEWAY_URL, TRUST_PROXY: '1',
    MW_API_URL: `${WIKI_URL}/api.php`, MW_PUBLIC_URL: WIKI_URL,
    DATA_DIR: './data-test', DUMP_DIR: './data-test/dumps', DUMP_INTERVAL_HOURS: '0', PUBLISH_SITE_FILES: '0',
    // Every MediaWiki maintenance command the test gateway runs targets the test database.
    MW_ENV: `REWIKI_WIKI=test,REWIKI_TEST_DB=${TEST_DB},REWIKI_TEST_SERVER=${WIKI_URL},REWIKI_TEST_GATEWAY=${GATEWAY_URL}`,
    GATEWAY_SECRET: randomBytes(32).toString('base64url'),
  };
  const lines = [`# Test instance (scripts/test-env.mjs). Generated from .env; never used for the real wiki.`];
  for (const [k, v] of Object.entries({ ...env, ...overrides })) lines.push(`${k}=${/[\s"#]/.test(v) ? JSON.stringify(v) : v}`);
  writeFileSync(join(GATEWAY_DIR, '.env.test'), `${lines.join('\n')}\n`);
}

function copyTarballs() {
  const from = join(GATEWAY_DIR, 'data', 'client');
  const to = join(GATEWAY_DIR, 'data-test', 'client');
  mkdirSync(to, { recursive: true });
  if (existsSync(from)) for (const f of readdirSync(from)) if (f.endsWith('.tgz')) copyFileSync(join(from, f), join(to, f));
}

/** Creates `target` with the tables of `source`, all empty except updatelog (applied schema updates) and interwiki. */
export async function emptyCopy(source, target, dbUser) {
  const dump = (args) => {
    const r = spawnSync(join(mysqlBin, '..', 'mysqldump.exe'), ['-uroot', '--default-character-set=binary', ...args], { maxBuffer: 1 << 28 });
    if (r.status !== 0) throw new Error(`mysqldump failed: ${r.stderr}`);
    return r.stdout;
  };
  const schema = Buffer.from(String(dump(['--no-data', '--skip-triggers', source])).replace(/ AUTO_INCREMENT=\d+/g, ''));
  const keep = dump(['--no-create-info', source, 'updatelog', 'interwiki']);
  const host = String(spawnSync(mysqlBin, ['-uroot', '-N', '-e', `SELECT host FROM mysql.user WHERE user='${dbUser}' LIMIT 1`]).stdout).trim() || 'localhost';
  must(mysqlBin, ['-uroot', '-e', `DROP DATABASE IF EXISTS \`${target}\`; CREATE DATABASE \`${target}\` CHARACTER SET binary; GRANT ALL PRIVILEGES ON \`${target}\`.* TO '${dbUser}'@'${host}';`]);
  for (const sql of [schema, keep]) {
    const r = spawnSync(mysqlBin, ['-uroot', '--default-character-set=binary', target], { input: sql, maxBuffer: 1 << 26 });
    if (r.status !== 0) throw new Error(`loading into ${target} failed: ${r.stderr}`);
  }
}

async function setup() {
  const settings = readFileSync(join(REPO_DIR, 'LocalSettings.php'), 'utf8');
  const dbUser = /\$wgDBuser\s*=\s*"([^"]+)"/.exec(settings)[1];
  const dbPass = /\$wgDBpassword\s*=\s*"([^"]+)"/.exec(settings)[1];
  const realDb = /\$wgDBname\s*=\s*"([^"]+)"/.exec(settings)[1];
  console.log(`Recreating the test database ${TEST_DB} with the schema of ${realDb} (no content)…`);
  // The installer refuses to run next to an existing LocalSettings.php, so the empty wiki is
  // built from the real one's schema: every table empty, except the record of applied updates.
  await emptyCopy(realDb, TEST_DB, dbUser);
  must(php, ['maintenance/run.php', 'update', '--quick'], { cwd: REPO_DIR, env: wikiEnv });
  must(php, ['maintenance/run.php', 'createAndPromote', '--force', '--custom-groups', 'suppress', '--sysop', '--bureaucrat', 'Admin', randomBytes(18).toString('base64url')], { cwd: REPO_DIR, env: wikiEnv });
  must(php, ['maintenance/run.php', 'createAndPromote', '--custom-groups', 'gateway', env.MW_GATEWAY_USER, env.MW_GATEWAY_PASSWORD], { cwd: REPO_DIR, env: wikiEnv });
  must(php, ['maintenance/run.php', 'initSiteStats', '--update'], { cwd: REPO_DIR, env: wikiEnv });

  writeTestEnvFile();
  rmSync(join(GATEWAY_DIR, 'data-test'), { recursive: true, force: true });
  copyTarballs();
  const wiki = startWiki();
  try {
    await waitFor(`${WIKI_URL}/api.php?action=query&meta=siteinfo&format=json`, 'test wiki');
    must(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/cli.ts', 'setup'], { cwd: GATEWAY_DIR, env: testEnv });
  } finally {
    wiki.kill();
  }
  console.log(`Test wiki ready: ${WIKI_URL} (database ${TEST_DB}), gateway config gateway/.env.test.`);
}

async function run() {
  if (!existsSync(join(GATEWAY_DIR, '.env.test'))) throw new Error('No test environment yet: run "npm run e2e:setup" first.');
  copyTarballs();
  // Each run starts with fresh rate limits in the TEST gateway's database (never the real one).
  const testDb = join(GATEWAY_DIR, 'data-test', 'gateway.sqlite');
  if (existsSync(testDb)) {
    const { DatabaseSync } = await import('node:sqlite');
    new DatabaseSync(testDb).exec('delete from rate_events');
  }
  const wiki = startWiki();
  let gateway = null;
  let failed = false;
  try {
    await waitFor(`${WIKI_URL}/api.php?action=query&meta=siteinfo&format=json`, 'test wiki');
    gateway = startGateway();
    await waitFor(`${GATEWAY_URL}/health`, 'test gateway');
    for (const [cwd, script] of [[GATEWAY_DIR, 'scripts/e2e.ts'], [GATEWAY_DIR, 'scripts/e2e-oauth.ts'], [join(REPO_DIR, 'client'), 'scripts/e2e-proxy.mjs']]) {
      const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script], { cwd, env: testEnv, stdio: 'inherit' });
      if (r.status !== 0) failed = true;
    }
  } finally {
    gateway?.kill();
    wiki.kill();
  }
  if (failed) {
    console.error('\nEnd-to-end tests failed.');
    process.exit(1);
  }
  console.log('\nAll end-to-end suites passed (test wiki; the real wiki was not touched).');
}

const command = process.argv[2] ?? 'run';
if (command === 'setup') await setup();
else if (command === 'run') await run();
else {
  console.error('Usage: node scripts/test-env.mjs setup|run');
  process.exit(2);
}
