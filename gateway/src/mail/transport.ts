import type { Config } from '../config.ts';
import { SmtpTransport } from './drivers/smtp.ts';
import { LogTransport } from './drivers/log.ts';

export interface RenderedMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface SendResult {
  providerId: string;
}

export interface MailTransport {
  readonly name: string;
  /** Checked at startup and by /health. */
  verify(): Promise<void>;
  send(mail: RenderedMail): Promise<SendResult>;
}

/** The only place that maps MAIL_DRIVER to an implementation. Add API drivers here. */
export function createTransport(config: Config): MailTransport {
  switch (config.mail.driver) {
    case 'smtp':
      return new SmtpTransport(config.mail);
    case 'log':
      return new LogTransport(config.dataDir);
    default:
      throw new Error(`Unknown MAIL_DRIVER "${config.mail.driver}"`);
  }
}
