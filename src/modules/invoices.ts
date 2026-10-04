import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { db, type Tx } from '../db/index.js';
import { attachments, invoiceLines, invoices, parties, products, sequences, shops, stockLevels } from '../db/schema.js';
import { partyBalances } from '../lib/ledger.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { allow, audit, ctx, defaultBranchId, isoDate, paise, parse, today, type Ctx } from '../lib/http.js';
import { calcBill, formatINR, STOCK_SIGN, type InvoiceType } from '../lib/money.js';

const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
import { applyStock, reverseInvoiceStock } from '../lib/stock.js';

const Line = z.object({
  productId: z.string().uuid().optional(),
  // a purchase may bring a product that is not in the catalog yet: it is created on save
  newProduct: z.object({ name: z.string().trim().min(1), barcode: z.string().trim().optional(), unit: z.string().default('pcs'), hsn: z.string().optional() }).optional(),
  qty: z.number().positive(),
  ratePaise: paise,
  discountBps: z.number().int().min(0).max(10_000).default(0),
  gstBps: z.number().int().min(0).max(10_000).optional(), // defaults to the product's rate
  batchNo: z.string().trim().optional(),
  expiry: isoDate.optional(),
}).refine((l) => l.productId || l.newProduct, 'each line needs productId or newProduct');

export const CreateInvoice = z.object({
  clientRef: z.string().trim().min(6).max(80).optional(), // offline apps: a UUID made on the device
  type: z.enum(['sale', 'purchase', 'sale_return', 'purchase_return']),
  date: isoDate.optional(),
  dueDate: isoDate.optional(), // defaults to date + the party's (or shop's) payment terms when money is left unpaid
  allowOverLimit: z.boolean().default(false), // owner/manager may go past a customer's credit limit
  number: z.string().trim().max(40).optional(), // supplier's bill no. for purchases; auto for the rest
  partyId: z.string().uuid().optional(),
  branchId: z.string().uuid().optional(),
  lines: z.array(Line).min(1).max(500),
  discountPaise: paise.default(0),
  paidPaise: paise.optional(), // empty = paid in full (unless payMode is credit)
  payMode: z.enum(['cash', 'upi', 'card', 'bank', 'credit']).default('cash'),
  notes: z.string().max(1000).optional(),
  attachmentId: z.string().uuid().optional(),
});
const ListQuery = z.object({
  type: z.enum(['sale', 'purchase', 'sale_return', 'purchase_return']).optional(),
  partyId: z.string().uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  status: z.enum(['active', 'cancelled']).optional(),
  payment: z.enum(['paid', 'partial', 'unpaid']).optional(),
  q: z.string().trim().max(80).optional(), // bill number or party name
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const PREFIX: Record<InvoiceType, string> = { sale: 'S', purchase: 'P', sale_return: 'SR', purchase_return: 'PR' };

async function nextNumber(tx: Tx, shopId: string, type: InvoiceType, date: string, prefix?: string | null): Promise<string> {
  if (type === 'sale' && prefix) {
    // custom series from Settings, e.g. INV-2026-1049
    const [row] = await tx.insert(sequences).values({ shopId, key: 'sale:prefix', next: 2 })
      .onConflictDoUpdate({ target: [sequences.shopId, sequences.key], set: { next: sql`${sequences.next} + 1` } })
      .returning({ next: sequences.next });
    return `${prefix}${row.next - 1}`;
  }
  // Indian financial year runs April–March: numbering restarts each year, e.g. S/2026-27/0001
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7));
  const fy = m >= 4 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
  const key = `${type}:${fy}`;
  const [row] = await tx.insert(sequences).values({ shopId, key, next: 2 })
    .onConflictDoUpdate({ target: [sequences.shopId, sequences.key], set: { next: sql`${sequences.next} + 1` } })
    .returning({ next: sequences.next });
  return `${PREFIX[type]}/${fy}/${String(row.next - 1).padStart(4, '0')}`;
}

export async function getInvoice(tx: Tx, shopId: string, id: string) {
  const [inv] = await tx.select().from(invoices).where(and(eq(invoices.id, id), eq(invoices.shopId, shopId)));
  if (!inv) throw notFound('Bill');
  const lines = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, id));
  const [party] = inv.partyId ? await tx.select().from(parties).where(eq(parties.id, inv.partyId)) : [null];
  return { ...inv, lines, party };
}

