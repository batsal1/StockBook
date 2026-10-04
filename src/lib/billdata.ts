/**
 * Bill photo → structured data.
 *
 * The structured form (BillData) is the same whichever engine produced it:
 *   - "ai":  Claude reads the photo on the server (needs ANTHROPIC_API_KEY) — best accuracy, handles messy layouts
 *   - "ocr": the browser runs free on-device OCR (Tesseract) and a rule-based parser — no key, rougher results
 *   - "manual": typed in by a person
 * Amounts in BillData are rupees (as printed), not paise, because people review and edit it.
 */
import Anthropic from '@anthropic-ai/sdk';
import { sql } from 'drizzle-orm';
import { config } from '../config.js';
import { AppError } from './errors.js';
import type { Tx } from '../db/index.js';

export interface BillItem {
  name: string;
  hsn?: string;
  qty: number;
  unit?: string;
  rate: number; // per unit, before GST
  gstRate?: number | null; // percent
  discount?: number; // percent
  amount?: number | null; // line amount as printed
  batch?: string;
  expiry?: string;
  productId?: string | null;
  matchedName?: string | null;
  matchScore?: number | null;
}

export interface BillData {
  kind: 'purchase' | 'expense';
  vendor: { name?: string; gstin?: string; phone?: string; address?: string };
  billNo?: string;
  date?: string;
  dueDate?: string;
  items: BillItem[];
  subtotal?: number | null;
  taxTotal?: number | null;
  cgst?: number | null;
  sgst?: number | null;
  igst?: number | null;
  roundOff?: number | null;
  total?: number | null;
  paymentMode?: string;
  category?: string; // for expense bills: Electricity, Rent, Internet…
  confidence?: 'high' | 'medium' | 'low';
  warnings?: string[];
  unparsedLines?: string[]; // table lines the OCR saw but could not turn into items; shown for one-click adding
}

type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
export const AI_IMAGE_MIMES: string[] = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
export const aiEnabled = () => !!config.ANTHROPIC_API_KEY;

const BILL_PROMPT = `This is a photo or scan of a bill received by a shop in India: usually a supplier's tax invoice for goods,
sometimes an expense bill (electricity, rent, internet, transport, repairs).
Return ONLY a JSON object:
{"kind": "purchase" | "expense",
 "vendor": {"name": string, "gstin": string, "phone": string, "address": string},
 "billNo": string, "date": "YYYY-MM-DD" or "", "dueDate": "YYYY-MM-DD" or "",
 "items": [{"name": string, "hsn": string, "qty": number, "unit": string, "rate": number (per unit BEFORE GST), "gstRate": number or null,
            "discount": number (percent, 0 if none), "amount": number (line amount as printed), "batch": string, "expiry": "YYYY-MM-DD" or ""}],
 "subtotal": number or null (taxable value), "taxTotal": number or null, "cgst": number or null, "sgst": number or null, "igst": number or null,
 "roundOff": number or null, "total": number or null (grand total payable), "paymentMode": "cash" | "upi" | "card" | "bank" | "credit" | "",
 "category": string (for expense bills only), "confidence": "high" | "medium" | "low", "warnings": [string]}
Rules: copy names and numbers exactly as printed; dates in India are day-first (03/10/26 is 3 October 2026);
do not include tax, total or round-off rows as items; skip rows you cannot read and say so in warnings rather than guessing.
For an expense bill with no item table, return one item describing the service with qty 1.`;

export async function extractWithAI(image: Buffer, mime: string): Promise<BillData> {
  if (!aiEnabled()) throw new AppError(501, 'AI reading is off. Set ANTHROPIC_API_KEY on the server, or use on-device OCR.', 'ai_disabled');
  if (!AI_IMAGE_MIMES.includes(mime)) throw new AppError(400, 'AI reading needs a JPG, PNG or WEBP photo. For PDFs, take a photo or screenshot of the bill.', 'bad_request');
  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: config.ANTHROPIC_MODEL,
    max_tokens: 6000,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mime as ImageMime, data: image.toString('base64') } },
        { type: 'text', text: BILL_PROMPT + '\nRespond with only the JSON object: no markdown fences, no explanation.' },
      ],
    }],
  });
  const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('').replace(/```json|```/g, '').trim();
  try {
    return normalizeBill(JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)));
  } catch {
    throw new AppError(502, 'Could not read the bill clearly. Try a sharper, well-lit, straight photo.', 'ai_unreadable');
  }
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const isoOrEmpty = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);

