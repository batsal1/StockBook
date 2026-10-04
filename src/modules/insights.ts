/**
 * Business insights computed from the books. All amounts are paise; every route takes ?from=YYYY-MM-DD&to=YYYY-MM-DD
 * (default: this month) unless noted.
 *
 * Definitions used throughout
 *   Revenue        sales minus sale returns, excluding GST (taxable value)
 *   COGS           quantity sold × the product's cost at the time of sale, minus returns
 *   Operating exp. expenses excluding the GST included in them
 *   Net profit     revenue − COGS − operating expenses + other income
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/index.js';
import { shops } from '../db/schema.js';
import { allow, ctx, isoDate, parse, today } from '../lib/http.js';
import { accountBalances, partyBalances } from '../lib/ledger.js';

const rows = async <T = Record<string, unknown>>(q: SQL) => (await db.execute(q)).rows as T[];
const n = (v: unknown) => Number(v ?? 0);
const DAY = 864e5;
const addDays = (d: string, k: number) => new Date(Date.parse(d + 'T00:00:00Z') + k * DAY).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY) + 1;
const monthStart = (d = today()) => d.slice(0, 8) + '01';

const Period = z.object({ from: isoDate.optional(), to: isoDate.optional() }).transform((p) => {
  const to = p.to ?? today();
  return { from: p.from ?? monthStart(to), to };
});
/** The period of the same length immediately before, for "vs last period" comparisons. */
const previous = (from: string, to: string) => ({ from: addDays(from, -daysBetween(from, to)), to: addDays(from, -1) });
const pct = (now: number, before: number) => (before === 0 ? null : Math.round(((now - before) / Math.abs(before)) * 1000) / 10);

/* ---------------- core calculations ---------------- */

export async function profitAndLoss(shopId: string, from: string, to: string) {
  const [s] = await rows<Record<string, number>>(sql`
    select
      coalesce(sum(case when i.type = 'sale' then l.taxable_paise when i.type = 'sale_return' then -l.taxable_paise end), 0) as revenue,
      coalesce(sum(case when i.type = 'sale' then l.qty * l.unit_cost_paise when i.type = 'sale_return' then -l.qty * l.unit_cost_paise end), 0) as cogs,
      coalesce(sum(case when i.type = 'sale' then l.tax_paise when i.type = 'sale_return' then -l.tax_paise end), 0) as "outputGst",
      coalesce(sum(case when i.type = 'purchase' then l.taxable_paise + l.tax_paise when i.type = 'purchase_return' then -(l.taxable_paise + l.tax_paise) end), 0) as purchases
    from invoice_lines l join invoices i on i.id = l.invoice_id
    where i.shop_id = ${shopId} and i.status = 'active' and i.date between ${from} and ${to}`);
  const exp = await rows<{ category: string; amount: number; tax: number; count: number }>(sql`
    select coalesce(category, 'Other') as category, sum(amount_paise - tax_paise) as amount, sum(tax_paise) as tax, count(*)::int as count
    from payments where shop_id = ${shopId} and kind = 'expense' and date between ${from} and ${to} group by 1 order by 2 desc`);
  const [inc] = await rows<{ income: number }>(sql`select coalesce(sum(amount_paise), 0) as income from payments where shop_id = ${shopId} and kind = 'income' and date between ${from} and ${to}`);
  const revenue = Math.round(n(s.revenue)), cogs = Math.round(n(s.cogs));
  const opex = exp.reduce((t, e) => t + n(e.amount), 0);
  const otherIncome = n(inc.income);
  const gross = revenue - cogs, net = gross - opex + otherIncome;
  const ratio = (x: number) => (revenue ? Math.round((x / revenue) * 1000) / 10 : null);
  return {
    from, to, revenuePaise: revenue, cogsPaise: cogs, grossProfitPaise: gross, operatingExpensesPaise: opex, otherIncomePaise: otherIncome, netProfitPaise: net,
    purchasesPaise: Math.round(n(s.purchases)), outputGstPaise: Math.round(n(s.outputGst)),
    grossMarginPct: ratio(gross), netMarginPct: ratio(net), expenseRatioPct: ratio(opex), cogsRatioPct: ratio(cogs),
    expensesByCategory: exp.map((e) => ({ category: e.category, amountPaise: n(e.amount), taxPaise: n(e.tax), count: e.count })),
  };
}