/** Saves a bill and everything it changes — stock, batches, costs — in one transaction. */
/** Saves a new bill, or (with editId) rewrites an existing one in place: same id, stock re-applied, balances follow. */
export async function createInvoice(c: Ctx, input: z.infer<typeof CreateInvoice>, editId?: string) {
  return db.transaction(async (tx) => {
    let existing: typeof invoices.$inferSelect | undefined;
    if (editId) {
      [existing] = await tx.select().from(invoices).where(and(eq(invoices.id, editId), eq(invoices.shopId, c.shopId))).for('update');
      if (!existing) throw notFound('Bill');
      if (existing.status === 'cancelled') throw conflict('A cancelled bill cannot be edited');
      if (existing.type !== input.type) throw badRequest('The bill type cannot be changed. Cancel it and make a new one instead.');
      await reverseInvoiceStock(tx, c.shopId, editId, c.userId, 'Bill edited');
      await tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, editId));
    }
    if (input.clientRef && !editId) {
      const [dup] = await tx.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.shopId, c.shopId), eq(invoices.clientRef, input.clientRef)));
      if (dup) return { ...(await getInvoice(tx, c.shopId, dup.id)), duplicate: true };
    }
    const [shop] = await tx.select().from(shops).where(eq(shops.id, c.shopId));
    const isBuy = input.type === 'purchase' || input.type === 'purchase_return';
    const date = input.date ?? today();
    const branchId = await defaultBranchId(tx, c.shopId, input.branchId);

    let party: typeof parties.$inferSelect | undefined;
    if (input.partyId) {
      [party] = await tx.select().from(parties).where(and(eq(parties.id, input.partyId), eq(parties.shopId, c.shopId)));
      if (!party) throw badRequest('Unknown party');
    }
    if (isBuy && !party) throw badRequest('Choose the supplier for this purchase');

    // resolve products (and create new ones that arrive on a purchase)
    const ids = input.lines.map((l) => l.productId).filter((x): x is string => !!x);
    const found = ids.length ? await tx.select().from(products).where(and(eq(products.shopId, c.shopId), inArray(products.id, ids))) : [];
    const byId = new Map(found.map((p) => [p.id, p]));
    const resolved: (typeof products.$inferSelect)[] = [];
    for (const l of input.lines) {
      if (l.productId) {
        const p = byId.get(l.productId);
        if (!p) throw badRequest(`Unknown product ${l.productId}`);
        resolved.push(p);
      } else {
        if (!isBuy) throw badRequest(`"${l.newProduct!.name}" is not in the catalog. Add it first, or record it on a purchase.`);
        const [p] = await tx.insert(products).values({
          shopId: c.shopId, name: l.newProduct!.name, barcode: l.newProduct!.barcode || null, unit: l.newProduct!.unit, hsn: l.newProduct!.hsn || null,
          gstBps: l.gstBps ?? 0, costPaise: l.ratePaise, trackBatches: !!l.batchNo,
        }).returning();
        resolved.push(p);
      }
    }

    const lineInputs = input.lines.map((l, i) => ({ qty: l.qty, ratePaise: l.ratePaise, discountBps: l.discountBps, gstBps: l.gstBps ?? resolved[i].gstBps }));
    // purchases are usually billed with GST on top; sales follow the shop setting
    const taxInclusive = isBuy ? false : shop.taxInclusive;
    const bill = calcBill(lineInputs, { taxInclusive, discountPaise: input.discountPaise, roundToRupee: shop.roundToRupee });

    const paid = input.payMode === 'credit' ? 0 : Math.min(input.paidPaise ?? bill.totalPaise, bill.totalPaise);
    if (paid < bill.totalPaise && !party) throw badRequest('A walk-in customer must pay in full. Choose a customer to give credit.');

    // credit limit: the unpaid part must fit within what the customer is allowed to owe
    if (input.type === 'sale' && party?.creditLimitPaise != null && paid < bill.totalPaise && !(input.allowOverLimit && c.role !== 'cashier')) {
      let owed = (await partyBalances(tx, c.shopId, party.id)).get(party.id) ?? 0;
      if (existing?.partyId === party.id) owed -= existing.totalPaise - existing.paidPaise; // the old version of this bill
      const after = owed + bill.totalPaise - paid;
      if (after > party.creditLimitPaise) {
        throw badRequest(`${party.name} would owe ${formatINR(after)}, above their credit limit of ${formatINR(party.creditLimitPaise)}. Take more payment now, or an owner can allow it.`);
      }
    }

    // negative stock, when the shop has turned it off
    if (!shop.allowNegativeStock && STOCK_SIGN[input.type] < 0) {
      const need = new Map<string, number>();
      input.lines.forEach((l, i) => need.set(resolved[i].id, (need.get(resolved[i].id) ?? 0) + l.qty));
      const lv = await tx.select().from(stockLevels).where(and(eq(stockLevels.branchId, branchId), inArray(stockLevels.productId, [...need.keys()])));
      for (const [pid, q] of need) {
        const have = lv.find((x) => x.productId === pid)?.qty ?? 0;
        if (q > have) throw badRequest(`Only ${have} of "${resolved.find((p) => p.id === pid)!.name}" in stock`);
      }
    }

    const terms = party?.paymentTermsDays ?? (input.type === 'sale' ? shop.paymentTermsDays : 0);
    const dueDate = input.dueDate ?? (paid < bill.totalPaise ? addDays(date, terms) : null);

    if (input.attachmentId) {
      const [a] = await tx.select({ id: attachments.id }).from(attachments).where(and(eq(attachments.id, input.attachmentId), eq(attachments.shopId, c.shopId)));
      if (!a) throw badRequest('Unknown attachment');
    }

    const number = input.number || existing?.number || (await nextNumber(tx, c.shopId, input.type, date, shop.invoicePrefix));
    const values = {
      shopId: c.shopId, branchId, type: input.type, number, date, dueDate, partyId: party?.id ?? null, clientRef: existing ? existing.clientRef : input.clientRef ?? null,
      taxInclusive, taxablePaise: bill.taxablePaise, taxPaise: bill.taxPaise, discountPaise: bill.discountPaise, roundOffPaise: bill.roundOffPaise,
      totalPaise: bill.totalPaise, paidPaise: paid, payMode: input.payMode, notes: input.notes ?? null,
      attachmentId: input.attachmentId ?? existing?.attachmentId ?? null, createdBy: existing?.createdBy ?? c.userId,
    };
    const [inv] = existing
      ? await tx.update(invoices).set(values).where(eq(invoices.id, existing.id)).returning()
      : await tx.insert(invoices).values(values).returning();

    const sign = STOCK_SIGN[input.type];
    for (let i = 0; i < input.lines.length; i++) {
      const l = input.lines[i], p = resolved[i], calc = bill.lines[i];
      const unitCost = isBuy ? Math.round(calc.taxablePaise / l.qty) : p.costPaise; // purchase cost ex-GST
      const touched = await applyStock(tx, {
        shopId: c.shopId, branchId, productId: p.id, qtyChange: sign * l.qty, reason: input.type, trackBatches: p.trackBatches,
        invoiceId: inv.id, userId: c.userId, batchNo: l.batchNo, expiry: l.expiry, unitCostPaise: unitCost,
      });
      await tx.insert(invoiceLines).values({
        invoiceId: inv.id, productId: p.id, name: p.name, hsn: p.hsn, qty: l.qty, ratePaise: l.ratePaise, discountBps: l.discountBps,
        gstBps: lineInputs[i].gstBps, taxablePaise: calc.taxablePaise, taxPaise: calc.taxPaise, totalPaise: calc.totalPaise, unitCostPaise: unitCost,
        batchNo: l.batchNo ?? touched[0]?.batchNo ?? null, expiry: l.expiry ?? touched[0]?.expiry ?? null,
      });
      if (input.type === 'purchase') {
        let newCost = unitCost;
        if (shop.costMethod === 'average') {
          // weighted average: blend the stock already held (before this purchase) with the new stock
          const [lv] = await tx.select({ qty: sql<number>`coalesce(sum(${stockLevels.qty}), 0)` }).from(stockLevels).where(eq(stockLevels.productId, p.id));
          const before = Math.max(0, Number(lv?.qty ?? 0) - l.qty);
          newCost = before + l.qty > 0 ? Math.round((before * p.costPaise + l.qty * unitCost) / (before + l.qty)) : unitCost;
        }
        await tx.update(products).set({ costPaise: newCost, updatedAt: new Date() }).where(eq(products.id, p.id));
        p.costPaise = newCost;
      }
    }
    await audit(tx, c, existing ? 'edit' : 'create', 'invoice', inv.id, { type: inv.type, number: inv.number, total: inv.totalPaise, ...(existing ? { previousTotal: existing.totalPaise } : {}) });
    return getInvoice(tx, c.shopId, inv.id);
  });
}

