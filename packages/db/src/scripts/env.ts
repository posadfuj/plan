import { dbEnvSchema, parseEnv } from '@aiment/config';
import { z } from 'zod';

export const env = parseEnv(
  dbEnvSchema.extend({
    SUPABASE_URL: z.string().url().optional(),
    SUPABASE_SECRET_KEY: z.string().optional(),
    SEED_USER_PASSWORD: z.string().min(8).default('aiment-demo-2026'),
  }),
);
