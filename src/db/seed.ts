/**
 * Demo shop with five months of history, so every dashboard, report and chart has something to show.
 *   npm run db:seed        then sign in as owner@demo.shop / demo1234
 * Safe to run again: it stops if the demo account already exists.
 */
import { buildApp } from '../app.js';
import { pool } from './index.js';

const app = await buildApp({ logger: false });
let token = '';
const call = async (method: 'GET' | 'POST' | 'PATCH', url: string, body?: object) => {
  const r = await app.inject({ method, url, payload: body, headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (r.statusCode >= 400) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
  return r.json();
};

// deterministic "random" so the demo looks the same every time
let seed = 20261003;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
const between = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const day = (offset: number) => new Date(Date.now() - offset * 864e5).toISOString().slice(0, 10);

const exists = await pool.query(`select 1 from users where lower(email) = 'owner@demo.shop'`);
if (exists.rowCount) {
  console.log('The demo shop already exists. Sign in with owner@demo.shop / demo1234');
  await app.close(); await pool.end(); process.exit(0);
}

const reg = await call('POST', '/auth/register', { shopName: 'Demo Retail Store', shopType: 'cosmetics', name: 'Demo Owner', email: 'owner@demo.shop', phone: '+91 98765 43210', password: 'demo1234' });
token = reg.token;
await call('PATCH', '/auth/shop', {
  gstin: '23ABCDE1234F1Z5', email: 'owner@demo.shop', address: 'MG Road, Indore', invoicePrefix: 'INV-2026-', nextInvoiceNumber: 1001,
  defaultGstBps: 1800, paymentTermsDays: 15, expiryWarnDays: 30, allowNegativeStock: true, costMethod: 'average',
  openingCashPaise: 5_000_000, openingBankPaise: 30_000_000, fixedAssetsPaise: 12_000_000, taxInclusive: true, roundToRupee: true,
});
await call('POST', '/auth/staff', { name: 'Sales Staff', email: 'sales@demo.shop', password: 'sales1234', role: 'cashier' });
await call('POST', '/auth/staff', { name: 'Accountant', email: 'accounts@demo.shop', password: 'accounts1234', role: 'manager' });

const sup = {
  jewel: await call('POST', '/parties', { type: 'supplier', name: 'Shree Distributors', phone: '98260 11111', gstin: '23AAACS1111D1Z5', paymentTermsDays: 14 }),
  beauty: await call('POST', '/parties', { type: 'supplier', name: 'Beauty World Pvt Ltd', phone: '98260 22222', gstin: '27AABCB2222E1Z3', paymentTermsDays: 7 }),
  central: await call('POST', '/parties', { type: 'supplier', name: 'Central Wholesale', phone: '98260 33333', gstin: '23AAFCC3333F1Z1', paymentTermsDays: 15 }),
};
const customers = [
  await call('POST', '/parties', { type: 'wholesale', name: 'Riya Boutique', phone: '98765 12345', gstin: '23RIYAB1234F1Z5', creditLimitPaise: 5_000_000, paymentTermsDays: 15 }),
  await call('POST', '/parties', { type: 'wholesale', name: 'Meena Traders', phone: '98260 44551', gstin: '23MEENA5678K1Z2', creditLimitPaise: 7_500_000, paymentTermsDays: 30 }),
  await call('POST', '/parties', { type: 'retail', name: 'Priya Sharma', phone: '99999 22222', creditLimitPaise: 1_000_000, paymentTermsDays: 7 }),
  await call('POST', '/parties', { type: 'retail', name: 'Kavita Jain', phone: '99999 33333', creditLimitPaise: 500_000, paymentTermsDays: 7 }),
];

type Seed = { name: string; sku: string; barcode: string; category: string; gst: number; cost: number; price: number; wholesale: number; mrp: number; stock: number; reorder: number; supplier: keyof typeof sup; batches?: boolean; popularity: number; hsn: string };
const P: Seed[] = [
  { name: 'Royal Bridal Chooda', sku: 'BRD-001', barcode: '8907000000011', category: 'Jewellery', gst: 3, cost: 420, price: 600, wholesale: 540, mrp: 650, stock: 42, reorder: 20, supplier: 'jewel', popularity: 6, hsn: '7117' },
  { name: 'Gold Finish Earrings', sku: 'JWL-012', barcode: '8907000000028', category: 'Jewellery', gst: 3, cost: 380, price: 590, wholesale: 520, mrp: 650, stock: 30, reorder: 12, supplier: 'jewel', popularity: 4, hsn: '7117' },
  { name: 'Gold Finish Necklace', sku: 'JWL-024', barcode: '8907000000035', category: 'Jewellery', gst: 3, cost: 1250, price: 1850, wholesale: 1650, mrp: 1999, stock: 19, reorder: 10, supplier: 'jewel', popularity: 2, hsn: '7117' },
  { name: 'Bridal Bindi Set', sku: 'BND-011', barcode: '8907000000042', category: 'Bindi', gst: 5, cost: 75, price: 200, wholesale: 160, mrp: 220, stock: 60, reorder: 25, supplier: 'central', popularity: 8, hsn: '3304' },
  { name: 'Premium Hair Serum 100 ml', sku: 'SKN-031', barcode: '8907000000059', category: 'Skincare', gst: 18, cost: 260, price: 500, wholesale: 430, mrp: 549, stock: 30, reorder: 15, supplier: 'beauty', batches: true, popularity: 5, hsn: '3305' },
  { name: 'Neem Face Wash 100 ml', sku: 'SKN-044', barcode: '8907000000066', category: 'Skincare', gst: 18, cost: 92, price: 135, wholesale: 120, mrp: 150, stock: 40, reorder: 15, supplier: 'beauty', batches: true, popularity: 5, hsn: '3401' },
  { name: 'Matte Lipstick Rose', sku: 'CSM-101', barcode: '8907000000073', category: 'Cosmetics', gst: 18, cost: 180, price: 299, wholesale: 260, mrp: 349, stock: 25, reorder: 10, supplier: 'beauty', popularity: 4, hsn: '3304' },
  { name: 'Kajal Pencil Black', sku: 'CSM-118', barcode: '8907000000080', category: 'Cosmetics', gst: 18, cost: 95, price: 160, wholesale: 140, mrp: 175, stock: 50, reorder: 20, supplier: 'beauty', popularity: 7, hsn: '3304' },
  { name: 'Nail Polish Ruby', sku: 'CSM-130', barcode: '8907000000097', category: 'Cosmetics', gst: 18, cost: 60, price: 99, wholesale: 85, mrp: 110, stock: 45, reorder: 20, supplier: 'beauty', popularity: 4, hsn: '3304' },
  { name: 'Silk Hair Scrunchies (6)', sku: 'ACC-210', barcode: '8907000000103', category: 'Accessories', gst: 12, cost: 70, price: 149, wholesale: 120, mrp: 160, stock: 35, reorder: 15, supplier: 'central', popularity: 3, hsn: '6217' },
  { name: 'Velvet Clutch Bag', sku: 'ACC-226', barcode: '8907000000110', category: 'Accessories', gst: 12, cost: 340, price: 599, wholesale: 520, mrp: 649, stock: 12, reorder: 5, supplier: 'central', popularity: 1, hsn: '4202' },
  { name: 'Silver Anklet Pair', sku: 'JWL-040', barcode: '8907000000127', category: 'Jewellery', gst: 3, cost: 610, price: 950, wholesale: 850, mrp: 999, stock: 8, reorder: 3, supplier: 'jewel', popularity: 0, hsn: '7113' },
];

const products: (Seed & { id: string; qty: number })[] = [];
for (const s of P) {
  const p = await call('POST', '/products', {
    name: s.name, sku: s.sku, barcode: s.barcode, category: s.category, hsn: s.hsn, gstBps: s.gst * 100, costPaise: s.cost * 100, pricePaise: s.price * 100,
    wholesalePaise: s.wholesale * 100, mrpPaise: s.mrp * 100, reorderLevel: s.reorder, trackBatches: !!s.batches, openingStock: s.stock,
    ...(s.batches ? { openingBatchNo: 'OPEN-1', openingExpiry: day(-45) } : {}),
  });
  products.push({ ...s, id: p.id, qty: s.stock });
}

const DAYS = 150;
let batchNo = 100;
process.stdout.write('Creating five months of sales, purchases and expenses');
for (let d = DAYS; d >= 0; d--) {
  if (d % 15 === 0) process.stdout.write('.');
  const date = day(d);
  const dom = Number(date.slice(8, 10));
  const weekday = new Date(date + 'T00:00:00Z').getUTCDay();
  // busier weekends, and the business grows over time
  const bills = between(2, 5) + (weekday === 0 || weekday === 6 ? 2 : 0) + Math.floor((DAYS - d) / 50);

  for (let b = 0; b < bills; b++) {
    const toParty = rnd() < 0.18 ? pick(customers) : null;
    const lines: { productId: string; qty: number; ratePaise: number }[] = [];
    const weighted = products.filter((p) => p.popularity > 0 && p.qty > 0).flatMap((p) => Array(p.popularity).fill(p) as typeof products);
    for (let k = 0; k < between(1, toParty?.type === 'wholesale' ? 4 : 2) && weighted.length; k++) {
      const p = pick(weighted);
      if (lines.some((l) => l.productId === p.id)) continue;
      const qty = Math.min(p.qty, toParty?.type === 'wholesale' ? between(3, 10) : between(1, 2));
      if (qty <= 0) continue;
      lines.push({ productId: p.id, qty, ratePaise: (toParty?.type === 'wholesale' ? p.wholesale : p.price) * 100 });
      p.qty -= qty;
    }
    if (!lines.length) continue;
    const mode = toParty ? pick(['credit', 'upi', 'credit', 'bank'] as const) : pick(['cash', 'upi', 'upi', 'card'] as const);
    await call('POST', '/invoices', { type: 'sale', date, partyId: toParty?.id, payMode: mode, allowOverLimit: true, lines });
  }

  if (rnd() < 0.04) {
    const p = pick(products.filter((x) => x.popularity > 2));
    await call('POST', '/invoices', { type: 'sale_return', date, payMode: 'cash', lines: [{ productId: p.id, qty: 1, ratePaise: p.price * 100 }], notes: 'Customer return' });
    p.qty += 1;
  }

  // restock twice a week from each supplier
  if (weekday === 2 || weekday === 5) {
    for (const key of Object.keys(sup) as (keyof typeof sup)[]) {
      const need = products.filter((p) => p.supplier === key && p.popularity > 0 && p.qty <= p.reorder * 1.3);
      if (!need.length) continue;
      const lines = need.map((p) => {
        const qty = p.reorder * 3 - p.qty;
        p.qty += qty;
        return { productId: p.id, qty, ratePaise: Math.round(p.cost * 100 * (0.97 + rnd() * 0.08)), ...(p.batches ? { batchNo: `B${batchNo++}`, expiry: day(-between(25, 300)) } : {}) };
      });
      await call('POST', '/invoices', { type: 'purchase', date, partyId: sup[key].id, number: `${key.toUpperCase()}-${date.replace(/-/g, '').slice(2)}`, payMode: pick(['credit', 'credit', 'bank', 'upi'] as const), lines });
    }
  }

  // settle accounts twice a month
  if (dom === 10 || dom === 25) {
    for (const s of Object.values(sup)) {
      const bal = (await call('GET', `/parties/${s.id}`)).balancePaise;
      if (bal < -100_000) await call('POST', '/payments', { kind: 'payment_out', partyId: s.id, amountPaise: Math.round((-bal * between(55, 90)) / 100), mode: 'bank', date });
    }
    for (const c of customers) {
      const bal = (await call('GET', `/parties/${c.id}`)).balancePaise;
      if (bal > 50_000 && rnd() < 0.8) await call('POST', '/payments', { kind: 'payment_in', partyId: c.id, amountPaise: Math.round((bal * between(40, 85)) / 100), mode: pick(['upi', 'bank', 'cash'] as const), date });
    }
  }

  // bank the cash drawer every Monday, keeping a float of ₹30,000
  if (weekday === 1) {
    const { cashPaise } = await call('GET', `/reports/summary?month=${date.slice(0, 7)}`);
    const before = cashPaise - 3_000_000;
    if (before > 0) await call('POST', '/payments', { kind: 'deposit', amountPaise: before, mode: 'cash', note: 'Cash deposited to bank', date });
  }

  if (dom === 1) {
    await call('POST', '/payments', { kind: 'expense', category: 'Rent', note: 'Shop premises', amountPaise: 4_200_000, mode: 'bank', recurring: true, date });
    await call('POST', '/payments', { kind: 'expense', category: 'Salary', note: 'Staff salary', amountPaise: 3_600_000, mode: 'bank', recurring: true, date });
    await call('POST', '/payments', { kind: 'expense', category: 'Internet', note: 'Broadband', amountPaise: 118_000, taxPaise: 18_000, mode: 'card', recurring: true, date });
  }
  if (dom === 5) await call('POST', '/payments', { kind: 'expense', category: 'Electricity', note: 'Electricity bill', amountPaise: between(380_000, 520_000), mode: 'upi', recurring: true, date });
  if (dom === 12) await call('POST', '/payments', { kind: 'expense', category: 'Marketing', note: 'Social media campaign', amountPaise: between(5_000, 12_000) * 100, mode: 'upi', date });
  if (dom === 28) await call('POST', '/payments', { kind: 'expense', category: 'Bank charges', note: 'POS and account charges', amountPaise: between(250, 450) * 100, mode: 'bank', date });
  if (rnd() < 0.08) await call('POST', '/payments', { kind: 'expense', category: pick(['Transport', 'Packaging', 'Tea & snacks', 'Repairs']), amountPaise: between(200, 1800) * 100, mode: 'cash', date });
}

// leave a few things needing attention: an out-of-stock item, low stock, and a batch about to expire
const find = (sku: string) => products.find((p) => p.sku === sku)!;
for (const [sku, target, reason] of [['CSM-130', 0, 'Damaged'], ['CSM-101', 4, 'Stock count correction'], ['BND-011', 9, 'Stock count correction']] as const) {
  const p = find(sku);
  if (p.qty !== target) await call('POST', `/products/${p.id}/adjust`, { qtyChange: target - p.qty, reason });
}
await call('POST', '/invoices', { type: 'purchase', date: day(1), partyId: sup.beauty.id, number: 'BW-SHORT-DATED', payMode: 'credit',
  lines: [{ productId: find('SKN-044').id, qty: 12, ratePaise: 8_500, batchNo: 'B-CLEAR', expiry: day(-12) }] });

// line up internal timestamps with the business dates, so stock history and dead-stock reports look real
await pool.query(`update invoices set created_at = date + created_at::time`);
await pool.query(`update payments set created_at = date + created_at::time`);
await pool.query(`update stock_movements m set created_at = i.date + m.created_at::time from invoices i where m.invoice_id = i.id`);
await pool.query(`update stock_movements set created_at = now() - interval '${DAYS + 1} days' where reason = 'opening'`);
await pool.query(`update products set created_at = now() - interval '${DAYS + 1} days'`);
await pool.query(`update batches set created_at = now() - interval '${DAYS + 1} days' where batch_no = 'OPEN-1'`);

console.log('\nDemo shop ready with five months of history. Sign in with owner@demo.shop / demo1234');
await app.close();
await pool.end();