export async function cashFlow(shopId: string, from: string, to: string) {
  const opening = await accountBalances(db, shopId, addDays(from, -1));
  const closing = await accountBalances(db, shopId, to);
  const [b] = await rows<Record<string, number>>(sql`
    select
      coalesce(sum(paid_paise) filter (where type = 'sale'), 0) as "salesReceived",
      coalesce(sum(paid_paise) filter (where type = 'purchase'), 0) as "purchasesPaid",
      coalesce(sum(paid_paise) filter (where type = 'sale_return'), 0) as "refundsPaid",
      coalesce(sum(paid_paise) filter (where type = 'purchase_return'), 0) as "refundsReceived"
    from invoices where shop_id = ${shopId} and status = 'active' and pay_mode <> 'credit' and date between ${from} and ${to}`);
  const [p] = await rows<Record<string, number>>(sql`
    select
      coalesce(sum(amount_paise) filter (where kind = 'payment_in'), 0) as "collected",
      coalesce(sum(amount_paise) filter (where kind = 'payment_out'), 0) as "paidOut",
      coalesce(sum(amount_paise) filter (where kind = 'expense'), 0) as "expenses",
      coalesce(sum(amount_paise) filter (where kind = 'income'), 0) as "income"
    from payments where shop_id = ${shopId} and date between ${from} and ${to}`);
  const inflows = [
    { label: 'Customer payments', amountPaise: n(b.salesReceived) + n(p.collected) },
    { label: 'Other income', amountPaise: n(p.income) },
    { label: 'Supplier refunds', amountPaise: n(b.refundsReceived) },
  ];
  const outflows = [
    { label: 'Supplier payments', amountPaise: n(b.purchasesPaid) + n(p.paidOut) },
    { label: 'Expenses', amountPaise: n(p.expenses) },
    { label: 'Customer refunds', amountPaise: n(b.refundsPaid) },
  ];
  const cashIn = inflows.reduce((t, x) => t + x.amountPaise, 0), cashOut = outflows.reduce((t, x) => t + x.amountPaise, 0);
  const openingTotal = opening.cashPaise + opening.bankPaise, closingTotal = closing.cashPaise + closing.bankPaise;
  const monthlyOut = (cashOut / daysBetween(from, to)) * 30;
  return {
    from, to, openingPaise: openingTotal, cashInPaise: cashIn, cashOutPaise: cashOut, netPaise: cashIn - cashOut, closingPaise: closingTotal,
    opening, closing, inflows, outflows, runwayMonths: monthlyOut > 0 ? Math.round((closingTotal / monthlyOut) * 10) / 10 : null,
  };
}

/**
 * Who owes what, and for how long. Payments are applied to the oldest bills first, so whatever is still owed
 * sits on the newest bills; each bill's remaining amount is aged from its date and checked against its due date.
 */
