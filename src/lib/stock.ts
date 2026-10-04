import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { batches, stockLevels, stockMovements } from '../db/schema.js';
import type { Tx } from '../db/index.js';

type Reason = 'sale' | 'purchase' | 'sale_return' | 'purchase_return' | 'adjustment' | 'opening' | 'cancel';

export interface StockChange {
  shopId: string;
  branchId: string;
  productId: string;
  qtyChange: number; // + in, − out
  reason: Reason;
  trackBatches: boolean;
  invoiceId?: string | null;
  userId?: string | null;
  note?: string | null;
  batchNo?: string | null; // incoming batch, or a specific batch to take from
  expiry?: string | null;
  unitCostPaise?: number;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

async function bumpLevel(tx: Tx, shopId: string, productId: string, branchId: string, delta: number) {
  await tx.insert(stockLevels).values({ shopId, productId, branchId, qty: delta })
    .onConflictDoUpdate({ target: [stockLevels.productId, stockLevels.branchId], set: { qty: sql`${stockLevels.qty} + ${delta}` } });
}

async function move(tx: Tx, c: StockChange, qtyChange: number, batchId: string | null) {
  await tx.insert(stockMovements).values({
    shopId: c.shopId, productId: c.productId, branchId: c.branchId, batchId, qtyChange: r3(qtyChange),
    reason: c.reason, invoiceId: c.invoiceId ?? null, userId: c.userId ?? null, note: c.note ?? null,
  });
}

/**
 * Applies one stock change. Returns the batches touched, so a sale line can record
 * which batch (and expiry) it came from.
 */
export async function applyStock(tx: Tx, c: StockChange): Promise<{ batchNo: string | null; expiry: string | null }[]> {
  const touched: { batchNo: string | null; expiry: string | null }[] = [];
  if (c.qtyChange === 0) return touched;

  if (c.qtyChange > 0 && c.batchNo) {
    // incoming stock into a named batch
    const [b] = await tx.insert(batches).values({
      shopId: c.shopId, productId: c.productId, branchId: c.branchId, batchNo: c.batchNo, expiry: c.expiry ?? null,
      qty: c.qtyChange, costPaise: c.unitCostPaise ?? 0,
    }).onConflictDoUpdate({
      target: [batches.productId, batches.branchId, batches.batchNo],
      set: { qty: sql`${batches.qty} + ${c.qtyChange}`, expiry: sql`coalesce(excluded.expiry, ${batches.expiry})` },
    }).returning();
    await move(tx, c, c.qtyChange, b.id);
    touched.push({ batchNo: b.batchNo, expiry: b.expiry });
  } else if (c.qtyChange < 0 && (c.trackBatches || c.batchNo)) {
    // outgoing: a named batch, otherwise first-expiring-first-out
    let need = -c.qtyChange;
    const where = c.batchNo
      ? and(eq(batches.productId, c.productId), eq(batches.branchId, c.branchId), eq(batches.batchNo, c.batchNo))
      : and(eq(batches.productId, c.productId), eq(batches.branchId, c.branchId), gt(batches.qty, 0));
    const rows = await tx.select().from(batches).where(where)
      .orderBy(sql`${batches.expiry} asc nulls last`, asc(batches.createdAt)).for('update');
    for (const b of rows) {
      if (need <= 0) break;
      const take = c.batchNo ? need : Math.min(need, b.qty);
      if (take <= 0) continue;
      await tx.update(batches).set({ qty: sql`${batches.qty} - ${take}` }).where(eq(batches.id, b.id));
      await move(tx, c, -take, b.id);
      touched.push({ batchNo: b.batchNo, expiry: b.expiry });
      need = r3(need - take);
    }
    if (need > 0) await move(tx, c, -need, null); // sold more than batches on record: stock goes negative, flagged in reports
  } else {
    await move(tx, c, c.qtyChange, null);
  }

  await bumpLevel(tx, c.shopId, c.productId, c.branchId, c.qtyChange);
  return touched;
}

/**
 * Undo the stock effect of an invoice (when a bill is cancelled or edited). Works on the net of all movements
 * already written for the bill, so a bill can be edited any number of times and still reverse exactly once.
 */
export async function reverseInvoiceStock(tx: Tx, shopId: string, invoiceId: string, userId: string, note = 'Bill cancelled') {
  const rows = await tx.select({
    productId: stockMovements.productId, branchId: stockMovements.branchId, batchId: stockMovements.batchId,
    net: sql<number>`sum(${stockMovements.qtyChange})`,
  }).from(stockMovements).where(and(eq(stockMovements.shopId, shopId), eq(stockMovements.invoiceId, invoiceId)))
    .groupBy(stockMovements.productId, stockMovements.branchId, stockMovements.batchId);
  for (const m of rows) {
    const delta = r3(-Number(m.net));
    if (!delta) continue;
    if (m.batchId) await tx.update(batches).set({ qty: sql`${batches.qty} + ${delta}` }).where(eq(batches.id, m.batchId));
    await tx.insert(stockMovements).values({ shopId, productId: m.productId, branchId: m.branchId, batchId: m.batchId, qtyChange: delta, reason: 'cancel', invoiceId, userId, note });
    await bumpLevel(tx, shopId, m.productId, m.branchId, delta);
  }
}
