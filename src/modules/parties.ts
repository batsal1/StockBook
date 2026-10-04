import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { invoices, parties, payments, shops } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { allow, audit, ctx, parse } from '../lib/http.js';
import { partyBalances } from '../lib/ledger.js';
import { formatINR } from '../lib/money.js';

const gstin = z.string().trim().toUpperCase()
  .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/, 'is not a valid GSTIN').nullish().or(z.literal('').transform(() => null));

const PartyBody = z.object({
  type: z.enum(['supplier', 'wholesale', 'retail']),
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().max(20).nullish(),
  gstin,
  address: z.string().trim().max(500).nullish(),
  openingBalancePaise: z.number().int().default(0),
  email: z.string().trim().email().nullish().or(z.literal('').transform(() => null)),
  creditLimitPaise: z.number().int().min(0).nullish(),
  paymentTermsDays: z.number().int().min(0).max(365).nullish(),
});

const routes: FastifyPluginAsync = async (app) => {
  app.get('/', async (req) => {
    const c = ctx(req);
    const { type, q } = parse(z.object({ type: z.enum(['supplier', 'wholesale', 'retail']).optional(), q: z.string().trim().optional() }), req.query);
    const rows = await db.select().from(parties).where(and(
      eq(parties.shopId, c.shopId), eq(parties.isActive, true),
      type ? eq(parties.type, type) : undefined,
      q ? sql`(${parties.name} ilike ${'%' + q + '%'} or ${parties.phone} like ${'%' + q + '%'} or similarity(${parties.name}, ${q}) > 0.3)` : undefined,
    )).orderBy(asc(parties.name));
    const bal = await partyBalances(db, c.shopId);
    const stats = await db.execute(sql`
      select party_id as id,
        coalesce(sum(case type when 'sale' then total_paise when 'sale_return' then -total_paise else 0 end), 0) as sales,
        coalesce(sum(case type when 'purchase' then total_paise when 'purchase_return' then -total_paise else 0 end), 0) as purchases,
        max(date) as last,
        coalesce(sum(case when due_date < current_date and total_paise > paid_paise then total_paise - paid_paise else 0 end), 0) as overdue
      from invoices where shop_id = ${c.shopId} and status = 'active' and party_id is not null group by party_id`);
    const st = new Map((stats.rows as { id: string; sales: number; purchases: number; last: string; overdue: number }[]).map((r) => [r.id, r]));
    return rows.map((p) => {
      const s = st.get(p.id);
      return { ...p, balancePaise: bal.get(p.id) ?? 0, totalSalesPaise: Number(s?.sales ?? 0), totalPurchasesPaise: Number(s?.purchases ?? 0), lastTransaction: s?.last ?? null };
    });
  });

  app.get('/:id', async (req) => {
    const c = ctx(req);
    const { id } = req.params as { id: string };
    const [p] = await db.select().from(parties).where(and(eq(parties.id, id), eq(parties.shopId, c.shopId)));
    if (!p) throw notFound('Party');
    return { ...p, balancePaise: (await partyBalances(db, c.shopId, id)).get(id) ?? 0 };
  });

  /** Ledger statement with running balance, plus a ready WhatsApp reminder link when money is due. */
  app.get('/:id/statement', async (req) => {
    const c = ctx(req);
    const { id } = req.params as { id: string };
    const [p] = await db.select().from(parties).where(and(eq(parties.id, id), eq(parties.shopId, c.shopId)));
    if (!p) throw notFound('Party');
    const [shop] = await db.select({ name: shops.name }).from(shops).where(eq(shops.id, c.shopId));
    const bills = await db.select().from(invoices).where(and(eq(invoices.partyId, id), eq(invoices.status, 'active')));
    const pays = await db.select().from(payments).where(eq(payments.partyId, id));
    const entries = [
      ...bills.map((b) => ({
        date: b.date, at: b.createdAt, kind: b.type, ref: b.number, totalPaise: b.totalPaise, paidPaise: b.paidPaise,
        effectPaise: (b.type === 'sale' || b.type === 'purchase_return' ? 1 : -1) * (b.totalPaise - b.paidPaise), id: b.id,
      })),
      ...pays.filter((x) => x.kind === 'payment_in' || x.kind === 'payment_out').map((x) => ({
        date: x.date, at: x.createdAt, kind: x.kind, ref: x.note ?? x.mode, totalPaise: x.amountPaise, paidPaise: x.amountPaise,
        effectPaise: x.kind === 'payment_out' ? x.amountPaise : -x.amountPaise, id: x.id,
      })),
    ].sort((a, b) => a.date.localeCompare(b.date) || +a.at - +b.at);
    let running = p.openingBalancePaise;
    const rows = entries.map((e) => ({ ...e, balancePaise: (running += e.effectPaise) }));
    const phone = (p.phone ?? '').replace(/\D/g, '');
    const waPhone = phone.length === 10 ? '91' + phone : phone;
    const reminder = running > 0 && waPhone
      ? `https://wa.me/${waPhone}?text=${encodeURIComponent(`Namaste ${p.name}, your pending balance with ${shop.name} is ${formatINR(running)}. Thank you.`)}`
      : null;
    return { party: p, openingBalancePaise: p.openingBalancePaise, entries: rows, balancePaise: running, whatsappReminder: reminder };
  });

  app.post('/', { preHandler: allow('owner', 'manager', 'cashier') }, async (req, reply) => {
    const c = ctx(req);
    const b = parse(PartyBody, req.body);
    const [p] = await db.insert(parties).values({ ...b, shopId: c.shopId }).returning();
    await audit(db, c, 'create', 'party', p.id, { name: p.name });
    return reply.status(201).send(p);
  });

  app.patch('/:id', { preHandler: allow('owner', 'manager') }, async (req) => {
    const c = ctx(req);
    const { id } = req.params as { id: string };
    const b = parse(PartyBody.partial(), req.body);
    const [p] = await db.update(parties).set(b).where(and(eq(parties.id, id), eq(parties.shopId, c.shopId))).returning();
    if (!p) throw notFound('Party');
    await audit(db, c, 'update', 'party', id, b);
    return p;
  });

  app.delete('/:id', { preHandler: allow('owner') }, async (req) => {
    const c = ctx(req);
    const { id } = req.params as { id: string };
    const [p] = await db.update(parties).set({ isActive: false }).where(and(eq(parties.id, id), eq(parties.shopId, c.shopId))).returning({ id: parties.id });
    if (!p) throw notFound('Party');
    return { archived: true };
  });
};

export default routes;