export async function aging(shopId: string, side: 'receivable' | 'payable') {
  const bal = await partyBalances(db, shopId);
  const types = side === 'receivable' ? sql`('sale')` : sql`('purchase')`;
  const ps = await rows<{ id: string; name: string; type: string; phone: string | null; opening: number; creditLimit: number | null }>(sql`
    select id, name, type, phone, opening_balance_paise as opening, credit_limit_paise as "creditLimit" from parties where shop_id = ${shopId}`);
  const bills = await rows<{ id: string; partyId: string; number: string; date: string; dueDate: string | null; total: number; paid: number }>(sql`
    select id, party_id as "partyId", number, date::text, due_date::text as "dueDate", total_paise as total, paid_paise as paid
    from invoices where shop_id = ${shopId} and status = 'active' and type in ${types} and party_id is not null order by date desc, created_at desc`);
  const t = today();
  const buckets = [
    { label: '0–30 days', max: 30, amountPaise: 0 }, { label: '31–60 days', max: 60, amountPaise: 0 },
    { label: '61–90 days', max: 90, amountPaise: 0 }, { label: '90+ days', max: Infinity, amountPaise: 0 },
  ];
  let overdue = 0, dueThisWeek = 0, total = 0;
  const parties = [];
  for (const p of ps) {
    const b = bal.get(p.id) ?? 0;
    let owed = side === 'receivable' ? b : -b;
    if (owed <= 0) continue;
    total += owed;
    const open: { number: string; date: string; dueDate: string | null; outstandingPaise: number; ageDays: number; overdue: boolean }[] = [];
    for (const bill of bills.filter((x) => x.partyId === p.id)) {
      if (owed <= 0) break;
      const part = Math.min(owed, n(bill.total));
      if (part <= 0) continue;
      owed -= part;
      const age = daysBetween(bill.date, t) - 1;
      const isOver = !!bill.dueDate && bill.dueDate < t;
      if (isOver) overdue += part;
      else if (bill.dueDate && bill.dueDate <= addDays(t, 7)) dueThisWeek += part;
      buckets.find((k) => age <= k.max)!.amountPaise += part;
      open.push({ number: bill.number, date: bill.date, dueDate: bill.dueDate, outstandingPaise: part, ageDays: age, overdue: isOver });
    }
    if (owed > 0) { buckets[3].amountPaise += owed; overdue += owed; open.push({ number: 'Opening balance', date: '', dueDate: null, outstandingPaise: owed, ageDays: 999, overdue: true }); }
    parties.push({ id: p.id, name: p.name, phone: p.phone, creditLimitPaise: p.creditLimit, outstandingPaise: open.reduce((s, x) => s + x.outstandingPaise, 0), bills: open });
  }
  parties.sort((a, b) => b.outstandingPaise - a.outstandingPaise);
  return { side, totalPaise: total, overduePaise: overdue, dueThisWeekPaise: dueThisWeek, buckets: buckets.map(({ max, ...k }) => k), parties };
}

export async function inventoryHealth(shopId: string, expiryDays: number, deadDays = 90) {
  const [r] = await rows<Record<string, number>>(sql`
    with s as (select product_id, sum(qty) qty from stock_levels where shop_id = ${shopId} group by product_id),
    lastsale as (
      select m.product_id, max(m.created_at) as at from stock_movements m
      where m.shop_id = ${shopId} and m.reason = 'sale' group by m.product_id),
    p as (
      select p.*, coalesce(s.qty, 0) as qty, ls.at as last_sale from products p
      left join s on s.product_id = p.id left join lastsale ls on ls.product_id = p.id where p.shop_id = ${shopId})
    select
      count(*)::int as "totalSkus",
      count(*) filter (where is_active)::int as "activeSkus",
      coalesce(sum(greatest(qty, 0) * cost_paise) filter (where is_active), 0) as "stockCost",
      coalesce(sum(greatest(qty, 0) * coalesce(mrp_paise, price_paise)) filter (where is_active), 0) as "stockMrp",
      coalesce(sum(greatest(qty, 0) * price_paise) filter (where is_active), 0) as "stockPrice",
      count(*) filter (where is_active and qty <= 0)::int as "outOfStock",
      count(*) filter (where is_active and qty > 0 and qty <= reorder_level)::int as "lowStock",
      count(*) filter (where is_active and qty > 0 and coalesce(last_sale, created_at) < now() - make_interval(days => ${deadDays}))::int as "deadCount",
      coalesce(sum(qty * cost_paise) filter (where is_active and qty > 0 and coalesce(last_sale, created_at) < now() - make_interval(days => ${deadDays})), 0) as "deadValue"
    from p`);
  const [e] = await rows<{ c: number }>(sql`
    select count(distinct product_id)::int as c from batches where shop_id = ${shopId} and qty > 0 and expiry is not null and expiry <= current_date + ${expiryDays}::int`);
  const active = n(r.activeSkus), low = n(r.lowStock), out = n(r.outOfStock), expiring = n(e.c);
  return {
    totalSkus: n(r.totalSkus), activeSkus: active, stockAtCostPaise: Math.round(n(r.stockCost)), stockAtMrpPaise: Math.round(n(r.stockMrp)),
    stockAtPricePaise: Math.round(n(r.stockPrice)), lowStock: low, outOfStock: out, expiring, healthy: Math.max(0, active - low - out),
    deadStockCount: n(r.deadCount), deadStockValuePaise: Math.round(n(r.deadValue)), deadDays, expiryDays,
    healthyPct: active ? Math.round(((active - low - out) / active) * 100) : 0,
  };
}

