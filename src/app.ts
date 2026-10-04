import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import { config } from './config.js';
import { AppError } from './lib/errors.js';
import authRoutes from './modules/auth.js';
import productRoutes from './modules/products.js';
import partyRoutes from './modules/parties.js';
import invoiceRoutes from './modules/invoices.js';
import paymentRoutes from './modules/payments.js';
import reportRoutes from './modules/reports.js';
import fileRoutes from './modules/files.js';
import excelRoutes from './modules/excel.js';
import aiRoutes from './modules/ai.js';
import insightRoutes from './modules/insights.js';
import scanRoutes from './modules/scans.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// the web app lives in public/ next to src/ and dist/
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

export async function buildApp(opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? config.NODE_ENV !== 'test', bodyLimit: 2 * 1024 * 1024 });

  await app.register(cors, { origin: config.CORS_ORIGIN === '*' ? true : config.CORS_ORIGIN.split(',') });
  await app.register(jwt, { secret: config.JWT_SECRET, sign: { expiresIn: config.JWT_EXPIRES_IN } });
  await app.register(multipart, { limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1 } });

  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: err.code, message: err.message, details: err.details });
    const e = err as unknown as { code?: string; cause?: { code?: string } };
    const pgCode = e.code ?? e.cause?.code;
    if (pgCode === '23505') return reply.status(409).send({ error: 'conflict', message: 'That value is already used (for example, a duplicate barcode or SKU).' });
    if ((err as FastifyError).statusCode && (err as FastifyError).statusCode! < 500) {
      return reply.status((err as FastifyError).statusCode!).send({ error: 'request_error', message: err.message });
    }
    req.log.error(err);
    return reply.status(500).send({ error: 'server_error', message: 'Something went wrong on the server.' });
  });

  app.get('/health', async () => ({ ok: true }));

  // a sample supplier bill for trying the Bill Scanner
  app.get('/sample-bill.png', async (_req, reply) => reply.type('image/png').send(await readFile(join(PUBLIC_DIR, 'sample-bill.png'))));
  app.get('/sample-bill-photo.jpg', async (_req, reply) => reply.type('image/jpeg').send(await readFile(join(PUBLIC_DIR, 'sample-bill-photo.jpg'))));

  // the Stockbook web app: open http://localhost:3000 in a browser
  app.get('/', async (_req, reply) => {
    try {
      const html = await readFile(join(PUBLIC_DIR, 'index.html'));
      return reply.type('text/html; charset=utf-8').send(html);
    } catch {
      return { name: 'Stockbook API', status: 'running', note: 'public/index.html not found' };
    }
  });

  // public routes
  await app.register(authRoutes, { prefix: '/auth' });

  // everything else needs a valid token
  await app.register(async (secured) => {
    secured.addHook('onRequest', async (req) => {
      try { await req.jwtVerify(); } catch { throw new AppError(401, 'Sign in again to continue', 'unauthorized'); }
    });
    await secured.register(productRoutes, { prefix: '/products' });
    await secured.register(partyRoutes, { prefix: '/parties' });
    await secured.register(invoiceRoutes, { prefix: '/invoices' });
    await secured.register(paymentRoutes, { prefix: '/payments' });
    await secured.register(reportRoutes, { prefix: '/reports' });
    await secured.register(fileRoutes, { prefix: '/files' });
    await secured.register(excelRoutes, { prefix: '/excel' });
    await secured.register(aiRoutes, { prefix: '/ai' });
    await secured.register(insightRoutes, { prefix: '/insights' });
    await secured.register(scanRoutes, { prefix: '/scans' });
  });

  return app;
}
