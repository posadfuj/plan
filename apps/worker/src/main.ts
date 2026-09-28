import { dbEnvSchema, parseEnv } from '@aiment/config';
import { createDb } from '@aiment/db';
import { FakeWalletProvider, type WalletProvider } from '@aiment/wallet';
import { z } from 'zod';
import { startWorker } from './boss';

const env = parseEnv(
  dbEnvSchema.extend({
    WALLET_PROVIDER: z.enum(['fake', 'google', 'apple']).default('fake'),
    PUBLIC_BASE_URL: z.string().url().default('http://localhost:5173'),
  }),
);

function buildProviders(): WalletProvider[] {
  if (env.WALLET_PROVIDER !== 'fake')
    throw new Error(
      `WALLET_PROVIDER=${env.WALLET_PROVIDER}: los proveedores reales se integran en las semanas 7 (Google) y 8 (Apple).`,
    );
  const log = (m: string) => console.log(m);
  return [new FakeWalletProvider('google', { log }), new FakeWalletProvider('apple', { log })];
}

const { db, close } = createDb(env.DATABASE_URL, { max: 4 });
const worker = await startWorker({
  databaseUrl: env.DATABASE_URL,
  db,
  providers: buildProviders(),
  publicBaseUrl: env.PUBLIC_BASE_URL,
  log: (m) => console.log(m),
});
console.log(`✔ Worker de Aiment Wallet en marcha (Wallet: ${env.WALLET_PROVIDER})`);

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    void worker
      .stop()
      .then(close)
      .finally(() => process.exit(0));
  });
