/** SMTP driver: Mailpit in development, any provider's SMTP relay in production. */
import nodemailer, { type Transporter } from 'nodemailer';
import type { Config } from '../../config.ts';
import type { MailTransport, RenderedMail, SendResult } from '../transport.ts';

export class SmtpTransport implements MailTransport {
  readonly name = 'smtp';
  private readonly transporter: Transporter;
  private readonly from: string;
  private readonly replyTo: string;

  constructor(mail: Config['mail']) {
    this.from = mail.from;
    this.replyTo = mail.replyTo;
    this.transporter = nodemailer.createTransport({
      host: mail.smtp.host,
      port: mail.smtp.port,
      secure: mail.smtp.secure,
      // With credentials, STARTTLS is mandatory: never send the SMTP key over a downgraded connection.
      requireTLS: !mail.smtp.secure && !!mail.smtp.user,
      auth: mail.smtp.user ? { user: mail.smtp.user, pass: mail.smtp.pass } : undefined,
    });
  }

  async verify(): Promise<void> {
    await this.transporter.verify();
  }

  async send(mail: RenderedMail): Promise<SendResult> {
    const info = await this.transporter.sendMail({
      from: this.from,
      replyTo: this.replyTo || undefined,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    return { providerId: info.messageId };
  }
}
