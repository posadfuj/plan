import { describe, expect, it } from 'vitest';
import { createMailerFromEnv, ResendMailer } from './index';

describe('correos por Resend', () => {
  it('envía por la API HTTPS con la clave y el remitente configurados', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ id: 'e1' }), { status: 200 });
    }) as unknown as typeof fetch;
    await new ResendMailer('re_prueba', 'Aiment Wallet <no-reply@aimentwallet.com>', {
      fetch: fetchImpl,
    }).send({
      to: 'ana@example.com',
      subject: 'Recupera tu tarjeta',
      text: 'Hola',
    });
    expect(seen[0]!.url).toBe('https://api.resend.com/emails');
    expect(new Headers(seen[0]!.init.headers).get('authorization')).toBe('Bearer re_prueba');
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({
      from: 'Aiment Wallet <no-reply@aimentwallet.com>',
      to: ['ana@example.com'],
      subject: 'Recupera tu tarjeta',
      text: 'Hola',
    });
  });

  it('un rechazo informa el código, nunca el destinatario', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ name: 'validation_error', message: 'x' }), {
        status: 422,
      })) as unknown as typeof fetch;
    const err = await new ResendMailer('k', 'a@b.c', { fetch: fetchImpl })
      .send({ to: 'ana@example.com', subject: 's', text: 't' })
      .catch((e: Error) => e);
    expect((err as Error).message).toBe('Resend 422 validation_error');
    expect((err as Error).message).not.toContain('ana@');
  });

  it('MAIL_TRANSPORT=resend sin clave no arranca', () => {
    expect(() => createMailerFromEnv({ MAIL_TRANSPORT: 'resend' })).toThrow(/RESEND_API_KEY/);
    expect(createMailerFromEnv({ MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 'k' })).toBeInstanceOf(
      ResendMailer,
    );
  });
});
