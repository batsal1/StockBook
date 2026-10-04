/**
 * End-to-end test: runs a shop's day through the real API and a real PostgreSQL database.
 * Needs TEST_DATABASE_URL (an empty database it may wipe), e.g.
 *   TEST_DATABASE_URL=postgres://stockbook:stockbook@localhost:5432/stockbook_test npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'set TEST_DATABASE_URL to run API tests';
if (url) {
  process.env.DATABASE_URL = url;
  process.env.JWT_SECRET ??= 'test-secret-0123456789';
  process.env.NODE_ENV = 'test';
  process.env.BARCODE_LOOKUP_TIMEOUT_MS = '300';
  process.env.UPLOAD_DIR = '/tmp/stockbook-test-uploads';
}

let app: Awaited<ReturnType<typeof import('../src/app.ts')['buildApp']>>;
let pool: typeof import('../src/db/index.ts')['pool'];
let token = '';
const call = async (method: string, url: string, body?: unknown, t = token) => {
  const res = await app.inject({ method: method as 'GET', url, payload: body as object, headers: t ? { authorization: `Bearer ${t}` } : {} });
  const json = res.headers['content-type']?.toString().includes('json') ? res.json() : res.rawPayload;
  return { status: res.statusCode, body: json as any };
};

before(async () => {
  if (!url) return;
  ({ pool } = await import('../src/db/index.ts'));
  await pool.query('drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;');
  await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  const { migrate } = await import('drizzle-orm/node-postgres/migrator');
  const { db } = await import('../src/db/index.ts');
  await migrate(db, { migrationsFolder: './drizzle' });
  app = await (await import('../src/app.ts')).buildApp({ logger: false });
});
after(async () => { if (app) await app.close(); if (pool) await pool.end(); });

const ids: Record<string, string> = {};

test('owner registers a shop and gets a token', { skip }, async () => {
  const r = await call('POST', '/auth/register', { shopName: 'Annapurna Kirana', shopType: 'grocery', name: 'Ravi', email: 'ravi@example.com', password: 'secret123' }, '');
  assert.equal(r.status, 201);
  token = r.body.token;
  await call('PATCH', '/auth/shop', { gstin: '23AAAAA0000A1Z5', openingCashPaise: 500000, openingBankPaise: 2000000 });
  const dup = await call('POST', '/auth/register', { shopName: 'Other shop', name: 'Yash', email: 'RAVI@example.com', password: 'secret123' }, '');
  assert.equal(dup.status, 409);
  const unauth = await call('GET', '/products', undefined, '');
  assert.equal(unauth.status, 401);
});

test('parties: supplier and wholesale buyer', { skip }, async () => {
  let r = await call('POST', '/parties', { type: 'supplier', name: 'Shree Ganesh Distributors', gstin: '23BBBBB1111B1Z5', phone: '9800000001' });
  assert.equal(r.status, 201); ids.supplier = r.body.id;
  r = await call('POST', '/parties', { type: 'supplier', name: 'Glow Beauty Wholesale', gstin: '27CCCCC2222C1Z5' });
  ids.supplier2 = r.body.id;
  r = await call('POST', '/parties', { type: 'wholesale', name: 'Sharma General Store', phone: '9800000003' });
  ids.buyer = r.body.id;
  const bad = await call('POST', '/parties', { type: 'retail', name: 'X', gstin: 'NOTAGSTIN' });
  assert.equal(bad.status, 400);
});

test('products: create, duplicate barcode refused, typo-tolerant search, barcode scan', { skip }, async () => {
  let r = await call('POST', '/products', { name: 'Toor dal 1 kg', barcode: '8901234500028', category: 'Staples', gstBps: 500, costPaise: 12800, pricePaise: 14500, wholesalePaise: 13800, mrpPaise: 15500, reorderLevel: 10, openingStock: 40 });
  assert.equal(r.status, 201); ids.dal = r.body.id;
  r = await call('POST', '/products', { name: 'Herbal shampoo 340 ml', brand: 'Leaf & Co', barcode: '8901234500103', category: 'Haircare', gstBps: 1800, costPaise: 16500, pricePaise: 22900, reorderLevel: 4 });
  ids.shampoo = r.body.id;
  r = await call('POST', '/products', { name: 'Full cream milk 500 ml', category: 'Dairy', gstBps: 500, costPaise: 3000, pricePaise: 3300, trackBatches: true, openingStock: 10, openingBatchNo: 'M-OLD', openingExpiry: '2026-10-05' });
  ids.milk = r.body.id;

  const dup = await call('POST', '/products', { name: 'Other', barcode: '8901234500028' });
  assert.equal(dup.status, 409);

  r = await call('GET', '/products?q=shampo');
  assert.equal(r.body.items[0]?.name, 'Herbal shampoo 340 ml');
  r = await call('GET', '/products?q=leaf%20herbal');
  assert.equal(r.body.items[0]?.id, ids.shampoo);
  r = await call('GET', '/products?q=8901234500028');
  assert.equal(r.body.items[0]?.id, ids.dal);
  assert.equal(r.body.items[0]?.stock, 40);

  r = await call('GET', '/products/lookup/8901234500103');
  assert.equal(r.body.found, 'catalog');
  r = await call('GET', '/products/lookup/4006381333931'); // not in catalog; outside lookups may be unreachable in CI
  assert.ok(['master', 'external', null].includes(r.body.found));
});

test('purchase on part credit: stock in, batch created, cost updated, new product created', { skip }, async () => {
  const r = await call('POST', '/invoices', {
    type: 'purchase', partyId: ids.supplier, number: 'INV-4471', date: '2026-09-28', payMode: 'bank', paidPaise: 300000,
    lines: [
      { productId: ids.dal, qty: 20, ratePaise: 13000, gstBps: 500 },
      { productId: ids.milk, qty: 24, ratePaise: 2900, gstBps: 500, batchNo: 'M-NEW', expiry: '2026-10-20' },
      { newProduct: { name: 'Masala tea 250 g', hsn: '0902' }, qty: 12, ratePaise: 9800, gstBps: 500 },
    ],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.taxInclusive, false);
  // 20×130 + 24×29 + 12×98 = 4,472 taxable + 5% = 4,695.60 → rounded 4,696
  assert.equal(r.body.totalPaise, 469600);
  ids.tea = r.body.lines[2].productId;
  const dal = await call('GET', `/products/${ids.dal}`);
  assert.equal(dal.body.stock, 60);
  assert.equal(dal.body.costPaise, 13000);
  const noSupplier = await call('POST', '/invoices', { type: 'purchase', lines: [{ productId: ids.dal, qty: 1, ratePaise: 100 }] });
  assert.equal(noSupplier.status, 400);
});

test('sale takes the earliest-expiring batch first', { skip }, async () => {
  const r = await call('POST', '/invoices', { type: 'sale', date: '2026-09-30', payMode: 'cash', lines: [{ productId: ids.milk, qty: 12 }, { productId: ids.dal, qty: 2 }].map((l) => ({ ...l, ratePaise: l.productId === ids.milk ? 3300 : 14500 })) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.number, /^S\/2026-27\/0001$/);
  assert.equal(r.body.totalPaise, 12 * 3300 + 2 * 14500);
  const milk = await call('GET', `/products/${ids.milk}`);
  const byBatch = Object.fromEntries(milk.body.batches.map((b: any) => [b.batchNo, b.qty]));
  assert.equal(byBatch['M-OLD'], undefined, 'old batch fully used'); // qty 0 rows are hidden
  assert.equal(byBatch['M-NEW'], 22);
  assert.equal(milk.body.stock, 22);
});

test('walk-in credit refused; wholesale buyer gets credit; payment reduces balance', { skip }, async () => {
  const walkIn = await call('POST', '/invoices', { type: 'sale', payMode: 'credit', lines: [{ productId: ids.dal, qty: 1, ratePaise: 14500 }] });
  assert.equal(walkIn.status, 400);
  const r = await call('POST', '/invoices', { type: 'sale', partyId: ids.buyer, date: '2026-09-30', payMode: 'upi', paidPaise: 30000, lines: [{ productId: ids.dal, qty: 10, ratePaise: 13800 }] });
  assert.equal(r.status, 201);
  ids.creditSale = r.body.id;
  let p = await call('GET', `/parties/${ids.buyer}`);
  assert.equal(p.body.balancePaise, 138000 - 30000);
  await call('POST', '/payments', { kind: 'payment_in', partyId: ids.buyer, amountPaise: 50000, mode: 'cash', date: '2026-09-30' });
  p = await call('GET', `/parties/${ids.buyer}/statement`);
  assert.equal(p.body.balancePaise, 58000);
  assert.match(p.body.whatsappReminder, /^https:\/\/wa\.me\/919800000003/);
  const sup = await call('GET', `/parties/${ids.supplier}`);
  assert.equal(sup.body.balancePaise, -(469600 - 300000));
});

test('accounts: cash, bank, receivable, payable, margin', { skip }, async () => {
  await call('POST', '/payments', { kind: 'expense', amountPaise: 120000, mode: 'cash', category: 'Electricity', date: '2026-09-30' });
  const s = await call('GET', '/reports/summary?month=2026-09');
  // cash: 5,000 opening + 685 cash sale + 500 collected − 1,200 electricity
  assert.equal(s.body.cashPaise, 500000 + 68600 + 50000 - 120000);
  // bank: 20,000 opening − 3,000 paid to supplier + 300 UPI
  assert.equal(s.body.bankPaise, 2000000 - 300000 + 30000);
  assert.equal(s.body.receivablePaise, 58000);
  assert.equal(s.body.payablePaise, 169600);
  assert.equal(s.body.salesBills, 2);
  assert.ok(s.body.grossMarginPaise > 0);
  const daily = await call('GET', '/reports/daily-sales?month=2026-09');
  assert.equal(daily.body.length, 30);
  assert.equal(Number(daily.body[29].salesPaise), 68600 + 138000);
  const book = await call('GET', '/reports/daybook?date=2026-09-30');
  assert.equal(book.body.closing.cashPaise, s.body.cashPaise);
  assert.equal(book.body.entries.length, 4); // cash sale, UPI sale, payment received, electricity
});

test('GST report splits by state', { skip }, async () => {
  const g = await call('GET', '/reports/gst?month=2026-09');
  const purchase = g.body.rows.filter((r: any) => r.type === 'purchase');
  assert.ok(purchase.length > 0);
  assert.ok(purchase.every((r: any) => r.igstPaise === 0 && r.cgstPaise + r.sgstPaise === r.taxPaise), 'same-state supplier → CGST+SGST');
});

test('cancelling a bill puts the stock back and removes it from balances', { skip }, async () => {
  const before = (await call('GET', `/products/${ids.dal}`)).body.stock;
  const r = await call('POST', `/invoices/${ids.creditSale}/cancel`, { reason: 'Entered twice' });
  assert.equal(r.body.status, 'cancelled');
  assert.equal((await call('GET', `/products/${ids.dal}`)).body.stock, before + 10);
  assert.equal((await call('GET', `/parties/${ids.buyer}`)).body.balancePaise, -50000);
  assert.equal((await call('POST', `/invoices/${ids.creditSale}/cancel`, { reason: 'again' })).status, 409);
});

test('offline sync is idempotent', { skip }, async () => {
  const bill = { clientRef: 'device-7f3a-000123', type: 'sale', payMode: 'cash', lines: [{ productId: ids.tea, qty: 1, ratePaise: 12000 }] };
  const a = await call('POST', '/invoices/sync', { bills: [bill, { ...bill, clientRef: 'device-7f3a-000124' }] });
  const b = await call('POST', '/invoices/sync', { bills: [bill] });
  assert.equal(a.body.results.length, 2);
  assert.ok(a.body.results.every((x: any) => x.ok));
  assert.equal(b.body.results[0].id, a.body.results[0].id);
  assert.equal((await call('GET', `/products/${ids.tea}`)).body.stock, 10);
});

test('stock adjustment and low-stock report', { skip }, async () => {
  const r = await call('POST', `/products/${ids.shampoo}/adjust`, { qtyChange: 3, reason: 'Stock count correction' });
  assert.equal(r.body.stock, 3);
  const low = await call('GET', '/reports/low-stock');
  assert.ok(low.body.some((p: any) => p.id === ids.shampoo));
  const exp = await call('GET', '/reports/expiring?days=365');
  assert.ok(exp.body.some((b: any) => b.batchNo === 'M-NEW'));
});

test('Excel: import preview, commit with stock count, export workbook', { skip }, async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(['Item Name', 'Bar Code', 'Company', 'GST %', 'Purchase Price', 'Selling Price', 'MRP', 'Qty', 'Shade']);
  ws.addRow(['Matte lipstick Rose', '8901234500097', 'Glow', '18', '180', '299', '349', '5', 'Rose']);
  ws.addRow(['Toor dal 1 kg', '8901234500028', '', '5', '', '146', '', '100', '']);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const boundary = '----stockbook';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="items.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`),
    buf, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const send = (qs: string) => app.inject({ method: 'POST', url: `/excel/products/import${qs}`, payload, headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` } });
  const preview = (await send('')).json();
  assert.equal(preview.preview.toCreate, 1);
  assert.equal(preview.preview.toUpdate, 1);
  assert.equal(preview.preview.mapping['Item Name'], 'name');
  const done = (await send('?commit=true&stockMode=set')).json();
  assert.deepEqual([done.created, done.updated], [1, 1]);
  const dal = (await call('GET', `/products/${ids.dal}`)).body;
  assert.equal(dal.stock, 100);
  assert.equal(dal.pricePaise, 14600);
  const lip = (await call('GET', '/products?q=lipstik')).body.items[0];
  assert.equal(lip.attrs.shade, 'Rose');

  const exp = await app.inject({ method: 'GET', url: '/excel/export?month=2026-09', headers: { authorization: `Bearer ${token}` } });
  assert.equal(exp.statusCode, 200);
  const out = new ExcelJS.Workbook();
  await out.xlsx.load(exp.rawPayload as unknown as ArrayBuffer);
  assert.deepEqual(out.worksheets.map((w) => w.name), ['Products', 'Bills', 'Bill lines', 'Parties', 'Payments & expenses']);
});

test('roles: a cashier can sell but cannot buy, cancel or see GST', { skip }, async () => {
  const s = await call('POST', '/auth/staff', { name: 'Asha', email: 'asha@example.com', password: 'cashier123', role: 'cashier' });
  assert.equal(s.status, 201);
  const login = await call('POST', '/auth/login', { email: 'asha@example.com', password: 'cashier123' }, '');
  const ct = login.body.token;
  assert.equal((await call('POST', '/invoices', { type: 'sale', payMode: 'cash', lines: [{ productId: ids.dal, qty: 1, ratePaise: 14600 }] }, ct)).status, 201);
  assert.equal((await call('POST', '/invoices', { type: 'purchase', partyId: ids.supplier, payMode: 'cash', lines: [{ productId: ids.dal, qty: 1, ratePaise: 100 }] }, ct)).status, 400);
  assert.equal((await call('GET', '/reports/gst?month=2026-09', undefined, ct)).status, 403);
  assert.equal((await call('POST', '/products', { name: 'X' }, ct)).status, 403);
});

test('AI routes explain when no API key is set', { skip: skip || !!process.env.ANTHROPIC_API_KEY }, async () => {
  const r = await call('POST', '/ai/read-bill', { attachmentId: '00000000-0000-0000-0000-000000000000' });
  assert.equal(r.status, 404); // file is checked first
});

/* ---------------- business suite ---------------- */