const routes: FastifyPluginAsync = async (app) => {
  app.post('/', async (req, reply) => {
    const c = ctx(req);
    const input = parse(CreateInvoice, req.body);
    if (c.role === 'cashier' && input.type !== 'sale' && input.type !== 'sale_return') throw badRequest('Cashiers can record sales and sale returns only');
    const out = await createInvoice(c, input);
    return reply.status('duplicate' in out ? 200 : 201).send(out);
  });

  /** Offline sync: the app uploads bills made without internet; each has a clientRef so retries are safe. */
  app.post('/sync', async (req) => {
    const c = ctx(req);
    const { bills } = parse(z.object({ bills: z.array(z.unknown()).min(1).max(200) }), req.body);
    const results = [];
    for (const raw of bills) {
      try {
        const input = parse(CreateInvoice.refine((b) => !!b.clientRef, 'clientRef is required for sync'), raw);
        const inv = await createInvoice(c, input);
        results.push({ clientRef: input.clientRef, ok: true, id: inv.id, number: inv.number });
      } catch (e) {
        results.push({ clientRef: (raw as { clientRef?: string })?.clientRef ?? null, ok: false, error: (e as Error).message });
      }
    }
    return { results };
  });

  app.get('/', async (req) => {
    const c = ctx(req);
    const f = parse(ListQuery, req.query);
    const where: SQL[] = [eq(invoices.shopId, c.shopId)];
    if (f.type) where.push(eq(invoices.type, f.type));
    if (f.partyId) where.push(eq(invoices.partyId, f.partyId));
    if (f.from) where.push(gte(invoices.date, f.from));
    if (f.to) where.push(lte(invoices.date, f.to));
    if (f.status) where.push(eq(invoices.status, f.status));
    if (f.payment === 'paid') where.push(sql`${invoices.paidPaise} >= ${invoices.totalPaise}`);
    if (f.payment === 'partial') where.push(sql`${invoices.paidPaise} > 0 and ${invoices.paidPaise} < ${invoices.totalPaise}`);
    if (f.payment === 'unpaid') where.push(sql`${invoices.paidPaise} = 0 and ${invoices.totalPaise} > 0`);
    if (f.q) where.push(sql`(${invoices.number} ilike ${'%' + f.q + '%'} or ${parties.name} ilike ${'%' + f.q + '%'})`);
    const rows = await db.select({
      id: invoices.id, type: invoices.type, number: invoices.number, date: invoices.date, dueDate: invoices.dueDate, partyId: invoices.partyId, partyName: parties.name,
      totalPaise: invoices.totalPaise, paidPaise: invoices.paidPaise, payMode: invoices.payMode, status: invoices.status, attachmentId: invoices.attachmentId,
      lineCount: sql<number>`(select count(*)::int from invoice_lines l where l.invoice_id = ${invoices.id})`,
    }).from(invoices).leftJoin(parties, eq(parties.id, invoices.partyId)).where(and(...where))
      .orderBy(desc(invoices.date), desc(invoices.createdAt)).limit(f.limit).offset(f.offset);
    return rows;
  });

  app.get('/:id', async (req) => getInvoice(db, ctx(req).shopId, (req.params as { id: string }).id));

  /** Edit a bill: send the full bill again (same shape as creating one). Stock and balances are recalculated. */
  app.put('/:id', { preHandler: allow('owner', 'manager') }, async (req) => {
    const input = parse(CreateInvoice, req.body);
    return createInvoice(ctx(req), input, (req.params as { id: string }).id);
  });

  /** Bills are cancelled, never deleted: stock is put back and the bill stays on record. */
  app.post('/:id/cancel', { preHandler: allow('owner', 'manager') }, async (req) => {
    const c = ctx(req);
    const { id } = req.params as { id: string };
    const { reason } = parse(z.object({ reason: z.string().trim().min(1).max(300) }), req.body);
    return db.transaction(async (tx) => {
      const [inv] = await tx.select().from(invoices).where(and(eq(invoices.id, id), eq(invoices.shopId, c.shopId))).for('update');
      if (!inv) throw notFound('Bill');
      if (inv.status === 'cancelled') throw conflict('This bill is already cancelled');
      await reverseInvoiceStock(tx, c.shopId, id, c.userId);
      await tx.update(invoices).set({ status: 'cancelled', notes: sql`concat_ws(' · ', ${invoices.notes}, ${'Cancelled: ' + reason}::text)` }).where(eq(invoices.id, id));
      await audit(tx, c, 'cancel', 'invoice', id, { reason });
      return getInvoice(tx, c.shopId, id);
    });
  });
};

export default routes;