/** Cleans whatever an engine or a person produced into a consistent BillData. */
export function normalizeBill(raw: any): BillData {
  const items: BillItem[] = (Array.isArray(raw?.items) ? raw.items : [])
    .map((it: any) => ({
      name: String(it?.name ?? '').trim(),
      hsn: it?.hsn ? String(it.hsn).trim() : undefined,
      qty: num(it?.qty) ?? 1,
      unit: it?.unit ? String(it.unit) : undefined,
      rate: num(it?.rate) ?? 0,
      gstRate: num(it?.gstRate),
      discount: num(it?.discount) ?? 0,
      amount: num(it?.amount),
      batch: it?.batch ? String(it.batch) : undefined,
      expiry: isoOrEmpty(it?.expiry),
      productId: it?.productId ?? null,
      matchedName: it?.matchedName ?? null,
      matchScore: num(it?.matchScore),
    }))
    .filter((it: BillItem) => it.name);
  const data: BillData = {
    kind: raw?.kind === 'expense' ? 'expense' : 'purchase',
    vendor: {
      name: raw?.vendor?.name?.trim() || undefined, gstin: raw?.vendor?.gstin?.toUpperCase().replace(/\s/g, '') || undefined,
      phone: raw?.vendor?.phone || undefined, address: raw?.vendor?.address || undefined,
    },
    billNo: raw?.billNo ? String(raw.billNo).trim() : undefined,
    date: isoOrEmpty(raw?.date), dueDate: isoOrEmpty(raw?.dueDate),
    items,
    subtotal: num(raw?.subtotal), taxTotal: num(raw?.taxTotal), cgst: num(raw?.cgst), sgst: num(raw?.sgst), igst: num(raw?.igst),
    roundOff: num(raw?.roundOff), total: num(raw?.total),
    paymentMode: ['cash', 'upi', 'card', 'bank', 'credit'].includes(raw?.paymentMode) ? raw.paymentMode : undefined,
    category: raw?.category || undefined,
    confidence: ['high', 'medium', 'low'].includes(raw?.confidence) ? raw.confidence : undefined,
    warnings: Array.isArray(raw?.warnings) ? raw.warnings.map(String) : [],
    unparsedLines: Array.isArray(raw?.unparsedLines) ? raw.unparsedLines.map(String).slice(0, 50) : [],
  };
  data.warnings = [...new Set([...(data.warnings ?? []).filter((w) => !w.startsWith('Check:')), ...checkBill(data)])];
  return data;
}

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;
const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1.5, Math.abs(b) * 0.01);

/** Arithmetic cross-checks so a misread digit is caught before it reaches the books. */
export function checkBill(d: BillData): string[] {
  const w: string[] = [];
  if (d.vendor.gstin && !GSTIN_RE.test(d.vendor.gstin)) w.push(`Check: GSTIN "${d.vendor.gstin}" does not look valid`);
  if (!d.items.length) w.push('Check: no item lines were found');
  d.items.forEach((it, i) => {
    const base = it.qty * it.rate * (1 - (it.discount ?? 0) / 100);
    if (it.amount != null && !near(base, it.amount) && !near(base * (1 + (it.gstRate ?? 0) / 100), it.amount)) {
      w.push(`Check: line ${i + 1} (${it.name}): ${it.qty} × ${it.rate} does not match the amount ${it.amount}`);
    }
  });
  const taxable = d.items.reduce((s, it) => s + it.qty * it.rate * (1 - (it.discount ?? 0) / 100), 0);
  const tax = d.items.reduce((s, it) => s + it.qty * it.rate * (1 - (it.discount ?? 0) / 100) * ((it.gstRate ?? 0) / 100), 0);
  if (d.subtotal != null && d.items.length && !near(taxable, d.subtotal)) w.push(`Check: item lines add up to ${taxable.toFixed(2)} but the bill's taxable value is ${d.subtotal}`);
  if (d.total != null && d.items.length && !near(taxable + tax + (d.roundOff ?? 0), d.total) && Math.abs(taxable + tax - d.total) > 1.5) {
    w.push(`Check: lines plus GST come to ${(taxable + tax).toFixed(2)} but the bill total is ${d.total}`);
  }
  return w;
}

/** Links each bill line to a catalog product by barcode-free name similarity. */
export async function matchItems(tx: Tx, shopId: string, items: BillItem[]): Promise<BillItem[]> {
  const out: BillItem[] = [];
  for (const it of items) {
    if (it.productId) { out.push(it); continue; }
    const res = await tx.execute(sql`
      select id, name, greatest(similarity(name, ${it.name}), word_similarity(${it.name}, name)) as score from products
      where shop_id = ${shopId} and is_active and (similarity(name, ${it.name}) > 0.3 or word_similarity(${it.name}, name) > 0.5)
      order by score desc limit 1`);
    const m = res.rows[0] as { id: string; name: string; score: number } | undefined;
    out.push(m && Number(m.score) >= 0.45
      ? { ...it, productId: m.id, matchedName: m.name, matchScore: Math.round(Number(m.score) * 100) / 100 }
      : { ...it, productId: null, matchedName: null, matchScore: m ? Math.round(Number(m.score) * 100) / 100 : null });
  }
  return out;
}
