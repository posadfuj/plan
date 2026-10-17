/**
 * Envío de correos transaccionales. Local: SMTP de Mailpit (Supabase local). Tests: buzón en memoria.
 * Producción: Resend por su API HTTPS (MAIL_TRANSPORT=resend), sin SMTP.
 */
import { createTransport, type Mail } from 'nodemailer';

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
  private readonly transport: Mail;
  constructor(
    opts: { host: string; port: number; secure?: boolean; user?: string; pass?: string },
    private readonly from: string,
  ) {
    this.transport = createTransport({
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

/** Resend (https://resend.com): un POST por correo. El error informa el código, nunca el destinatario. */
export class ResendMailer implements Mailer {
  private readonly fetchImpl: typeof fetch;
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    opts: { fetch?: typeof fetch } = {},
  ) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }
  async send(message: MailMessage): Promise<void> {
    const res = await this.fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { name?: string; message?: string } | null;
      throw new Error(`Resend ${res.status}${data?.name ? ` ${data.name}` : ''}`);
    }
  }
}

export function createMailerFromEnv(env: NodeJS.ProcessEnv = process.env): Mailer {
  const transport = env.MAIL_TRANSPORT ?? 'smtp';
  if (transport === 'memory') return new MemoryMailer();
  if (transport === 'resend') {
    if (!env.RESEND_API_KEY) throw new Error('MAIL_TRANSPORT=resend necesita RESEND_API_KEY');
    return new ResendMailer(env.RESEND_API_KEY, env.MAIL_FROM ?? 'Aiment Wallet <no-reply@aimentwallet.com>');
  }
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
