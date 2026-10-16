import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GATEWAY_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_DIR = resolve(GATEWAY_DIR, '..');

/** Minimal .env parser: KEY=value, optional double quotes, # comments. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

function loadEnv(): Record<string, string> {
  const file = resolve(GATEWAY_DIR, process.env.REWIKI_ENV_FILE ?? '.env');
  const fromFile = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  return { ...fromFile, ...(process.env as Record<string, string>) };
}

export type MailDriver = 'smtp' | 'log';

export interface Config {
  host: string;
  port: number;
  publicUrl: string;
  trustProxy: boolean;
  secret: string;
  /** Shared with MediaWiki (LocalSettings $wgREWikiWebLoginSecret): the wiki's email-code login calls /auth/web/*. */
  webLoginSecret: string;
  dataDir: string;
  /** Write llms.txt, robots.txt, tools.json and the skill into the site root (off for the test instance). */
  publishSiteFiles: boolean;
  mw: {
    apiUrl: string; publicUrl: string; gatewayUser: string; gatewayPassword: string; dir: string; phpBin: string;
    /** Environment for MediaWiki maintenance commands (the test instance sets REWIKI_WIKI=test, so they hit the test database). */
    env: NodeJS.ProcessEnv;
  };
  mail: {
    driver: MailDriver;
    from: string;
    replyTo: string;
    smtp: { host: string; port: number; secure: boolean; user: string; pass: string };
  };
  indexPollSeconds: number;
  dumpDir: string;
  dumpIntervalHours: number;
  termsVersion: string;
  production: boolean;
}

export function loadConfig(): Config {
  const env = loadEnv();
  const get = (key: string, fallback = ''): string => env[key] ?? fallback;
  const dataDir = resolve(GATEWAY_DIR, get('DATA_DIR', './data'));
  const config: Config = {
    host: get('HOST', '127.0.0.1'),
    port: Number(get('PORT', '8787')),
    publicUrl: get('PUBLIC_URL', 'http://localhost:8787').replace(/\/$/, ''),
    trustProxy: get('TRUST_PROXY') === '1',
    secret: get('GATEWAY_SECRET'),
    webLoginSecret: get('WEB_LOGIN_SECRET'),
    dataDir,
    publishSiteFiles: get('PUBLISH_SITE_FILES', '1') !== '0',
    mw: {
      apiUrl: get('MW_API_URL', 'http://wikivibe.test/api.php'),
      publicUrl: get('MW_PUBLIC_URL', 'http://wikivibe.test').replace(/\/$/, ''),
      gatewayUser: get('MW_GATEWAY_USER', 'REWiki Gateway'),
      gatewayPassword: get('MW_GATEWAY_PASSWORD'),
      dir: resolve(GATEWAY_DIR, get('MW_DIR', '..')),
      phpBin: get('PHP_BIN', 'php'),
      env: { ...process.env, ...Object.fromEntries(get('MW_ENV').split(',').map((kv) => kv.trim()).filter((kv) => kv.includes('=')).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)])) },
    },
    mail: {
      driver: get('MAIL_DRIVER', 'smtp') as MailDriver,
      from: get('MAIL_FROM', 'ReverseEngineering.wiki <no-reply@wikivibe.test>'),
      replyTo: get('MAIL_REPLY_TO'),
      smtp: {
        host: get('SMTP_HOST', '127.0.0.1'),
        port: Number(get('SMTP_PORT', '1025')),
        secure: get('SMTP_SECURE') === 'true',
        user: get('SMTP_USER'),
        pass: get('SMTP_PASS'),
      },
    },
    indexPollSeconds: Number(get('INDEX_POLL_SECONDS', '5')),
    dumpDir: resolve(GATEWAY_DIR, get('DUMP_DIR', './data/dumps')),
    dumpIntervalHours: Number(get('DUMP_INTERVAL_HOURS', '24')),
    termsVersion: get('TERMS_VERSION', '2026-10-15'),
    production: get('NODE_ENV') === 'production',
  };
  if (config.secret.length < 32) throw new Error('GATEWAY_SECRET must be set (32+ chars). See .env.example.');
  if (!['smtp', 'log'].includes(config.mail.driver)) throw new Error(`Unknown MAIL_DRIVER "${config.mail.driver}"`);
  if (config.mail.driver === 'log' && config.production) throw new Error('MAIL_DRIVER=log is not allowed in production');
  // Agents run the package straight from this site: over plain HTTP anyone in the path could swap it.
  if (config.production && !config.publicUrl.startsWith('https://')) throw new Error('PUBLIC_URL must use https:// in production');
  return config;
}