async function productPerformance(shopId: string, from: string, to: string, limit = 20) {
  return (await rows<Record<string, unknown>>(sql`
    select p.id, p.name, coalesce(p.category, 'Uncategorised') as category,
      sum(case when i.type = 'sale' then l.qty else -l.qty end) as units,
      sum(case when i.type = 'sale' then l.taxable_paise else -l.taxable_paise end) as revenue,
      sum(case when i.type = 'sale' then l.qty * l.unit_cost_paise else -l.qty * l.unit_cost_paise end) as cogs
    from invoice_lines l join invoices i on i.id = l.invoice_id join products p on p.id = l.product_id
    where i.shop_id = ${shopId} and i.status = 'active' and i.type in ('sale', 'sale_return') and i.date between ${from} and ${to}
    group by p.id order by revenue desc limit ${limit}`)).map((r) => {
    const revenue = Math.round(n(r.revenue)), cogs = Math.round(n(r.cogs));
    return { id: r.id, name: r.name, category: r.category, units: n(r.units), revenuePaise: revenue, cogsPaise: cogs, grossProfitPaise: revenue - cogs, marginPct: revenue ? Math.round(((revenue - cogs) / revenue) * 1000) / 10 : null };
  });
}

async function monthly(shopId: string, months: number) {
  const start = new Date(); start.setUTCDate(1); start.setUTCMonth(start.getUTCMonth() - (months - 1));
  const from = start.toISOString().slice(0, 10);
  const r = await rows<Record<string, unknown>>(sql`
    select to_char(m, 'YYYY-MM') as month, to_char(m, 'Mon') as label,
      coalesce(sum(case when i.type = 'sale' then i.total_paise when i.type = 'sale_return' then -i.total_paise end), 0) as sales,
      coalesce(sum(case when i.type = 'purchase' then i.total_paise when i.type = 'purchase_return' then -i.total_paise end), 0) as purchases,
      coalesce(sum(case when i.type = 'sale' then i.taxable_paise when i.type = 'sale_return' then -i.taxable_paise end), 0) as revenue
    from generate_series(${from}::date, date_trunc('month', current_date), interval '1 month') m
    left join invoices i on i.shop_id = ${shopId} and i.status = 'active' and date_trunc('month', i.date) = m
    group by m order by m`);
  return r.map((x) => ({ month: x.month as string, label: x.label as string, salesPaise: n(x.sales), purchasesPaise: n(x.purchases), revenuePaise: n(x.revenue) }));
}

