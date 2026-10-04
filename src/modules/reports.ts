import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/index.js';
import { shops } from '../db/schema.js';
import { allow, ctx, isoDate, month, monthRange, parse, today } from '../lib/http.js';
import { accountBalances, partyBalances } from '../lib/ledger.js';
import { gstSplit } from '../lib/money.js';

const MonthQ = z.object({ month: month.default(() => today().slice(0, 7)) });

export async function monthSummary(tx: Tx, shopId: string, m: string) {
  const [from, to] = monthRange(m);
  const inv = await tx.execute(sql`
    select type, count(*)::int as bills, coalesce(sum(total_paise), 0) as total, coalesce(sum(tax_paise), 0) as tax
    from invoices where shop_id = ${shopId} and status = 'active' and date between ${from} and ${to} group by type`);
  const by = Object.fromEntries((inv.rows as { type: string; bills: number; total: number; tax: number }[]).map((r) => [r.type, r]));
  // margin = what sales earned before tax minus what the goods cost (cost recorded on each line at the time of sale)
  const margin = await tx.execute(sql`
    select coalesce(sum(case when i.type = 'sale' then 1 else -1 end * (l.taxable_paise - round(l.qty * l.unit_cost_paise))), 0) as margin
    from invoice_lines l join invoices i on i.id = l.invoice_id
    where i.shop_id = ${shopId} and i.status = 'active' and i.type in ('sale', 'sale_return') and i.date between ${from} and ${to}`);
  const pay = await tx.execute(sql`
    select kind, coalesce(sum(amount_paise), 0) as amt from payments where shop_id = ${shopId} and date between ${from} and ${to} group by kind`);
  const p = Object.fromEntries((pay.rows as { kind: string; amt: number }[]).map((r) => [r.kind, Number(r.amt)]));
  const v = (t: string, k: 'total' | 'bills' | 'tax') => Number(by[t]?.[k] ?? 0);
  const grossMargin = Number((margin.rows[0] as { margin: number }).margin);
  const expenses = p.expense ?? 0;
  return {
    month: m,
    salesPaise: v('sale', 'total') - v('sale_return', 'total'),
    salesBills: v('sale', 'bills'),
    purchasesPaise: v('purchase', 'total') - v('purchase_return', 'total'),
    outputGstPaise: v('sale', 'tax') - v('sale_return', 'tax'),
    inputGstPaise: v('purchase', 'tax') - v('purchase_return', 'tax'),
    expensesPaise: expenses,
    otherIncomePaise: p.income ?? 0,
    grossMarginPaise: grossMargin,
    netMarginPaise: grossMargin - expenses + (p.income ?? 0),
    collectedPaise: p.payment_in ?? 0,
    paidToSuppliersPaise: p.payment_out ?? 0,
  };
}

