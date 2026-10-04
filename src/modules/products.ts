import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { db, type Tx } from '../db/index.js';
import { batches, branches, products, stockLevels, stockMovements } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { allow, audit, ctx, defaultBranchId, isoDate, paise, parse } from '../lib/http.js';
import { applyStock } from '../lib/stock.js';
import { contributeToMaster, isValidGtin, lookupBarcode, normalizeBarcode } from '../lib/barcode.js';

const nullableText = z.string().trim().max(200).nullish().transform((v) => (v ? v : null));

export const ProductBody = z.object({
  name: z.string().trim().min(1).max(200),
  barcode: nullableText.transform((v) => (v ? normalizeBarcode(v) : null)),
  sku: nullableText,
  brand: nullableText,
  category: nullableText,
  unit: z.string().trim().min(1).max(20).default('pcs'),
  hsn: nullableText,
  gstBps: z.number().int().min(0).max(10_000).default(0),
  costPaise: paise.default(0),
  pricePaise: paise.default(0),
  wholesalePaise: paise.nullish(),
  mrpPaise: paise.nullish(),
  reorderLevel: z.number().min(0).default(0),
  location: nullableText,
  trackBatches: z.boolean().default(false),
  attrs: z.record(z.string(), z.string()).default({}),
});
const CreateProduct = ProductBody.extend({
  openingStock: z.number().min(0).default(0),
  openingBatchNo: z.string().trim().optional(),
  openingExpiry: isoDate.optional(),
  branchId: z.string().uuid().optional(),
});
const ListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.string().optional(),
  stock: z.enum(['low', 'out', 'expiring']).optional(),
  expiringDays: z.coerce.number().int().min(1).max(365).default(30),
  branchId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const Adjust = z.object({
  qtyChange: z.number().refine((n) => n !== 0, 'cannot be zero'),
  reason: z.string().trim().min(1).max(100), // "Damaged", "Expired", "Stock count correction"…
  batchNo: z.string().trim().optional(),
  expiry: isoDate.optional(),
  branchId: z.string().uuid().optional(),
});

/**
 * Typo-tolerant, multi-word search. Every word must match the product's name, brand, category,
 * codes or extra details — either as a substring or by trigram similarity ("shampo" ≈ "shampoo").
 * Exact barcode/SKU matches always come first.
 */
export async function searchProducts(tx: Tx, shopId: string, f: z.infer<typeof ListQuery>) {
  const hay = sql`concat_ws(' ', p.name, p.brand, p.category, p.barcode, p.sku, p.hsn, p.location, p.attrs::text)`;
  const where: SQL[] = [sql`p.shop_id = ${shopId}`, sql`p.is_active`];
  let rank: SQL = sql`0::int`;
  const q = f.q?.trim();
  if (q) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    const perWord = words.map((w) => sql`(${hay} ilike ${'%' + w + '%'} or word_similarity(${w}, ${hay}) > 0.45)`);
    where.push(sql`(p.barcode = ${q} or p.sku = ${q} or (${sql.join(perWord, sql` and `)}))`);
    rank = sql`(case when p.barcode = ${q} or p.sku = ${q} then 100 else 0 end)
      + (case when p.name ilike ${q + '%'} then 5 else 0 end)
      + similarity(p.name, ${q}) * 3 + word_similarity(${q}, ${hay})`;
  }
  if (f.category) where.push(sql`p.category = ${f.category}`);
  if (f.stock === 'out') where.push(sql`coalesce(s.qty, 0) <= 0`);
  if (f.stock === 'low') where.push(sql`coalesce(s.qty, 0) <= p.reorder_level`);
  if (f.stock === 'expiring') {
    where.push(sql`exists (select 1 from batches b where b.product_id = p.id and b.qty > 0 and b.expiry <= current_date + ${f.expiringDays}::int)`);
  }
  const branchFilter = f.branchId ? sql`and branch_id = ${f.branchId}` : sql``;
  const res = await tx.execute(sql`
    select p.id, p.name, p.barcode, p.sku, p.brand, p.category, p.unit, p.hsn, p.gst_bps as "gstBps",
      p.cost_paise as "costPaise", p.price_paise as "pricePaise", p.wholesale_paise as "wholesalePaise", p.mrp_paise as "mrpPaise",
      p.reorder_level as "reorderLevel", p.location, p.track_batches as "trackBatches", p.attrs,
      coalesce(s.qty, 0) as stock,
      (select min(b.expiry) from batches b where b.product_id = p.id and b.qty > 0) as "nextExpiry",
      count(*) over() as "totalCount"
    from products p
    left join (select product_id, sum(qty) as qty from stock_levels where shop_id = ${shopId} ${branchFilter} group by product_id) s on s.product_id = p.id
    where ${sql.join(where, sql` and `)}
    order by ${q ? sql`${rank} desc, p.name asc` : sql`p.name asc`}
    limit ${f.limit} offset ${f.offset}`);
  const rows = res.rows as Array<Record<string, unknown> & { totalCount: number }>;
  return { total: rows[0]?.totalCount ?? 0, items: rows.map(({ totalCount, ...r }) => r) };
}

