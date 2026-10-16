/**
 * Local storage (design/08-accounts-and-auth.md#local-storage-package):
 *   token                → OS keychain (fallback: ~/.rewiki/credentials, owner-only)
 *   server, username     → ~/.rewiki/config.json (not secret)
 * The token is never printed, logged or returned to the model.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.REWIKI_HOME ?? join(homedir(), '.rewiki');
const CONFIG = join(HOME, 'config.json');
const CREDENTIALS = join(HOME, 'credentials');
const SERVICE = 'rewiki';

export interface LocalConfig {
  server?: string;
  username?: string;
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writePrivate(path: string, data: unknown): void {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Not supported on every filesystem.
  }
}

export function readConfig(): LocalConfig {
  return readJson<LocalConfig>(CONFIG, {});
}

/**
 * The account last used with this server on this machine (kept after logout). Local only:
 * the server never says which account an email belongs to.
 */
export function rememberedAccount(server: string): string | null {
  const config = readConfig();
  return config.server === server && config.username ? config.username : null;
}

export function saveConfig(patch: Partial<LocalConfig>): void {
  writePrivate(CONFIG, { ...readConfig(), ...patch });
}

/** A login/registration waiting for its emailed code (non-interactive CLI flow). */
export interface PendingAuth {
  server: string;
  kind: 'login' | 'register';
  challengeId: string;
  nonce: string;
  username: string;
}

const PENDING = join(HOME, 'pending.json');

export function savePending(pending: PendingAuth): void {
  writePrivate(PENDING, pending);
}

export function readPending(): PendingAuth | null {
  return readJson<PendingAuth | null>(PENDING, null);
}

export function clearPending(): void {
  writePrivate(PENDING, null);
}

/** Last check for a newer package version (once a day). */
export interface UpdateCheck {
  checkedAt: number;
  latest: string | null;
}

const UPDATE_CHECK = join(HOME, 'update-check.json');

export function readUpdateCheck(): UpdateCheck | null {
  return readJson<UpdateCheck | null>(UPDATE_CHECK, null);
}

export function saveUpdateCheck(check: UpdateCheck): void {
  writePrivate(UPDATE_CHECK, check);
}

type Keyring = { Entry: new (service: string, account: string) => { getPassword(): string | null; setPassword(p: string): void; deletePassword(): boolean } };
let keyring: Keyring | null | undefined;

async function loadKeyring(): Promise<Keyring | null> {
  if (keyring !== undefined) return keyring;
  if (process.env.REWIKI_NO_KEYCHAIN === '1') return (keyring = null);
  try {
    keyring = (await import('@napi-rs/keyring')) as unknown as Keyring;
  } catch {
    keyring = null;
  }
  return keyring;
}

let warned = false;
function warnFallback(): void {
  if (warned) return;
  warned = true;
  process.stderr.write(`[rewiki] OS keychain unavailable; storing the token in ${CREDENTIALS} (owner-only). Agents with file access could read it.\n`);
}

export async function getToken(server: string): Promise<string | null> {
  const k = await loadKeyring();
  if (k) {
    try {
      return new k.Entry(SERVICE, server).getPassword() ?? null;
    } catch {
      // Fall through to the file.
    }
  }
  return readJson<Record<string, string>>(CREDENTIALS, {})[server] ?? null;
}

/** Returns where the token was stored. */
export async function setToken(server: string, token: string): Promise<'keychain' | 'file'> {
  const k = await loadKeyring();
  if (k) {
    try {
      new k.Entry(SERVICE, server).setPassword(token);
      return 'keychain';
    } catch {
      // Fall through to the file.
    }
  }
  warnFallback();
  writePrivate(CREDENTIALS, { ...readJson<Record<string, string>>(CREDENTIALS, {}), [server]: token });
  return 'file';
}

export async function deleteToken(server: string): Promise<void> {
  const k = await loadKeyring();
  if (k) {
    try {
      new k.Entry(SERVICE, server).deletePassword();
    } catch {
      // Not stored there.
    }
  }
  if (existsSync(CREDENTIALS)) {
    const all = readJson<Record<string, string>>(CREDENTIALS, {});
    delete all[server];
    writePrivate(CREDENTIALS, all);
  }
}
