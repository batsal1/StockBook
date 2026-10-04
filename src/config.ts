import 'dotenv/config';
import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('30d'),
  UPLOAD_DIR: z.string().default('./uploads'),
  MAX_UPLOAD_MB: z.coerce.number().default(15),
  CORS_ORIGIN: z.string().default('*'),
  // AI bill reading and packet-photo product fill (optional)
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5-5'),
  // Barcode lookup providers (all optional; free open databases are always tried)
  UPCITEMDB_KEY: z.string().optional(),
  BARCODELOOKUP_KEY: z.string().optional(),
  BARCODE_LOOKUP_TIMEOUT_MS: z.coerce.number().default(4000),
});

export const config = Env.parse(process.env);
export type Config = typeof config;