async function dailyTrend(shopId: string, from: string, to: string) {
  const r = await rows<Record<string, unknown>>(sql`
    with d as (select generate_series(${from}::date, ${to}::date, interval '1 day')::date as day),
    sl as (
      select i.date as day,
        sum(case when i.type = 'sale' then l.taxable_paise else -l.taxable_paise end) as revenue,
        sum(case when i.type = 'sale' then l.taxable_paise - l.qty * l.unit_cost_paise else -(l.taxable_paise - l.qty * l.unit_cost_paise) end) as gross
      from invoice_lines l join invoices i on i.id = l.invoice_id
      where i.shop_id = ${shopId} and i.status = 'active' and i.type in ('sale', 'sale_return') and i.date between ${from} and ${to} group by 1),
    ex as (select date as day, sum(amount_paise - tax_paise) as exp from payments where shop_id = ${shopId} and kind = 'expense' and date between ${from} and ${to} group by 1)
    select d.day::text as date, coalesce(sl.revenue, 0) as revenue, coalesce(sl.gross, 0) - coalesce(ex.exp, 0) as net
    from d left join sl on sl.day = d.day left join ex on ex.day = d.day order by d.day`);
  return r.map((x) => ({ date: x.date as string, revenuePaise: Math.round(n(x.revenue)), netProfitPaise: Math.round(n(x.net)) }));
}

export async function taxSummary(shopId: string, from: string, to: string) {
  const [s] = await rows<Record<string, number>>(sql`
    select
      coalesce(sum(case when i.type = 'sale' then l.tax_paise when i.type = 'sale_return' then -l.tax_paise end), 0) as output,
      coalesce(sum(case when i.type = 'purchase' then l.tax_paise when i.type = 'purchase_return' then -l.tax_paise end), 0) as input,
      coalesce(sum(case when i.type = 'sale' then l.taxable_paise when i.type = 'sale_return' then -l.taxable_paise end), 0) as "taxableSales",
      coalesce(sum(case when i.type = 'purchase' then l.taxable_paise when i.type = 'purchase_return' then -l.taxable_paise end), 0) as "taxablePurchases"
    from invoice_lines l join invoices i on i.id = l.invoice_id
    where i.shop_id = ${shopId} and i.status = 'active' and i.date between ${from} and ${to}`);
  const [e] = await rows<{ t: number }>(sql`select coalesce(sum(tax_paise), 0) as t from payments where shop_id = ${shopId} and kind = 'expense' and date between ${from} and ${to}`);
  const byRate = await rows<Record<string, unknown>>(sql`
    select l.gst_bps as bps,
      sum(case when i.type = 'sale' then l.taxable_paise when i.type = 'sale_return' then -l.taxable_paise else 0 end) as "salesTaxable",
      sum(case when i.type = 'sale' then l.tax_paise when i.type = 'sale_return' then -l.tax_paise else 0 end) as "salesTax",
      sum(case when i.type = 'purchase' then l.tax_paise when i.type = 'purchase_return' then -l.tax_paise else 0 end) as "purchaseTax"
    from invoice_lines l join invoices i on i.id = l.invoice_id
    where i.shop_id = ${shopId} and i.status = 'active' and i.date between ${from} and ${to} group by 1 order by 1`);
  const [shop] = await db.select({ gstin: shops.gstin }).from(shops).where(eq(shops.id, shopId));
  const [hsn] = await rows<{ total: number; withHsn: number }>(sql`select count(*)::int as total, count(*) filter (where coalesce(hsn, '') <> '')::int as "withHsn" from products where shop_id = ${shopId} and is_active`);
  const output = Math.round(n(s.output)), input = Math.round(n(s.input) + n(e.t));
  return {
    from, to, gstin: shop.gstin, outputGstPaise: output, inputGstPaise: input, expenseGstPaise: n(e.t), netLiabilityPaise: output - input,
    taxableSalesPaise: Math.round(n(s.taxableSales)), taxablePurchasesPaise: Math.round(n(s.taxablePurchases)),
    byRate: byRate.map((r) => ({ ratePct: n(r.bps) / 100, salesTaxablePaise: Math.round(n(r.salesTaxable)), salesTaxPaise: Math.round(n(r.salesTax)), purchaseTaxPaise: Math.round(n(r.purchaseTax)) })),
    checklist: { gstin: !!shop.gstin, productsWithHsn: n(hsn.withHsn), productsTotal: n(hsn.total) },
  };
}

