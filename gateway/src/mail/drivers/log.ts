/** Test-only driver: writes messages to data/mail.log and keeps them in memory. */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MailTransport, RenderedMail, SendResult } from '../transport.ts';

export class LogTransport implements MailTransport {
  readonly name = 'log';
  static readonly sent: RenderedMail[] = [];
  private readonly file: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, 'mail.log');
  }

  async verify(): Promise<void> {}

  async send(mail: RenderedMail): Promise<SendResult> {
    LogTransport.sent.push(mail);
    const id = randomUUID();
    appendFileSync(this.file, `--- ${new Date().toISOString()} ${id}\nTo: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}\n`);
    return { providerId: id };
  }
}
