/**
 * Mail module — the only email sender in ReverseEngineering.wiki (design/08-accounts-and-auth.md#email-delivery).
 * Everything else calls sendMail(); the provider is chosen by MAIL_* settings.
 */
import type { Config } from '../config.ts';
import type { AccountsDb } from '../db/accounts.ts';
import type { Secrets } from '../util/crypto.ts';
import { normalizeEmail } from '../util/crypto.ts';
import { createTransport, type MailTransport } from './transport.ts';
import { Outbox, type OutgoingMail } from './outbox.ts';

export type { OutgoingMail } from './outbox.ts';
export { takeIdentifierAllowance, takeSendAllowance } from './limits.ts';

export class Mailer {
  readonly transport: MailTransport;
  private readonly outbox: Outbox;
  private readonly db: AccountsDb;
  private readonly secrets: Secrets;
  private timer: NodeJS.Timeout | null = null;

  constructor(config: Config, db: AccountsDb, secrets: Secrets, transport: MailTransport = createTransport(config)) {
    this.transport = transport;
    this.db = db;
    this.secrets = secrets;
    this.outbox = new Outbox(db, secrets, transport);
  }

  /**
   * Queues and immediately tries to send. Returns 'sent', 'queued' (will be
   * retried) or 'suppressed' (address bounced/complained before).
   */
  async sendMail(mail: OutgoingMail): Promise<'sent' | 'queued' | 'suppressed'> {
    if (this.db.isSuppressed(this.secrets.hmac(normalizeEmail(mail.to)))) return 'suppressed';
    const id = this.outbox.enqueue(mail);
    if (id === null) return 'queued'; // already queued under this idempotency key
    return (await this.outbox.attempt(id)) ? 'sent' : 'queued';
  }

  startWorker(intervalSeconds = 10): void {
    this.timer = setInterval(() => void this.outbox.processDue().catch(() => {}), intervalSeconds * 1000);
  }

  stopWorker(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
