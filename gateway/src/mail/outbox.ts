/**
 * Outbox: every email is queued, sent, and retried with backoff. Recipient
 * and template data are stored encrypted; the send log keeps only a hash.
 */
import type { AccountsDb } from '../db/accounts.ts';
import type { Secrets } from '../util/crypto.ts';
import { normalizeEmail } from '../util/crypto.ts';
import type { MailTransport } from './transport.ts';
import { renderTemplate, type TemplateName } from './templates/index.ts';

export interface OutgoingMail {
  to: string;
  template: TemplateName;
  data: Record<string, string>;
  /** E.g. the challenge id, so retries never send twice. */
  idempotencyKey: string;
}

const BACKOFF_SECONDS = [10, 60, 300, 1800];

interface OutboxRow {
  id: number;
  template: TemplateName;
  to_enc: string;
  data_enc: string;
  attempts: number;
}

export class Outbox {
  private readonly db: AccountsDb;
  private readonly secrets: Secrets;
  private readonly transport: MailTransport;

  constructor(db: AccountsDb, secrets: Secrets, transport: MailTransport) {
    this.db = db;
    this.secrets = secrets;
    this.transport = transport;
  }

  /** Queues the message (once per idempotency key) and returns its row id. */
  enqueue(mail: OutgoingMail): number | null {
    const now = Date.now();
    const result = this.db.db.prepare(`insert or ignore into mail_outbox
      (idempotency_key, template, to_enc, to_hash, data_enc, next_attempt_at, created_at) values (?, ?, ?, ?, ?, ?, ?)`)
      .run(mail.idempotencyKey, mail.template, this.secrets.encrypt(mail.to),
        this.secrets.hmac(normalizeEmail(mail.to)), this.secrets.encrypt(JSON.stringify(mail.data)), now, now);
    return result.changes ? Number(result.lastInsertRowid) : null;
  }

  /** Sends one queued message now. Returns true when delivered to the transport. */
  async attempt(id: number): Promise<boolean> {
    const row = this.db.db.prepare("select * from mail_outbox where id = ? and status = 'pending'").get(id) as OutboxRow | undefined;
    if (!row) return false;
    const rendered = renderTemplate(row.template, JSON.parse(this.secrets.decrypt(row.data_enc)));
    try {
      const { providerId } = await this.transport.send({ to: this.secrets.decrypt(row.to_enc), ...rendered });
      // Sent: drop the encrypted payload, keep the log entry.
      this.db.db.prepare(`update mail_outbox set status = 'sent', provider_id = ?, sent_at = ?, attempts = attempts + 1,
        to_enc = '', data_enc = '' where id = ?`).run(providerId, Date.now(), id);
      return true;
    } catch (error) {
      const attempts = row.attempts + 1;
      const delay = BACKOFF_SECONDS[attempts - 1];
      this.db.db.prepare(`update mail_outbox set attempts = ?, error = ?, status = ?, next_attempt_at = ?,
        to_enc = case when ? then '' else to_enc end, data_enc = case when ? then '' else data_enc end where id = ?`)
        .run(attempts, String((error as Error).message ?? error).slice(0, 300), delay ? 'pending' : 'failed',
          Date.now() + (delay ?? 0) * 1000, delay ? 0 : 1, delay ? 0 : 1, id);
      return false;
    }
  }

  async processDue(): Promise<void> {
    const due = this.db.db.prepare("select id from mail_outbox where status = 'pending' and next_attempt_at <= ? order by id limit 20")
      .all(Date.now()) as Array<{ id: number }>;
    for (const { id } of due) await this.attempt(id);
  }
}
