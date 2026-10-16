/** Logged-in MediaWiki sessions: the gateway's service account and one per operator. */
import type { Config } from '../config.ts';
import type { Operator } from '../db/accounts.ts';
import type { Secrets } from '../util/crypto.ts';
import { MwClient } from './client.ts';

export class SessionPool {
  private readonly config: Config;
  private readonly secrets: Secrets;
  private gatewaySession: Promise<MwClient> | null = null;
  private readonly operators = new Map<number, Promise<MwClient>>();
  /** Anonymous client for public reads. */
  readonly reader: MwClient;

  constructor(config: Config, secrets: Secrets) {
    this.config = config;
    this.secrets = secrets;
    this.reader = new MwClient(config.mw.apiUrl, config.mw.publicUrl);
  }

  gateway(): Promise<MwClient> {
    if (!this.gatewaySession) {
      const client = new MwClient(this.config.mw.apiUrl, this.config.mw.publicUrl);
      this.gatewaySession = client.login(this.config.mw.gatewayUser, this.config.mw.gatewayPassword).then(() => client);
      this.gatewaySession.catch(() => { this.gatewaySession = null; });
    }
    return this.gatewaySession;
  }

  forOperator(op: Operator): Promise<MwClient> {
    let session = this.operators.get(op.id);
    if (!session) {
      const client = new MwClient(this.config.mw.apiUrl, this.config.mw.publicUrl, `REWikiGateway/0.1 (operator ${op.id})`);
      session = client.login(op.username, this.secrets.decrypt(op.mw_password_enc)).then(() => client);
      session.catch(() => this.operators.delete(op.id));
      this.operators.set(op.id, session);
    }
    return session;
  }

  forget(operatorId: number): void {
    this.operators.delete(operatorId);
  }
}
