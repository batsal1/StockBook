/**
 * Bill scanner.
 *   POST   /scans                 upload a bill photo/PDF (multipart "file"). Reads it with AI when available (?engine=ai|none).
 *   PUT    /scans/:id/data        save structured data from on-device OCR or after a person corrects it
 *   GET    /scans, /scans/:id     history and detail
 *   POST   /scans/:id/convert     turn the reviewed data into a purchase bill (stock in, supplier balance) or an expense
 *   DELETE /scans/:id             discard a scan that was not converted
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { attachments, billScans, parties, payments } from '../db/schema.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { allow, audit, ctx, parse, today } from '../lib/http.js';
import { ALLOWED_MIME, storage } from '../lib/storage.js';
import { aiEnabled, AI_IMAGE_MIMES, extractWithAI, matchItems, normalizeBill, type BillData } from '../lib/billdata.js';
import { toPaise } from '../lib/money.js';
import { createInvoice } from './invoices.js';

const Convert = z.object({
  as: z.enum(['purchase', 'expense']),
  partyId: z.string().uuid().optional(), // supplier; otherwise matched by GSTIN/name, or created when createSupplier is true
  createSupplier: z.boolean().default(true),
  payMode: z.enum(['cash', 'upi', 'card', 'bank', 'credit']).default('credit'),
  paidPaise: z.number().int().min(0).optional(),
  category: z.string().trim().max(60).optional(), // expense head
});

async function load(shopId: string, id: string) {
  const [s] = await db.select().from(billScans).where(and(eq(billScans.id, id), eq(billScans.shopId, shopId)));
  if (!s) throw notFound('Scan');
  return s;
}

const summary = (d: BillData | null | undefined) => d ? ({
  vendor: d.vendor?.name ?? null, billNo: d.billNo ?? null, date: d.date ?? null, total: d.total ?? null,
  itemCount: d.items?.length ?? 0, warningCount: d.warnings?.length ?? 0, kind: d.kind,
}) : null;

const routes: FastifyPluginAsync = async (app) => {
  app.post('/', async (req, reply) => {
    const c = ctx(req);
    const { engine } = parse(z.object({ engine: z.enum(['ai', 'none']).optional() }), req.query);
    const file = await req.file();
    if (!file) throw badRequest('Send the bill in a multipart field named "file"');
    const ext = ALLOWED_MIME[file.mimetype];
    if (!ext) throw badRequest('Upload a JPG, PNG or WEBP photo, or a PDF');
    const buf = await file.toBuffer();
    const key = await storage.put(c.shopId, ext, buf);
    const [att] = await db.insert(attachments).values({ shopId: c.shopId, filename: file.filename, mime: file.mimetype, sizeBytes: buf.length, storageKey: key, uploadedBy: c.userId }).returning();
    const [scan] = await db.insert(billScans).values({ shopId: c.shopId, attachmentId: att.id, createdBy: c.userId }).returning();

    const useAi = (engine ?? (aiEnabled() ? 'ai' : 'none')) === 'ai' && aiEnabled() && AI_IMAGE_MIMES.includes(file.mimetype);
    if (useAi) {
      const data = await extractWithAI(buf, file.mimetype);
      data.items = await matchItems(db, c.shopId, data.items);
      const [s] = await db.update(billScans).set({ data: data as unknown as Record<string, unknown>, engine: 'ai', status: 'extracted', updatedAt: new Date() }).where(eq(billScans.id, scan.id)).returning();
      return reply.status(201).send({ ...s, file: { id: att.id, filename: att.filename, mime: att.mime } });
    }
    return reply.status(201).send({
      ...scan, file: { id: att.id, filename: att.filename, mime: att.mime },
      next: aiEnabled() ? 'This file type needs on-device OCR or manual entry.' : 'AI reading is off: run on-device OCR in the app, then PUT /scans/:id/data.',
    });
  });

  app.put('/:id/data', async (req) => {
    const c = ctx(req);
    const { id } = req.params as { id: string };
    const b = parse(z.object({ data: z.record(z.string(), z.unknown()), engine: z.enum(['ocr', 'manual', 'ai']).default('manual'), rawText: z.string().max(100_000).optional() }), req.body);
    const s = await load(c.shopId, id);
    if (s.status === 'converted') throw conflict('This bill was already turned into an entry');
    const data = normalizeBill(b.data);
    data.items = await matchItems(db, c.shopId, data.items);
    const [row] = await db.update(billScans).set({
      data: data as unknown as Record<string, unknown>, engine: s.engine === 'ai' && b.engine === 'manual' ? 'ai' : b.engine,
      rawText: b.rawText ?? s.rawText, status: 'extracted', updatedAt: new Date(),
    }).where(eq(billScans.id, id)).returning();
    return row;
  });

  app.get('/', async (req) => {
    const c = ctx(req);
    const rows = await db.select({ s: billScans, filename: attachments.filename, mime: attachments.mime })
      .from(billScans).innerJoin(attachments, eq(attachments.id, billScans.attachmentId))
      .where(eq(billScans.shopId, c.shopId)).orderBy(desc(billScans.createdAt)).limit(200);
    return rows.map(({ s, filename, mime }) => ({
      id: s.id, status: s.status, engine: s.engine, createdAt: s.createdAt, invoiceId: s.invoiceId, paymentId: s.paymentId,
      file: { id: s.attachmentId, filename, mime }, summary: summary(s.data as unknown as BillData),
    }));
  });

  app.get('/:id', async (req) => {
    const c = ctx(req);
    const s = await load(c.shopId, (req.params as { id: string }).id);
    const [att] = await db.select().from(attachments).where(eq(attachments.id, s.attachmentId));
    return { ...s, file: { id: att.id, filename: att.filename, mime: att.mime } };
  });

  app.delete('/:id', { preHandler: allow('owner', 'manager') }, async (req) => {
    const c = ctx(req);
    const s = await load(c.shopId, (req.params as { id: string }).id);
    if (s.status === 'converted') throw conflict('Converted bills stay on record; cancel the purchase instead');
    await db.delete(billScans).where(eq(billScans.id, s.id));
    return { deleted: true };
  });

  app.post('/:id/convert', { preHandler: allow('owner', 'manager') }, async (req, reply) => {
    const c = ctx(req);
    const s = await load(c.shopId, (req.params as { id: string }).id);
    if (s.status === 'converted') throw conflict('This bill was already turned into an entry');
    if (!s.data) throw badRequest('Extract or enter the bill details first');
    const b = parse(Convert, req.body ?? {});
    const d = normalizeBill(s.data);

    if (b.as === 'expense') {
      const total = d.total ?? d.items.reduce((t, it) => t + (it.amount ?? it.qty * it.rate), 0);
      if (!(total > 0)) throw badRequest('The bill has no total to record');
      const [p] = await db.insert(payments).values({
        shopId: c.shopId, kind: 'expense', amountPaise: toPaise(total), taxPaise: toPaise(d.taxTotal ?? 0),
        mode: b.payMode === 'credit' ? 'cash' : b.payMode, category: b.category || d.category || 'Other',
        note: [d.vendor.name, d.billNo].filter(Boolean).join(' · ') || null, date: d.date ?? today(), attachmentId: s.attachmentId, createdBy: c.userId,
      }).returning();
      await db.update(billScans).set({ status: 'converted', paymentId: p.id, updatedAt: new Date() }).where(eq(billScans.id, s.id));
      await audit(db, c, 'convert_scan', 'payment', p.id, { scan: s.id });
      return reply.status(201).send({ converted: 'expense', payment: p });
    }

    if (!d.items.length) throw badRequest('Add at least one item line before creating the purchase');
    // supplier: chosen, else matched by GSTIN or name, else created from the bill
    let partyId = b.partyId;
    if (!partyId && d.vendor.gstin) {
      const [g] = await db.select({ id: parties.id }).from(parties).where(and(eq(parties.shopId, c.shopId), eq(parties.gstin, d.vendor.gstin)));
      partyId = g?.id;
    }
    if (!partyId && d.vendor.name) {
      const r = await db.execute(sql`select id from parties where shop_id = ${c.shopId} and type = 'supplier' and similarity(name, ${d.vendor.name}) > 0.5 order by similarity(name, ${d.vendor.name}) desc limit 1`);
      partyId = (r.rows[0] as { id: string } | undefined)?.id;
    }
    if (!partyId) {
      if (!b.createSupplier || !d.vendor.name) throw badRequest('Choose the supplier for this bill');
      const gstinOk = d.vendor.gstin && /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/.test(d.vendor.gstin);
      const [p] = await db.insert(parties).values({ shopId: c.shopId, type: 'supplier', name: d.vendor.name, gstin: gstinOk ? d.vendor.gstin : null, phone: d.vendor.phone ?? null, address: d.vendor.address ?? null }).returning();
      partyId = p.id;
    }

    const inv = await createInvoice(c, {
      type: 'purchase', partyId, number: d.billNo || undefined, date: d.date, dueDate: d.dueDate, attachmentId: s.attachmentId,
      payMode: b.payMode, paidPaise: b.payMode === 'credit' ? 0 : b.paidPaise, discountPaise: 0, allowOverLimit: false,
      notes: `From scanned bill${d.vendor.name ? ' · ' + d.vendor.name : ''}`,
      lines: d.items.map((it) => ({
        ...(it.productId ? { productId: it.productId } : { newProduct: { name: it.name, unit: it.unit || 'pcs', hsn: it.hsn } }),
        qty: it.qty > 0 ? it.qty : 1, ratePaise: toPaise(it.rate), discountBps: Math.round((it.discount ?? 0) * 100),
        gstBps: it.gstRate != null ? Math.round(it.gstRate * 100) : undefined, batchNo: it.batch || undefined, expiry: it.expiry || undefined,
      })),
    });
    await db.update(billScans).set({ status: 'converted', invoiceId: inv.id, updatedAt: new Date() }).where(eq(billScans.id, s.id));
    await audit(db, c, 'convert_scan', 'invoice', inv.id, { scan: s.id });
    const printed = d.total != null ? toPaise(d.total) : null;
    return reply.status(201).send({
      converted: 'purchase', invoice: inv,
      totalCheck: printed == null ? null : { printedPaise: printed, calculatedPaise: inv.totalPaise, differencePaise: inv.totalPaise - printed },
    });
  });
};

export default routes;