export async function balanceSheet(shopId: string, date: string) {
  const acc = await accountBalances(db, shopId, date);
  const recv = await aging(shopId, 'receivable'), pay = await aging(shopId, 'payable');
  const inv = await inventoryHealth(shopId, 30);
  const [shop] = await db.select({ fixed: shops.fixedAssetsPaise }).from(shops).where(eq(shops.id, shopId));
  const t = await taxSummary(shopId, '1900-01-01', date);
  const gstPayable = Math.max(0, t.netLiabilityPaise);
  const assets = [
    { label: 'Cash in hand', amountPaise: acc.cashPaise }, { label: 'Bank & UPI', amountPaise: acc.bankPaise },
    { label: 'Accounts receivable', amountPaise: recv.totalPaise }, { label: 'Inventory (at cost)', amountPaise: inv.stockAtCostPaise },
    { label: 'Fixed assets', amountPaise: shop.fixed },
  ];
  if (t.netLiabilityPaise < 0) assets.push({ label: 'GST input credit', amountPaise: -t.netLiabilityPaise });
  const totalAssets = assets.reduce((s, a) => s + a.amountPaise, 0);
  const liabilities = [{ label: 'Accounts payable', amountPaise: pay.totalPaise }, { label: 'GST payable', amountPaise: gstPayable }];
  const totalLiabilities = liabilities.reduce((s, a) => s + a.amountPaise, 0);
  return {
    date, assets, totalAssetsPaise: totalAssets, liabilities, totalLiabilitiesPaise: totalLiabilities,
    equityPaise: totalAssets - totalLiabilities,
    note: 'GST payable is cumulative output GST minus input GST; mark GST paid to the government as an expense with category "GST payment" to settle it.',
  };
}

/* ---------------- routes ---------------- */