const routes: FastifyPluginAsync = async (app) => {
  /** Everything the dashboard's top row needs. */
  app.get('/summary', async (req) => {
    const c = ctx(req);
    const { month: m } = parse(MonthQ, req.query);
    const [summary, accounts, balances, stock] = await Promise.all([
      monthSummary(db, c.shopId, m),
      accountBalances(db, c.shopId),
      partyBalances(db, c.shopId),
      db.execute(sql`
        select coalesce(sum(greatest(s.qty, 0) * p.cost_paise), 0) as "atCost", coalesce(sum(greatest(s.qty, 0) * p.price_paise), 0) as "atPrice",
               count(*) filter (where s.qty <= p.reorder_level)::int as "lowCount"
        from products p join (select product_id, sum(qty) qty from stock_levels where shop_id = ${c.shopId} group by product_id) s on s.product_id = p.id
        where p.shop_id = ${c.shopId} and p.is_active`),
    ]);
    let receivable = 0, payable = 0;
    for (const b of balances.values()) b > 0 ? (receivable += b) : (payable -= b);
    const st = stock.rows[0] as Record<string, number>;
    return {
      ...summary, ...accounts, receivablePaise: receivable, payablePaise: payable,
      stockAtCostPaise: Math.round(Number(st.atCost)), stockAtPricePaise: Math.round(Number(st.atPrice)), lowStockCount: Number(st.lowCount),
    };
  });

  app.get('/daily-sales', async (req) => {
    const c = ctx(req);
    const { month: m } = parse(MonthQ, req.query);
    const [from, to] = monthRange(m);
    const res = await db.execute(sql`
      select d::date::text as date,
        coalesce(sum(case when i.type = 'sale' then i.total_paise when i.type = 'sale_return' then -i.total_paise end), 0) as "salesPaise",
        count(i.id) filter (where i.type = 'sale')::int as bills
      from generate_series(${from}::date, ${to}::date, interval '1 day') d
      left join invoices i on i.date = d::date and i.shop_id = ${c.shopId} and i.status = 'active' and i.type in ('sale', 'sale_return')
      group by d order by d`);
    return res.rows;
  });

  /** GST by rate and HSN for GSTR-1 / GSTR-3B preparation, split into CGST/SGST or IGST by place of supply. */
  app.get('/gst', { preHandler: allow('owner', 'manager') }, async (req) => {
    const c = ctx(req);
    const { month: m } = parse(MonthQ, req.query);
    const [from, to] = monthRange(m);
    const [shop] = await db.select().from(shops).where(eq(shops.id, c.shopId));
    const res = await db.execute(sql`
      select i.type, l.gst_bps as "gstBps", coalesce(l.hsn, '') as hsn, pt.gstin as "partyGstin",
        sum(l.qty) as qty, sum(l.taxable_paise) as taxable, sum(l.tax_paise) as tax
      from invoice_lines l join invoices i on i.id = l.invoice_id left join parties pt on pt.id = i.party_id
      where i.shop_id = ${c.shopId} and i.status = 'active' and i.date between ${from} and ${to}
      group by 1, 2, 3, 4 order by 1, 2, 3`);
    const rows = (res.rows as { type: string; gstBps: number; hsn: string; partyGstin: string | null; qty: number; taxable: number; tax: number }[]).map((r) => {
      const split = gstSplit(shop.gstin, r.partyGstin, Number(r.tax));
      return {
        type: r.type, gstRate: r.gstBps / 100, hsn: r.hsn, b2b: !!r.partyGstin, qty: Number(r.qty), taxablePaise: Number(r.taxable), taxPaise: Number(r.tax),
        cgstPaise: split.cgst, sgstPaise: split.sgst, igstPaise: split.igst,
      };
    });
    return { month: m, shopGstin: shop.gstin, rows };
  });

  app.get('/low-stock', async (req) => {
    const c = ctx(req);
    const res = await db.execute(sql`
      select p.id, p.name, p.unit, p.reorder_level as "reorderLevel", coalesce(s.qty, 0) as stock,
        (select pt.name from invoice_lines l join invoices i on i.id = l.invoice_id join parties pt on pt.id = i.party_id
          where l.product_id = p.id and i.type = 'purchase' and i.status = 'active' order by i.date desc limit 1) as "lastSupplier"
      from products p left join (select product_id, sum(qty) qty from stock_levels where shop_id = ${c.shopId} group by product_id) s on s.product_id = p.id
      where p.shop_id = ${c.shopId} and p.is_active and coalesce(s.qty, 0) <= p.reorder_level
      order by coalesce(s.qty, 0) / nullif(p.reorder_level, 0) asc nulls first, p.name`);
    return res.rows;
  });

  app.get('/expiring', async (req) => {
    const c = ctx(req);
    const { days } = parse(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), req.query);
    const res = await db.execute(sql`
      select b.id as "batchId", p.id as "productId", p.name, b.batch_no as "batchNo", b.expiry, b.qty,
        (b.expiry - current_date) as "daysLeft", round(b.qty * b.cost_paise) as "valueAtCostPaise"
      from batches b join products p on p.id = b.product_id
      where b.shop_id = ${c.shopId} and b.qty > 0 and b.expiry is not null and b.expiry <= current_date + ${days}::int
      order by b.expiry`);
    return res.rows;
  });

  /** Every rupee in and out on a day, by cash and bank. */
  app.get('/daybook', async (req) => {
    const c = ctx(req);
    const { date } = parse(z.object({ date: isoDate.default(() => today()) }), req.query);
    const res = await db.execute(sql`
      select 'bill' as source, i.id, i.created_at as at, i.type::text as kind, i.number as ref, pt.name as party, i.pay_mode as mode,
        (case when i.type in ('sale', 'purchase_return') then 1 else -1 end) * i.paid_paise as "amountPaise"
      from invoices i left join parties pt on pt.id = i.party_id
      where i.shop_id = ${c.shopId} and i.date = ${date} and i.status = 'active' and i.pay_mode <> 'credit' and i.paid_paise > 0
      union all
      select 'payment', p.id, p.created_at, p.kind::text, coalesce(p.category, p.note), pt.name, p.mode,
        (case when p.kind in ('payment_in', 'income') then 1 when p.kind in ('payment_out', 'expense') then -1 else 0 end) * p.amount_paise
      from payments p left join parties pt on pt.id = p.party_id
      where p.shop_id = ${c.shopId} and p.date = ${date}
      order by at`);
    const before = await accountBalances(db, c.shopId, new Date(Date.parse(date) - 864e5).toISOString().slice(0, 10));
    const after = await accountBalances(db, c.shopId, date);
    return { date, opening: before, closing: after, entries: res.rows };
  });
};

export default routes;
