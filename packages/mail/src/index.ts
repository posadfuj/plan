/**
 * Envío de correos transaccionales. Local: SMTP de Mailpit (Supabase local). Tests: buzón en memoria.
 * Producción (semana 9): proveedor transaccional por SMTP con las mismas variables.
 */
import nodemailer from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export class MemoryMailer implements Mailer {
  readonly sent: (MailMessage & { at: Date })[] = [];
  async send(message: MailMessage): Promise<void> {
    this.sent.push({ ...message, at: new Date() });
  }
  /** Último correo enviado a una dirección (para tests). */
  lastTo(to: string) {
    return [...this.sent].reverse().find((m) => m.to === to);
  }
}

export class SmtpMailer implements Mailer {
  private readonly transport: nodemailer.Transporter;
  constructor(
    opts: { host: string; port: number; secure?: boolean; user?: string; pass?: string },
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport({
      host: opts.host,
      port: opts.port,
      secure: opts.secure ?? false,
      auth: opts.user ? { user: opts.user, pass: opts.pass } : undefined,
    });
  }
  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...message });
  }
}

export function createMailerFromEnv(env: NodeJS.ProcessEnv = process.env): Mailer {
  if ((env.MAIL_TRANSPORT ?? 'smtp') === 'memory') return new MemoryMailer();
  return new SmtpMailer(
    {
      host: env.SMTP_HOST ?? '127.0.0.1',
      port: Number(env.SMTP_PORT ?? 54325),
      secure: env.SMTP_SECURE === 'true',
      user: env.SMTP_USER || undefined,
      pass: env.SMTP_PASS || undefined,
    },
    env.MAIL_FROM ?? 'Aiment Wallet <no-reply@aiment.test>',
  );
}