const routes: FastifyPluginAsync = async (app) => {
  const finance = { preHandler: allow('owner', 'manager') };

  /** Everything the dashboard shows, for the chosen period, with comparisons against the previous period. */
  app.get('/dashboard', finance, async (req) => {
    const c = ctx(req);
    const { from, to } = parse(Period, req.query);
    const prev = previous(from, to);
    const [shop] = await db.select().from(shops).where(eq(shops.id, c.shopId));
    const [pnl, pnlPrev, cash, recv, pay, inv, tax, trend, months, top] = await Promise.all([
      profitAndLoss(c.shopId, from, to), profitAndLoss(c.shopId, prev.from, prev.to), cashFlow(c.shopId, from, to),
      aging(c.shopId, 'receivable'), aging(c.shopId, 'payable'), inventoryHealth(c.shopId, shop.expiryWarnDays),
      taxSummary(c.shopId, from, to), dailyTrend(c.shopId, from, to), monthly(c.shopId, 6), productPerformance(c.shopId, from, to, 5),
    ]);
    return {
      from, to, previous: prev,
      kpis: {
        revenuePaise: pnl.revenuePaise, revenueChangePct: pct(pnl.revenuePaise, pnlPrev.revenuePaise),
        grossProfitPaise: pnl.grossProfitPaise, grossChangePct: pct(pnl.grossProfitPaise, pnlPrev.grossProfitPaise),
        netProfitPaise: pnl.netProfitPaise, netChangePct: pct(pnl.netProfitPaise, pnlPrev.netProfitPaise),
        cashAndBankPaise: cash.closingPaise, cashPaise: cash.closing.cashPaise, bankPaise: cash.closing.bankPaise,
        receivablesPaise: recv.totalPaise, receivablesOverduePaise: recv.overduePaise,
        payablesPaise: pay.totalPaise, payablesDueThisWeekPaise: pay.dueThisWeekPaise + pay.overduePaise,
        inventoryValuePaise: inv.stockAtCostPaise, gstLiabilityPaise: tax.netLiabilityPaise, outputGstPaise: tax.outputGstPaise, inputGstPaise: tax.inputGstPaise,
      },
      trend, salesVsPurchases: months, expenses: { totalPaise: pnl.operatingExpensesPaise, byCategory: pnl.expensesByCategory },
      inventory: inv, receivablesAging: recv.buckets, topProducts: top, cashFlow: cash,
    };
  });

  app.get('/pnl', finance, async (req) => { const { from, to } = parse(Period, req.query); return profitAndLoss(ctx(req).shopId, from, to); });
  app.get('/cashflow', finance, async (req) => { const { from, to } = parse(Period, req.query); return cashFlow(ctx(req).shopId, from, to); });
  app.get('/balance-sheet', finance, async (req) => {
    const { date } = parse(z.object({ date: isoDate.default(() => today()) }), req.query);
    return balanceSheet(ctx(req).shopId, date);
  });
  app.get('/aging', finance, async (req) => {
    const { side } = parse(z.object({ side: z.enum(['receivable', 'payable']).default('receivable') }), req.query);
    return aging(ctx(req).shopId, side);
  });
  app.get('/tax', finance, async (req) => { const { from, to } = parse(Period, req.query); return taxSummary(ctx(req).shopId, from, to); });

  app.get('/inventory', async (req) => {
    const c = ctx(req);
    const q = parse(z.object({ expiryDays: z.coerce.number().int().min(1).max(365).optional(), deadDays: z.coerce.number().int().min(7).max(730).default(90) }), req.query);
    const [shop] = await db.select({ d: shops.expiryWarnDays }).from(shops).where(eq(shops.id, c.shopId));
    return inventoryHealth(c.shopId, q.expiryDays ?? shop.d, q.deadDays);
  });

  app.get('/dead-stock', async (req) => {
    const c = ctx(req);
    const { days } = parse(z.object({ days: z.coerce.number().int().min(7).max(730).default(90) }), req.query);
    return rows(sql`
      with s as (select product_id, sum(qty) qty from stock_levels where shop_id = ${c.shopId} group by product_id),
      ls as (select product_id, max(created_at) at from stock_movements where shop_id = ${c.shopId} and reason = 'sale' group by product_id)
      select p.id, p.name, p.category, s.qty as stock, p.cost_paise as "costPaise", round(s.qty * p.cost_paise) as "valuePaise",
        ls.at::date::text as "lastSale", (current_date - coalesce(ls.at, p.created_at)::date) as "daysSinceSale"
      from products p join s on s.product_id = p.id left join ls on ls.product_id = p.id
      where p.shop_id = ${c.shopId} and p.is_active and s.qty > 0 and coalesce(ls.at, p.created_at) < now() - make_interval(days => ${days})
      order by "valuePaise" desc`);
  });

  /** Every stock movement with the running balance of that product after it. */
  app.get('/stock-ledger', async (req) => {
    const c = ctx(req);
    const q = parse(z.object({ from: isoDate.optional(), to: isoDate.optional(), productId: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(5000).default(500) }), req.query);
    const to = q.to ?? today(), from = q.from ?? monthStart(to);
    return rows(sql`
      select * from (
        select m.created_at as at, m.created_at::date::text as date, p.name as product, p.id as "productId", m.reason, m.qty_change as qty, m.note,
          i.number as "billNumber", b.batch_no as batch,
          sum(m.qty_change) over (partition by m.product_id order by m.created_at, m.id) as balance
        from stock_movements m join products p on p.id = m.product_id left join invoices i on i.id = m.invoice_id left join batches b on b.id = m.batch_id
        where m.shop_id = ${c.shopId} ${q.productId ? sql`and m.product_id = ${q.productId}` : sql``}
      ) x where date between ${from} and ${to} order by at desc limit ${q.limit}`);
  });

  app.get('/expenses', finance, async (req) => {
    const c = ctx(req);
    const { from, to } = parse(Period, req.query);
    const list = await rows(sql`
      select id, date::text, coalesce(category, 'Other') as category, note, mode, amount_paise as "amountPaise", tax_paise as "taxPaise", recurring, attachment_id as "attachmentId"
      from payments where shop_id = ${c.shopId} and kind = 'expense' and date between ${from} and ${to} order by date desc, created_at desc`);
    const by = new Map<string, number>();
    let total = 0, recurring = 0, bank = 0;
    for (const e of list as Record<string, unknown>[]) {
      const a = n(e.amountPaise); total += a;
      if (e.recurring) recurring += a;
      if (/bank|charge/i.test(String(e.category))) bank += a;
      by.set(String(e.category), (by.get(String(e.category)) ?? 0) + a);
    }
    const top = [...by.entries()].sort((a, b) => b[1] - a[1])[0];
    return { from, to, totalPaise: total, count: list.length, recurringPaise: recurring, bankChargesPaise: bank, highest: top ? { category: top[0], amountPaise: top[1] } : null, items: list };
  });

  app.get('/analytics', finance, async (req) => {
    const c = ctx(req);
    const { months } = parse(z.object({ months: z.coerce.number().int().min(1).max(24).default(6) }), req.query);
    const series = await monthly(c.shopId, months);
    const from = series[0].month + '-01', to = today();
    const byCategory = await rows<Record<string, unknown>>(sql`
      select coalesce(p.category, 'Uncategorised') as category, sum(case when i.type = 'sale' then l.taxable_paise else -l.taxable_paise end) as revenue
      from invoice_lines l join invoices i on i.id = l.invoice_id join products p on p.id = l.product_id
      where i.shop_id = ${c.shopId} and i.status = 'active' and i.type in ('sale', 'sale_return') and i.date between ${from} and ${to}
      group by 1 order by 2 desc`);
    const payModes = await rows<Record<string, unknown>>(sql`
      select pay_mode as mode, count(*)::int as bills, sum(total_paise) as total from invoices
      where shop_id = ${c.shopId} and status = 'active' and type = 'sale' and date between ${from} and ${to} group by 1 order by 3 desc`);
    return {
      from, to, monthly: series,
      salesByCategory: byCategory.map((r) => ({ category: r.category, revenuePaise: Math.round(n(r.revenue)) })),
      paymentModes: payModes.map((r) => ({ mode: r.mode, bills: n(r.bills), totalPaise: n(r.total) })),
      products: await productPerformance(c.shopId, from, to, 50),
    };
  });

  /** One search box for products, bills and parties. */
  app.get('/search', async (req) => {
    const c = ctx(req);
    const { q } = parse(z.object({ q: z.string().trim().min(1).max(80) }), req.query);
    const like = '%' + q + '%';
    const [products, bills, people] = await Promise.all([
      rows(sql`select id, name, barcode, sku from products where shop_id = ${c.shopId} and is_active and (name ilike ${like} or barcode = ${q} or sku = ${q} or similarity(name, ${q}) > 0.35) order by similarity(name, ${q}) desc limit 8`),
      rows(sql`select i.id, i.number, i.type, i.date::text, i.total_paise as "totalPaise", p.name as party from invoices i left join parties p on p.id = i.party_id where i.shop_id = ${c.shopId} and (i.number ilike ${like} or p.name ilike ${like}) order by i.date desc limit 8`),
      rows(sql`select id, name, type, phone from parties where shop_id = ${c.shopId} and is_active and (name ilike ${like} or phone like ${like} or gstin ilike ${like} or similarity(name, ${q}) > 0.35) limit 8`),
    ]);
    return { products, bills, parties: people };
  });
};

export default routes;
