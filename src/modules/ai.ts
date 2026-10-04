/**
 * AI helpers powered by Claude (needs ANTHROPIC_API_KEY).
 *  - POST /ai/read-bill            photo of a supplier bill → a draft purchase, matched to your catalog. Nothing is saved;
 *                                  the app shows the draft, the person checks it, then posts it to /invoices.
 *  - POST /ai/product-from-photo   photo of a product packet → product fields for the "add product" form.
 * Both accept multipart "file" (an image) or JSON {"attachmentId": "..."} for an already uploaded photo.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import Anthropic from '@anthropic-ai/sdk';
import { and, eq, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { attachments, parties, shops } from '../db/schema.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { ctx } from '../lib/http.js';
import { storage } from '../lib/storage.js';
import { toPaise } from '../lib/money.js';

type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
const IMAGE_MIMES: ImageMime[] = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const client = () => {
  if (!config.ANTHROPIC_API_KEY) throw new AppError(501, 'AI features are off. Set ANTHROPIC_API_KEY on the server to turn them on.', 'ai_disabled');
  return new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
};

async function imageFrom(req: FastifyRequest, shopId: string): Promise<{ data: string; mime: ImageMime }> {
  if (req.isMultipart()) {
    const f = await req.file();
    if (!f) throw badRequest('Send the photo in a multipart field named "file"');
    if (!IMAGE_MIMES.includes(f.mimetype as ImageMime)) throw badRequest('Send a JPG, PNG or WEBP photo');
    return { data: (await f.toBuffer()).toString('base64'), mime: f.mimetype as ImageMime };
  }
  const id = (req.body as { attachmentId?: string } | undefined)?.attachmentId;
  if (!id) throw badRequest('Send a photo, or the attachmentId of an uploaded photo');
  const [a] = await db.select().from(attachments).where(and(eq(attachments.id, id), eq(attachments.shopId, shopId)));
  if (!a) throw notFound('File');
  if (!IMAGE_MIMES.includes(a.mime as ImageMime)) throw badRequest('That file is not a photo. PDFs cannot be read yet.');
  return { data: (await storage.get(a.storageKey)).toString('base64'), mime: a.mime as ImageMime };
}

async function askJson<T>(prompt: string, image: { data: string; mime: ImageMime }): Promise<T> {
  const msg = await client().messages.create({
    model: config.ANTHROPIC_MODEL,
    max_tokens: 4000,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: image.mime, data: image.data } },
        { type: 'text', text: prompt + '\n\nRespond with only the JSON object: no markdown fences, no explanation.' },
      ],
    }],
  });
  const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('').replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as T;
  } catch {
    throw new AppError(502, 'Could not read the photo clearly. Try a sharper, well-lit photo.', 'ai_unreadable');
  }
}

interface BillRead {
  supplier?: string; gstin?: string; billNo?: string; date?: string; total?: number | null;
  items: { name: string; qty: number; rate: number; gst?: number | null; hsn?: string; batch?: string; expiry?: string }[];
}

const routes: FastifyPluginAsync = async (app) => {
  app.post('/read-bill', async (req) => {
    const c = ctx(req);
    const image = await imageFrom(req, c.shopId);
    const r = await askJson<BillRead>(`This is a photo of a supplier bill / tax invoice received by a shop in India.
Extract: {"supplier": string, "gstin": string, "billNo": string, "date": "YYYY-MM-DD" or "", "total": number or null,
"items": [{"name": string, "qty": number, "rate": number (per-unit rate BEFORE GST as printed in the rate column), "gst": number (GST percent) or null, "hsn": string, "batch": string, "expiry": "YYYY-MM-DD" or ""}]}.
Copy item names exactly as printed. Skip rows you cannot read rather than guessing. Do not include totals or tax rows as items.`, image);

    // match supplier by GSTIN, then by name similarity
    let supplier = null as null | { id: string; name: string };
    if (r.gstin) [supplier] = await db.select({ id: parties.id, name: parties.name }).from(parties).where(and(eq(parties.shopId, c.shopId), eq(parties.gstin, r.gstin.toUpperCase())));
    if (!supplier && r.supplier) {
      const res = await db.execute(sql`select id, name from parties where shop_id = ${c.shopId} and type = 'supplier' and similarity(name, ${r.supplier}) > 0.4 order by similarity(name, ${r.supplier}) desc limit 1`);
      supplier = (res.rows[0] as unknown as { id: string; name: string } | undefined) ?? null;
    }

    // match each line to the catalog by name similarity
    const lines = [];
    for (const it of r.items ?? []) {
      const res = await db.execute(sql`
        select id, name, gst_bps as "gstBps", similarity(name, ${it.name}) as score from products
        where shop_id = ${c.shopId} and is_active and similarity(name, ${it.name}) > 0.35 order by score desc limit 1`);
      const m = res.rows[0] as { id: string; name: string; gstBps: number; score: number } | undefined;
      const gstBps = it.gst != null ? Math.round(it.gst * 100) : m?.gstBps ?? 0;
      lines.push({
        ...(m ? { productId: m.id, matchedName: m.name, matchScore: Math.round(m.score * 100) / 100 } : { newProduct: { name: it.name, hsn: it.hsn || undefined } }),
        printedName: it.name, qty: it.qty, ratePaise: toPaise(it.rate), gstBps,
        batchNo: it.batch || undefined, expiry: /^\d{4}-\d{2}-\d{2}$/.test(it.expiry ?? '') ? it.expiry : undefined,
      });
    }
    return {
      note: 'Draft only. Check quantities and rates, then POST it to /invoices with type "purchase".',
      supplierRead: { name: r.supplier, gstin: r.gstin }, supplierMatch: supplier,
      draft: { type: 'purchase', number: r.billNo || undefined, date: /^\d{4}-\d{2}-\d{2}$/.test(r.date ?? '') ? r.date : undefined, partyId: supplier?.id, lines },
      printedTotalPaise: r.total != null ? toPaise(r.total) : null,
    };
  });

  app.post('/product-from-photo', async (req) => {
    const c = ctx(req);
    const image = await imageFrom(req, c.shopId);
    const [shop] = await db.select({ shopType: shops.shopType }).from(shops).where(eq(shops.id, c.shopId));
    const r = await askJson<Record<string, unknown>>(`This photo shows a product package in a ${shop.shopType} shop in India. Read the printed text exactly.
Return {"name": string (include net quantity), "brand": string, "category": string, "unit": one of pcs|kg|g|L|ml|pack|box|dozen|pair|m,
"size": string, "barcode": string (digits only if visible), "mrp": number or null (only if printed), "hsn": string (only if reasonably known),
"gst": number or null (Indian GST % if reasonably known), "expiry": "YYYY-MM-DD" or "", "batch": string, "confidence": "high"|"medium"|"low", "note": string}.`, image);
    return {
      ...r,
      mrpPaise: typeof r.mrp === 'number' ? toPaise(r.mrp) : null,
      gstBps: typeof r.gst === 'number' ? Math.round(r.gst * 100) : null,
      note: `${r.note ?? ''} Check the details before saving.`.trim(),
    };
  });
};

export default routes;
