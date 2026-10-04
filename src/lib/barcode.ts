/**
 * Barcode lookup chain.
 *
 *   1. the shop's own catalog              (caller does this first)
 *   2. global_products — Stockbook's shared master, filled by every shop
 *   3. outside providers, in order, first hit wins:
 *        Open Food Facts → Open Beauty Facts → Open Products Facts  (free)
 *        UPCitemdb (free trial / paid key) → Barcode Lookup (paid key)
 *        GS1 India DataKart — add here once you have API access from GS1 India
 *   4. nothing found → the app offers "fill from packet photo" (AI) or manual entry
 *
 * Every hit from (3) is cached into global_products so the next shop gets it instantly.
 */
import { eq, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { globalProducts } from '../db/schema.js';
import type { Tx } from '../db/index.js';

export interface ProductInfo {
  barcode: string;
  name: string;
  brand?: string | null;
  category?: string | null;
  size?: string | null;
  unit?: string | null;
  hsn?: string | null;
  gstBps?: number | null;
  mrpPaise?: number | null;
  imageUrl?: string | null;
  source: string;
}

/** EAN-13, EAN-8, UPC-A (12) and GTIN-14 check digit validation. Other codes (QR, Code-128, shop SKUs) pass through. */
export function isValidGtin(code: string): boolean {
  if (!/^\d+$/.test(code) || ![8, 12, 13, 14].includes(code.length)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop()!;
  const sum = digits.reverse().reduce((s, d, i) => s + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/** 890 is the GS1 India prefix: products registered by Indian brand owners. */
export const isIndianGtin = (code: string) => code.length === 13 && code.startsWith('890');

export function normalizeBarcode(raw: string): string {
  const c = raw.trim().replace(/\s+/g, '');
  // UPC-A scanned as EAN-13 with a leading zero is the same product
  return /^0\d{12}$/.test(c) ? c.slice(1) : c;
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<any | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Stockbook/1.0 (inventory app; contact: support@example.com)', Accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(config.BARCODE_LOOKUP_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null; // timeouts and network errors just move on to the next provider
  }
}

type Provider = { name: string; enabled: () => boolean; lookup: (code: string) => Promise<ProductInfo | null> };

const openFactsProvider = (name: string, host: string): Provider => ({
  name,
  enabled: () => true,
  async lookup(code) {
    const j = await getJson(`https://${host}/api/v2/product/${encodeURIComponent(code)}.json?fields=product_name,product_name_en,brands,quantity,categories_tags,image_front_url`);
    const p = j?.status === 1 ? j.product : null;
    const pname = p?.product_name_en || p?.product_name;
    if (!pname) return null;
    const cat = (p.categories_tags?.[0] as string | undefined)?.replace(/^\w\w:/, '').replace(/-/g, ' ');
    return {
      barcode: code,
      name: [pname, p.quantity].filter(Boolean).join(' '),
      brand: p.brands?.split(',')[0]?.trim() || null,
      category: cat || null,
      size: p.quantity || null,
      imageUrl: p.image_front_url || null,
      source: name,
    };
  },
});

const upcItemDb: Provider = {
  name: 'upcitemdb',
  enabled: () => true, // the trial endpoint works without a key at a low daily limit
  async lookup(code) {
    const j = config.UPCITEMDB_KEY
      ? await getJson(`https://api.upcitemdb.com/prod/v1/lookup?upc=${code}`, { user_key: config.UPCITEMDB_KEY, key_type: '3scale' })
      : await getJson(`https://api.upcitemdb.com/prod/trial/lookup?upc=${code}`);
    const it = j?.items?.[0];
    if (!it?.title) return null;
    return { barcode: code, name: it.title, brand: it.brand || null, category: it.category?.split('>').pop()?.trim() || null, imageUrl: it.images?.[0] || null, source: 'upcitemdb' };
  },
};

const barcodeLookup: Provider = {
  name: 'barcodelookup',
  enabled: () => !!config.BARCODELOOKUP_KEY,
  async lookup(code) {
    const j = await getJson(`https://api.barcodelookup.com/v3/products?barcode=${code}&key=${config.BARCODELOOKUP_KEY}`);
    const it = j?.products?.[0];
    if (!it?.title) return null;
    return { barcode: code, name: it.title, brand: it.brand || null, category: it.category?.split('>').pop()?.trim() || null, size: it.size || null, imageUrl: it.images?.[0] || null, source: 'barcodelookup' };
  },
};

export const providers: Provider[] = [
  openFactsProvider('openfoodfacts', 'world.openfoodfacts.org'),
  openFactsProvider('openbeautyfacts', 'world.openbeautyfacts.org'),
  openFactsProvider('openproductsfacts', 'world.openproductsfacts.org'),
  upcItemDb,
  barcodeLookup,
];

export async function lookupExternal(code: string): Promise<ProductInfo | null> {
  for (const p of providers) {
    if (!p.enabled()) continue;
    const hit = await p.lookup(code);
    if (hit) return hit;
  }
  return null;
}

/** Shared master, then outside providers; caches outside hits. */
export async function lookupBarcode(tx: Tx, raw: string): Promise<ProductInfo | null> {
  const code = normalizeBarcode(raw);
  const [g] = await tx.select().from(globalProducts).where(eq(globalProducts.barcode, code)).limit(1);
  if (g) return { ...g, source: `stockbook:${g.source}` };
  const ext = await lookupExternal(code);
  if (ext) await contributeToMaster(tx, ext);
  return ext;
}

/** Called when a shop saves a product with a barcode, or when a provider answers. */
export async function contributeToMaster(tx: Tx, info: ProductInfo) {
  if (!info.barcode || !info.name) return;
  await tx.insert(globalProducts).values({
    barcode: info.barcode, name: info.name, brand: info.brand ?? null, category: info.category ?? null, unit: info.unit ?? null,
    size: info.size ?? null, hsn: info.hsn ?? null, gstBps: info.gstBps ?? null, mrpPaise: info.mrpPaise ?? null,
    imageUrl: info.imageUrl ?? null, source: info.source,
  }).onConflictDoUpdate({
    target: globalProducts.barcode,
    // an outside provider never overwrites what shops have entered; shops add confirmations
    set: {
      confirmations: sql`${globalProducts.confirmations} + 1`,
      hsn: sql`coalesce(${globalProducts.hsn}, excluded.hsn)`,
      gstBps: sql`coalesce(${globalProducts.gstBps}, excluded.gst_bps)`,
      mrpPaise: sql`coalesce(excluded.mrp_paise, ${globalProducts.mrpPaise})`,
      updatedAt: sql`now()`,
    },
  });
}