const multipart = (filename: string, mime: string, buf: Buffer) => {
  const boundary = '----stockbook' + Math.random().toString(16).slice(2);
  return {
    payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`), buf, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
};

test('settings: invoice prefix numbering, due dates from terms, credit limits, negative stock', { skip }, async () => {
  await call('PATCH', '/auth/shop', { invoicePrefix: 'INV-2026-', nextInvoiceNumber: 1049, paymentTermsDays: 15, allowNegativeStock: false });
  const me = await call('GET', '/auth/me');
  assert.equal(me.body.shop.nextInvoiceNumber, 1049);
  const lim = await call('POST', '/parties', { type: 'retail', name: 'Limit Test', creditLimitPaise: 20000, paymentTermsDays: 7 });
  const ok = await call('POST', '/invoices', { type: 'sale', partyId: lim.body.id, date: '2026-10-01', payMode: 'credit', lines: [{ productId: ids.dal, qty: 1, ratePaise: 14600 }] });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.number, 'INV-2026-1049');
  assert.equal(ok.body.dueDate, '2026-10-08'); // 7-day terms of this customer
  const over = await call('POST', '/invoices', { type: 'sale', partyId: lim.body.id, payMode: 'credit', lines: [{ productId: ids.dal, qty: 1, ratePaise: 14600 }] });
  assert.equal(over.status, 400);
  assert.match(over.body.message, /credit limit/);
  const allowed = await call('POST', '/invoices', { type: 'sale', partyId: lim.body.id, payMode: 'credit', allowOverLimit: true, lines: [{ productId: ids.dal, qty: 1, ratePaise: 14600 }] });
  assert.equal(allowed.status, 201);
  const tooMany = await call('POST', '/invoices', { type: 'sale', payMode: 'cash', lines: [{ productId: ids.shampoo, qty: 999, ratePaise: 100 }] });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.body.message, /in stock/);
  await call('PATCH', '/auth/shop', { allowNegativeStock: true });
  const list = await call('GET', '/invoices?type=sale&payment=unpaid&q=Limit');
  assert.equal(list.body.length, 2);
});

test('weighted average cost', { skip }, async () => {
  await call('PATCH', '/auth/shop', { costMethod: 'average' });
  const p = await call('POST', '/products', { name: 'Avg cost item', costPaise: 1000, openingStock: 10 });
  await call('POST', '/invoices', { type: 'purchase', partyId: ids.supplier, payMode: 'credit', lines: [{ productId: p.body.id, qty: 10, ratePaise: 2000, gstBps: 0 }] });
  assert.equal((await call('GET', `/products/${p.body.id}`)).body.costPaise, 1500);
  await call('PATCH', '/auth/shop', { costMethod: 'latest' });
});

test('insights: figures are consistent with each other', { skip }, async () => {
  const q = 'from=2026-09-01&to=2026-10-31';
  const pnl = (await call('GET', '/insights/pnl?' + q)).body;
  assert.equal(pnl.grossProfitPaise, pnl.revenuePaise - pnl.cogsPaise);
  assert.equal(pnl.netProfitPaise, pnl.grossProfitPaise - pnl.operatingExpensesPaise + pnl.otherIncomePaise);
  const cf = (await call('GET', '/insights/cashflow?' + q)).body;
  assert.equal(cf.closingPaise - cf.openingPaise, cf.netPaise, 'cash flow reconciles');
  const bs = (await call('GET', '/insights/balance-sheet')).body;
  assert.equal(bs.totalAssetsPaise - bs.totalLiabilitiesPaise, bs.equityPaise);
  const recv = (await call('GET', '/insights/aging?side=receivable')).body;
  assert.equal(recv.buckets.reduce((s: number, b: any) => s + b.amountPaise, 0), recv.totalPaise);
  const dash = (await call('GET', '/insights/dashboard?' + q)).body;
  assert.equal(dash.kpis.revenuePaise, pnl.revenuePaise);
  assert.equal(dash.kpis.receivablesPaise, recv.totalPaise);
  for (const u of ['/insights/inventory', '/insights/dead-stock?days=7', '/insights/stock-ledger?' + q, '/insights/expenses?' + q, '/insights/tax?' + q, '/insights/analytics?months=3', '/insights/search?q=dal']) {
    assert.equal((await call('GET', u)).status, 200, u);
  }
  const ledger = (await call('GET', `/insights/stock-ledger?${q}&productId=${ids.dal}`)).body;
  const dal = (await call('GET', `/products/${ids.dal}`)).body;
  assert.equal(ledger[0].balance, dal.stock, 'latest ledger balance equals current stock');
});

test('bill scanner: upload, OCR data, product matching, convert to purchase', { skip }, async () => {
  const { readFile } = await import('node:fs/promises');
  const img = await readFile('public/sample-bill.png');
  const up = await app.inject({ method: 'POST', url: '/scans?engine=none', ...multipart('sample-bill.png', 'image/png', img) });
  assert.equal(up.statusCode, 201);
  const scan = up.json();
  assert.equal(scan.status, 'pending');

  // the browser's OCR parser output for this bill (from a real OCR run), as the web app sends it
  const ocrText = await readFile('test/fixtures/sample-bill-ocr.txt', 'utf8');
  const html = await readFile('public/index.html', 'utf8');
  const parserSrc = html.slice(html.indexOf('function parseBillText'), html.indexOf('/* ================= bill scanner ================= */'));
  const parseBillText = new Function(parserSrc + '; return parseBillText;')();
  const data = parseBillText(ocrText, '23ABCDE1234F1Z5');
  assert.equal(data.vendor.gstin, '27AABCB2222E1Z3', 'OCR misread Z as 7; the parser repairs it');
  assert.equal(data.billNo, 'BW/26-27/0871');
  assert.equal(data.items.length, 4);
  assert.equal(data.total, 8904);

  // catalog has a lipstick and shampoo from earlier tests; add two more so matching has something to find
  await call('POST', '/products', { name: 'Kajal Pencil Black', costPaise: 9000, gstBps: 1800 });
  const saved = await call('PUT', `/scans/${scan.id}/data`, { data, engine: 'ocr', rawText: ocrText });
  assert.equal(saved.body.status, 'extracted');
  const items = saved.body.data.items;
  assert.ok(items.find((i: any) => i.name === 'Kajal Pencil Black').productId, 'exact name matched to the catalog');
  assert.equal(items.find((i: any) => i.name === 'Rose Water Toner 200 ml').productId, null, 'unknown item stays unlinked');
  assert.deepEqual(saved.body.data.warnings, [], 'arithmetic checks pass');

  const conv = await call('POST', `/scans/${scan.id}/convert`, { as: 'purchase', payMode: 'credit' });
  assert.equal(conv.status, 201, JSON.stringify(conv.body));
  assert.equal(conv.body.invoice.number, 'BW/26-27/0871');
  assert.equal(conv.body.invoice.totalPaise, 890400);
  assert.equal(conv.body.totalCheck.differencePaise, 0, 'calculated total equals the printed total');
  assert.equal(conv.body.invoice.party.gstin, '27AABCB2222E1Z3', 'supplier created from the bill');
  assert.equal(conv.body.invoice.dueDate, '2026-10-09');
  assert.ok(conv.body.invoice.attachmentId, 'bill photo attached to the purchase');
  assert.equal((await call('POST', `/scans/${scan.id}/convert`, { as: 'purchase' })).status, 409, 'cannot convert twice');
  const gst = (await call('GET', '/reports/gst?month=2026-10')).body.rows.filter((r: any) => r.type === 'purchase' && r.igstPaise > 0);
  assert.ok(gst.length, 'Maharashtra supplier to MP shop is IGST');
  const list = (await call('GET', '/scans')).body;
  assert.equal(list[0].status, 'converted');
});

test('bill scanner: expense bill becomes an expense with the photo attached', { skip }, async () => {
  const up = await app.inject({ method: 'POST', url: '/scans?engine=none', ...multipart('power.png', 'image/png', Buffer.from('fake-image')) });
  const id = up.json().id;
  await call('PUT', `/scans/${id}/data`, { engine: 'manual', data: { kind: 'expense', vendor: { name: 'Power Co' }, billNo: 'E-77', date: '2026-10-05', category: 'Electricity', items: [{ name: 'Electricity', qty: 1, rate: 4000, amount: 4720 }], taxTotal: 720, total: 4720 } });
  const r = await call('POST', `/scans/${id}/convert`, { as: 'expense', payMode: 'upi' });
  assert.equal(r.status, 201);
  assert.equal(r.body.payment.amountPaise, 472000);
  assert.equal(r.body.payment.taxPaise, 72000);
  assert.equal(r.body.payment.category, 'Electricity');
  assert.ok(r.body.payment.attachmentId);
  const ex = (await call('GET', '/insights/expenses?from=2026-10-01&to=2026-10-31')).body;
  assert.ok(ex.items.some((x: any) => x.amountPaise === 472000));
});

test('web app is served at /', { skip }, async () => {
  const r = await app.inject({ method: 'GET', url: '/' });
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /Bill Scanner/);
  assert.equal((await app.inject({ method: 'GET', url: '/sample-bill.png' })).headers['content-type'], 'image/png');
});

/* ---------------- editing existing data ---------------- */

test('editing a bill re-applies stock and balances; edit twice then cancel restores stock exactly', { skip }, async () => {
  const p = await call('POST', '/products', { name: 'Edit test soap', costPaise: 2000, pricePaise: 3000, openingStock: 50 });
  const stock = async () => (await call('GET', `/products/${p.body.id}`)).body.stock;
  const bal = async () => (await call('GET', `/parties/${ids.buyer}`)).body.balancePaise;
  const balBefore = await bal();
  const bill = (q: number, paid?: number) => ({ type: 'sale', partyId: ids.buyer, date: '2026-10-02', payMode: 'credit', ...(paid != null ? { payMode: 'cash', paidPaise: paid } : {}), lines: [{ productId: p.body.id, qty: q, ratePaise: 3000 }] });
  const created = await call('POST', '/invoices', bill(5));
  assert.equal(await stock(), 45);
  assert.equal(await bal(), balBefore + 15000);

  const e1 = await call('PUT', `/invoices/${created.body.id}`, bill(8));
  assert.equal(e1.status, 200, JSON.stringify(e1.body));
  assert.equal(e1.body.id, created.body.id, 'same bill, edited in place');
  assert.equal(e1.body.number, created.body.number, 'keeps its number');
  assert.equal(e1.body.lines.length, 1);
  assert.equal(await stock(), 42);
  assert.equal(await bal(), balBefore + 24000);

  const e2 = await call('PUT', `/invoices/${created.body.id}`, bill(2, 2000));
  assert.equal(e2.body.totalPaise, 6000);
  assert.equal(await stock(), 48);
  assert.equal(await bal(), balBefore + 4000);

  await call('POST', `/invoices/${created.body.id}/cancel`, { reason: 'test' });
  assert.equal(await stock(), 50, 'back to the starting stock');
  assert.equal(await bal(), balBefore);
  assert.equal((await call('PUT', `/invoices/${created.body.id}`, bill(1))).status, 409, 'cancelled bills cannot be edited');
  const typeChange = await call('POST', '/invoices', bill(1));
  assert.equal((await call('PUT', `/invoices/${typeChange.body.id}`, { ...bill(1), type: 'purchase', partyId: ids.supplier })).status, 400);
});

test('editing payments and expenses', { skip }, async () => {
  const e = await call('POST', '/payments', { kind: 'expense', amountPaise: 10000, category: 'Transport', date: '2026-10-02' });
  const r = await call('PATCH', `/payments/${e.body.id}`, { amountPaise: 12500, category: 'Courier', recurring: true });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.amountPaise, r.body.category, r.body.recurring], [12500, 'Courier', true]);
  assert.equal((await call('PATCH', '/payments/00000000-0000-0000-0000-000000000000', { amountPaise: 1 })).status, 404);
});

test('managing users: role, password reset, removal; categories rename', { skip }, async () => {
  const staff = (await call('GET', '/auth/staff')).body;
  const asha = staff.find((u: any) => u.email === 'asha@example.com');
  assert.equal((await call('PATCH', `/auth/staff/${asha.id}`, { role: 'manager', name: 'Asha Verma' })).status, 200);
  assert.equal((await call('POST', `/auth/staff/${asha.id}/password`, { password: 'newpass123' })).status, 200);
  const login = await call('POST', '/auth/login', { email: 'asha@example.com', password: 'newpass123' }, '');
  assert.equal(login.body.role, 'manager');
  const me = (await call('GET', '/auth/me')).body.user;
  assert.equal((await call('PATCH', `/auth/staff/${me.id}`, { role: 'cashier' })).status, 400, 'owner cannot demote themself');
  assert.equal((await call('DELETE', `/auth/staff/${me.id}`)).status, 400);
  assert.equal((await call('POST', '/auth/me/password', { current: 'wrong', password: 'whatever123' })).status, 400);
  assert.equal((await call('DELETE', `/auth/staff/${asha.id}`)).status, 200);
  assert.equal((await call('POST', '/auth/login', { email: 'asha@example.com', password: 'newpass123' }, '')).status, 403);

  const r = await call('POST', '/products/categories/rename', { from: 'Staples', to: 'Grains & Pulses' });
  assert.ok(r.body.updated >= 1);
  const cats = (await call('GET', '/products/categories')).body.map((x: any) => x.category);
  assert.ok(cats.includes('Grains & Pulses') && !cats.includes('Staples'));
});
