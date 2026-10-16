/** Wires configuration and services together; shared by the server and the CLI. */
import { join } from 'node:path';
import { loadConfig, type Config } from './config.ts';
import { AccountsDb } from './db/accounts.ts';
import { SearchIndex } from './index/index.ts';
import { Indexer } from './index/indexer.ts';
import { SessionPool } from './mw/sessions.ts';
import { Secrets } from './util/crypto.ts';
import { Mailer } from './mail/index.ts';
import { AuthService } from './auth/service.ts';
import { TAGS, type Services } from './tools/context.ts';

export interface App extends Services {
  mailer: Mailer;
  auth: AuthService;
}

export function createApp(config: Config = loadConfig()): App {
  const secrets = new Secrets(config.secret);
  const db = new AccountsDb(join(config.dataDir, 'gateway.sqlite'));
  const index = new SearchIndex(join(config.dataDir, 'index.sqlite'));
  const sessions = new SessionPool(config, secrets);
  const indexer = new Indexer(sessions.reader, index);
  const mailer = new Mailer(config, db, secrets);
  const auth = new AuthService(config, db, secrets, mailer, sessions);
  return { config, secrets, db, index, sessions, indexer, mailer, auth };
}

/** Idempotent MediaWiki-side setup the gateway relies on. */
export async function ensureWikiSetup(app: App): Promise<void> {
  const mw = await app.sessions.gateway();
  for (const [tag, description] of Object.entries(TAGS)) await mw.createTag(tag, description);
}
