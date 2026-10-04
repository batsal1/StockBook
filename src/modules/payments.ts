import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { db } from '../db/index.js';
import { attachments, parties, payments } from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';
import { allow, audit, ctx, isoDate, parse, today } from '../lib/http.js';

const PaymentBody = z.object({
  kind: z.enum(['payment_in', 'payment_out', 'expense', 'income', 'deposit', 'withdraw']),
  amountPaise: z.number().int().positive(),
  mode: z.enum(['cash', 'upi', 'card', 'bank']).default('cash'),
  partyId: z.string().uuid().optional(),
  category: z.string().trim().max(60).optional(), // expense head: Rent, Salary, Electricity…
  taxPaise: z.number().int().min(0).default(0), // GST included in the amount (expenses)
  recurring: z.boolean().default(false),
  note: z.string().trim().max(500).optional(),
  date: isoDate.optional(),
  attachmentId: z.string().uuid().optional(),
});

const routes: FastifyPluginAsync = async (app) => {
  app.post('/', async (req, reply) => {
    const c = ctx(req);
    const b = parse(PaymentBody, req.body);
    if ((b.kind === 'payment_in' || b.kind === 'payment_out') && !b.partyId) throw badRequest('Choose who paid or who was paid');
    if (c.role === 'cashier' && b.kind !== 'payment_in') throw badRequest('Cashiers can record money received only');
    if (b.partyId) {
      const [p] = await db.select({ id: parties.id }).from(parties).where(and(eq(parties.id, b.partyId), eq(parties.shopId, c.shopId)));
      if (!p) throw badRequest('Unknown party');
    }
    if (b.attachmentId) {
      const [a] = await db.select({ id: attachments.id }).from(attachments).where(and(eq(attachments.id, b.attachmentId), eq(attachments.shopId, c.shopId)));
      if (!a) throw badRequest('Unknown attachment');
    }
    const [row] = await db.insert(payments).values({ ...b, date: b.date ?? today(), shopId: c.shopId, createdBy: c.userId }).returning();
    await audit(db, c, 'create', 'payment', row.id, { kind: row.kind, amount: row.amountPaise });
    return reply.status(201).send(row);
  });

  app.get('/', async (req) => {
    const c = ctx(req);
    const f = parse(z.object({
      kind: PaymentBody.shape.kind.optional(), partyId: z.string().uuid().optional(), from: isoDate.optional(), to: isoDate.optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }), req.query);
    return db.select().from(payments).where(and(
      eq(payments.shopId, c.shopId),
      f.kind ? eq(payments.kind, f.kind) : undefined, f.partyId ? eq(payments.partyId, f.partyId) : undefined,
      f.from ? gte(payments.date, f.from) : undefined, f.to ? lte(payments.date, f.to) : undefined,
    )).orderBy(desc(payments.date), desc(payments.createdAt)).limit(f.limit);
  });

  app.patch('/:id', { preHandler: allow('owner', 'manager') }, async (req) => {
    const c = ctx(req);
    const { id } = req.params as { id: string };
    const b = parse(PaymentBody.partial(), req.body);
    if (b.partyId) {
      const [p] = await db.select({ id: parties.id }).from(parties).where(and(eq(parties.id, b.partyId), eq(parties.shopId, c.shopId)));
      if (!p) throw badRequest('Unknown party');
    }
    const [row] = await db.update(payments).set(b).where(and(eq(payments.id, id), eq(payments.shopId, c.shopId))).returning();
    if (!row) throw notFound('Payment');
    await audit(db, c, 'update', 'payment', id, b);
    return row;
  });

  app.delete('/:id', { preHandler: allow('owner', 'manager') }, async (req) => {
    const c = ctx(req);
    const { id } = req.params as { id: string };
    const [row] = await db.delete(payments).where(and(eq(payments.id, id), eq(payments.shopId, c.shopId))).returning();
    if (!row) throw notFound('Payment');
    await audit(db, c, 'delete', 'payment', id, row);
    return { deleted: true };
  });
};

export default routes;