const routes: FastifyPluginAsync = async (app) => {
  app.get('/', async (req) => searchProducts(db, ctx(req).shopId, parse(ListQuery, req.query)));

  app.get('/categories', async (req) => {
    const res = await db.execute(sql`select category, count(*)::int as count from products where shop_id = ${ctx(req).shopId} and is_active and category is not null group by category order by category`);
    return res.rows;
  });

  /** Rename a category on every product that uses it (or merge two categories). */
  app.post('/categories/rename', { preHandler: allow('owner', 'manager') }, async (req) => {
    const c = ctx(req);
    const b = parse(z.object({ from: z.string().trim().min(1), to: z.string().trim().max(200) }), req.body);
    const r = await db.update(products).set({ category: b.to || null, updatedAt: new Date() })
      .where(and(eq(products.shopId, c.shopId), eq(products.category, b.from))).returning({ id: products.id });
    await audit(db, c, 'rename_category', 'products', null, { ...b, count: r.length });
    return { updated: r.length };
  });

  /** Scan flow: catalog first, then the shared master and outside databases. */
  app.get('/lookup/:code', async (req) => {
    const c = ctx(req);
    const code = normalizeBarcode((req.params as { code: string }).code);
    const [own] = await db.select().from(products).where(and(eq(products.shopId, c.shopId), eq(products.isActive, true), sql`(${products.barcode} = ${code} or ${products.sku} = ${code})`));
    if (own) {
      const [lvl] = await db.select({ qty: sql<number>`coalesce(sum(${stockLevels.qty}), 0)` }).from(stockLevels).where(eq(stockLevels.productId, own.id));
      return { found: 'catalog', product: { ...own, stock: Number(lvl?.qty ?? 0) } };
    }
    const info = await lookupBarcode(db, code);
    if (info) return { found: info.source.startsWith('stockbook') ? 'master' : 'external', suggestion: info };
    return { found: null, barcode: code, validGtin: isValidGtin(code), hint: 'Not found anywhere. Fill from a packet photo (POST /ai/product-from-photo) or enter manually.' };
  });

  app.get('/:id', async (req) => {
    const c = ctx(req);
    const { id } = req.params as { id: string };
    const [p] = await db.select().from(products).where(and(eq(products.id, id), eq(products.shopId, c.shopId)));
    if (!p) throw notFound('Product');
    const stock = await db.select({ branchId: stockLevels.branchId, branch: branches.name, qty: stockLevels.qty })
      .from(stockLevels).innerJoin(branches, eq(branches.id, stockLevels.branchId)).where(eq(stockLevels.productId, id));
    const bt = await db.select().from(batches).where(and(eq(batches.productId, id), sql`${batches.qty} <> 0`)).orderBy(sql`${batches.expiry} asc nulls last`);
    const history = await db.select().from(stockMovements).where(eq(stockMovements.productId, id)).orderBy(desc(stockMovements.createdAt)).limit(30);
    return { ...p, stock: stock.reduce((s, x) => s + x.qty, 0), stockByBranch: stock, batches: bt, history };
  });

  app.post('/', { preHandler: allow('owner', 'manager') }, async (req, reply) => {
    const c = ctx(req);
    const b = parse(CreateProduct, req.body);
    const { openingStock, openingBatchNo, openingExpiry, branchId, ...data } = b;
    const out = await db.transaction(async (tx) => {
      const [p] = await tx.insert(products).values({ ...data, shopId: c.shopId }).returning();
      if (openingStock > 0) {
        await applyStock(tx, {
          shopId: c.shopId, branchId: await defaultBranchId(tx, c.shopId, branchId), productId: p.id, qtyChange: openingStock,
          reason: 'opening', trackBatches: p.trackBatches, userId: c.userId, batchNo: openingBatchNo, expiry: openingExpiry, unitCostPaise: p.costPaise,
        });
      }
      if (p.barcode) await contributeToMaster(tx, { barcode: p.barcode, name: p.name, brand: p.brand, category: p.category, unit: p.unit, hsn: p.hsn, gstBps: p.gstBps, mrpPaise: p.mrpPaise, source: 'shop' });
      await audit(tx, c, 'create', 'product', p.id, { name: p.name });
      return p;
    });
    return reply.status(201).send(out);
  });

  app.patch('/:id', { preHandler: allow('owner', 'manager') }, async (req) => {
    const c = ctx(req);
    const { id } = req.params as { id: string };
    const b = parse(ProductBody.partial(), req.body);
    const [p] = await db.update(products).set({ ...b, updatedAt: new Date() }).where(and(eq(products.id, id), eq(products.shopId, c.shopId))).returning();
    if (!p) throw notFound('Product');
    await audit(db, c, 'update', 'product', id, b);
    return p;
  });

  /** Products are archived, not deleted, so old bills keep their lines. */
  app.delete('/:id', { preHandler: allow('owner', 'manager') }, async (req) => {
    const c = ctx(req);
    const { id } = req.params as { id: string };
    const [p] = await db.update(products).set({ isActive: false, updatedAt: new Date() }).where(and(eq(products.id, id), eq(products.shopId, c.shopId))).returning({ id: products.id });
    if (!p) throw notFound('Product');
    await audit(db, c, 'archive', 'product', id);
    return { archived: true };
  });

  app.post('/:id/adjust', { preHandler: allow('owner', 'manager') }, async (req) => {
    const c = ctx(req);
    const { id } = req.params as { id: string };
    const b = parse(Adjust, req.body);
    return db.transaction(async (tx) => {
      const [p] = await tx.select().from(products).where(and(eq(products.id, id), eq(products.shopId, c.shopId)));
      if (!p) throw notFound('Product');
      const branchId = await defaultBranchId(tx, c.shopId, b.branchId);
      await applyStock(tx, {
        shopId: c.shopId, branchId, productId: id, qtyChange: b.qtyChange, reason: 'adjustment', trackBatches: p.trackBatches,
        userId: c.userId, note: b.reason, batchNo: b.batchNo, expiry: b.expiry, unitCostPaise: p.costPaise,
      });
      await audit(tx, c, 'adjust_stock', 'product', id, b);
      const [lvl] = await tx.select({ qty: stockLevels.qty }).from(stockLevels).where(and(eq(stockLevels.productId, id), eq(stockLevels.branchId, branchId)));
      return { productId: id, branchId, stock: lvl?.qty ?? 0 };
    });
  });
};

export default routes;
