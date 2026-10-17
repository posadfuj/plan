import { dbEnvSchema, opsEnvSchema, parseEnv, walletEnvSchema } from '@aiment/config';
import { createMailerFromEnv } from '@aiment/mail';
import { Alerter } from '@aiment/ops';
import { createDb } from '@aiment/db';
import { createGoogleWallet, FakeWalletProvider, type WalletProvider } from '@aiment/wallet';
import { z } from 'zod';
import { startWorker } from './boss';

const env = parseEnv(
  dbEnvSchema
    .extend(walletEnvSchema.shape)
    .extend(opsEnvSchema.shape)
    .extend({
      PUBLIC_BASE_URL: z.string().url().default('http://localhost:5173'),
    }),
);
const log = (m: string) => console.log(m);

const google = await createGoogleWallet(env, env.PUBLIC_BASE_URL, { log });
const providers: WalletProvider[] = [
  ...(google.provider ? [google.provider] : []),
  // Pases de la semilla local (issuer "fake:google-local"). Apple se integra en la semana 8.
  ...(google.provider?.mode === 'live' ? [] : [new FakeWalletProvider('google', { log })]),
  new FakeWalletProvider('apple', { log }),
];

const alerter = new Alerter({
  source: 'worker',
  webhookUrl: env.ALERT_WEBHOOK_URL,
  email: env.ALERT_EMAIL ? { mailer: createMailerFromEnv(), to: env.ALERT_EMAIL } : undefined,
  log,
});

const { db, close } = createDb(env.DATABASE_URL, { max: 4 });
const worker = await startWorker({
  databaseUrl: env.DATABASE_URL,
  db,
  providers,
  publicBaseUrl: env.PUBLIC_BASE_URL,
  alerter,
  log,
});
console.log(`✔ Worker de Aiment Wallet en marcha · ${google.summary} · Apple simulado`);

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    void worker
      .stop()
      .then(close)
      .finally(() => process.exit(0));
  });
