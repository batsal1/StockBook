import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';
import { and, asc, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { invoiceLines, invoices, parties, payments, products, stockLevels } from '../db/schema.js';
import { badRequest } from '../lib/errors.js';
import { allow, audit, ctx, defaultBranchId, month, monthRange, parse } from '../lib/http.js';
import { applyStock } from '../lib/stock.js';
import { normalizeBarcode } from '../lib/barcode.js';
import { partyBalances } from '../lib/ledger.js';
import { toPaise } from '../lib/money.js';

/** Column names people actually use in Indian shop spreadsheets → our fields. */
const HEADER_MAP: Record<string, string[]> = {
  name: ['name', 'product', 'product name', 'item', 'item name', 'particulars', 'description of goods', 'description'],
  barcode: ['barcode', 'bar code', 'ean', 'upc', 'gtin', 'ean code'],
  sku: ['sku', 'item code', 'code', 'product code'],
  brand: ['brand', 'company', 'manufacturer', 'mfr'],
  category: ['category', 'group', 'department', 'type', 'item group'],
  unit: ['unit', 'uom'],
  hsn: ['hsn', 'hsn code', 'hsn sac', 'hsn/sac'],
  gst: ['gst', 'gst %', 'gst rate', 'tax', 'tax %', 'tax rate', 'gst%'],
  cost: ['cost', 'cost price', 'purchase price', 'purchase rate', 'buying price', 'cp', 'p rate'],
  price: ['price', 'selling price', 'sale price', 'sp', 'rate', 'retail price', 's rate'],
  wholesale: ['wholesale', 'wholesale price', 'wholesale rate', 'dealer price'],
  mrp: ['mrp', 'm r p', 'max retail price'],
  stock: ['stock', 'qty', 'quantity', 'opening stock', 'closing stock', 'balance qty', 'current stock'],
  reorder: ['reorder', 'reorder level', 'min stock', 'minimum stock'],
  location: ['location', 'rack', 'shelf', 'bin'],
  batch: ['batch', 'batch no', 'batch number'],
  expiry: ['expiry', 'expiry date', 'exp', 'exp date', 'best before'],
};
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9%/]+/g, ' ').trim();
const fieldFor = (header: string) => Object.entries(HEADER_MAP).find(([, names]) => names.includes(norm(header)))?.[0] ?? null;

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue);
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return String(v.text);
    return '';
  }
  return String(v).trim();
}
function toDate(s: string): string | null {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/); // Indian day-first dates
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const my = s.match(/^(\d{1,2})[/\-.](\d{4})$/); // MM/YYYY on medicine strips → end of month
  if (my) { const last = new Date(Date.UTC(+my[2], +my[1], 0)).getUTCDate(); return `${my[2]}-${my[1].padStart(2, '0')}-${last}`; }
  return null;
}

async function readSheet(buf: Buffer, filename: string) {
  const wb = new ExcelJS.Workbook();
  if (/\.csv$/i.test(filename)) await wb.csv.read(Readable.from(buf));
  else await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) throw badRequest('The file has no sheets');
  const headers = ((ws.getRow(1).values as ExcelJS.CellValue[]) ?? []).slice(1).map(cellText);
  const rows: Record<string, string>[] = [];
  ws.eachRow((row, i) => {
    if (i === 1) return;
    const vals = (row.values as ExcelJS.CellValue[]).slice(1);
    const o: Record<string, string> = {};
    headers.forEach((h, k) => { if (h) o[h] = cellText(vals[k]); });
    if (Object.values(o).some(Boolean)) rows.push(o);
  });
  return { headers, rows };
}

const routes: FastifyPluginAsync = async (app) => {
  /**
   * Import products. POST multipart "file" (.xlsx or .csv).
   *   ?commit=false (default) → preview: column mapping, counts, first rows. Nothing is saved.
   *   ?commit=true            → saves. Matches existing products by barcode, then SKU.
   *   ?stockMode=opening      → stock column sets opening stock for new products only (default)
   *   ?stockMode=set          → stock column is a stock count: existing products are adjusted to match it
   */
  app.post('/products/import', { preHandler: allow('owner', 'manager') }, async (req) => {
    const c = ctx(req);
    const q = parse(z.object({ commit: z.enum(['true', 'false']).default('false'), stockMode: z.enum(['opening', 'set']).default('opening') }), req.query);
    const file = await req.file();
    if (!file) throw badRequest('Send the spreadsheet in a multipart field named "file"');
    const { headers, rows } = await readSheet(await file.toBuffer(), file.filename);
    const mapping = Object.fromEntries(headers.filter(Boolean).map((h) => [h, fieldFor(h)]));
    if (!Object.values(mapping).includes('name')) throw badRequest('No product name column found. Name one column "Name" or "Product".', { headers });

    const items = rows.map((r, i) => {
      const o: Record<string, string> = {}; const attrs: Record<string, string> = {};
      for (const [h, v] of Object.entries(r)) { const f = mapping[h]; if (!v) continue; if (f) o[f] = v; else attrs[norm(h).replace(/ /g, '_')] = v; }
      return {
        row: i + 2, name: o.name?.trim() ?? '', barcode: o.barcode ? normalizeBarcode(o.barcode.replace(/\.0$/, '')) : null, sku: o.sku || null,
        brand: o.brand || null, category: o.category || null, unit: o.unit || 'pcs', hsn: o.hsn || null,
        gstBps: o.gst ? Math.round(parseFloat(o.gst.replace('%', '')) * 100) : undefined,
        costPaise: o.cost ? toPaise(o.cost) : undefined, pricePaise: o.price ? toPaise(o.price) : undefined,
        wholesalePaise: o.wholesale ? toPaise(o.wholesale) : undefined, mrpPaise: o.mrp ? toPaise(o.mrp) : undefined,
        reorderLevel: o.reorder ? parseFloat(o.reorder) || 0 : undefined, location: o.location || null,
        stock: o.stock !== undefined ? parseFloat(o.stock) : undefined, batchNo: o.batch || null, expiry: toDate(o.expiry ?? ''), attrs,
      };
    });
    const valid = items.filter((x) => x.name);
    const codes = valid.flatMap((x) => [x.barcode, x.sku]).filter((x): x is string => !!x);
    const existing = codes.length ? await db.select({ id: products.id, barcode: products.barcode, sku: products.sku, trackBatches: products.trackBatches })
      .from(products).where(and(eq(products.shopId, c.shopId), or(inArray(products.barcode, codes), inArray(products.sku, codes)))) : [];
    const match = (x: (typeof valid)[number]) => existing.find((p) => (x.barcode && p.barcode === x.barcode) || (x.sku && p.sku === x.sku));
    const preview = {
      file: file.filename, mapping, totalRows: rows.length, skippedNoName: items.length - valid.length,
      toCreate: valid.filter((x) => !match(x)).length, toUpdate: valid.filter((x) => match(x)).length, sample: valid.slice(0, 20),
    };
    if (q.commit === 'false') return { preview };

    const result = await db.transaction(async (tx) => {
      const branchId = await defaultBranchId(tx, c.shopId);
      let created = 0, updated = 0;
      for (const x of valid) {
        const ex = match(x);
        const fields = Object.fromEntries(Object.entries({
          name: x.name, barcode: x.barcode, sku: x.sku, brand: x.brand, category: x.category, unit: x.unit, hsn: x.hsn, gstBps: x.gstBps,
          costPaise: x.costPaise, pricePaise: x.pricePaise, wholesalePaise: x.wholesalePaise, mrpPaise: x.mrpPaise, reorderLevel: x.reorderLevel, location: x.location,
        }).filter(([, v]) => v !== undefined && v !== null));
        const track = !!(x.batchNo || x.expiry);
        if (ex) {
          await tx.update(products).set({ ...fields, attrs: sql`${products.attrs} || ${JSON.stringify(x.attrs)}::jsonb`, updatedAt: new Date() }).where(eq(products.id, ex.id));
          if (q.stockMode === 'set' && x.stock !== undefined && Number.isFinite(x.stock)) {
            const [lvl] = await tx.select({ qty: stockLevels.qty }).from(stockLevels).where(and(eq(stockLevels.productId, ex.id), eq(stockLevels.branchId, branchId)));
            const delta = x.stock - Number(lvl?.qty ?? 0);
            if (delta) await applyStock(tx, { shopId: c.shopId, branchId, productId: ex.id, qtyChange: delta, reason: 'adjustment', trackBatches: ex.trackBatches, userId: c.userId, note: 'Stock count from Excel', batchNo: delta > 0 ? x.batchNo : undefined, expiry: x.expiry });
          }
          updated++;
        } else {
          const [p] = await tx.insert(products).values({ ...(fields as { name: string }), shopId: c.shopId, attrs: x.attrs, trackBatches: track }).returning();
          if (x.stock && x.stock > 0) await applyStock(tx, { shopId: c.shopId, branchId, productId: p.id, qtyChange: x.stock, reason: 'opening', trackBatches: track, userId: c.userId, batchNo: x.batchNo ?? (track ? 'OPENING' : undefined), expiry: x.expiry, unitCostPaise: p.costPaise });
          created++;
        }
      }
      await audit(tx, c, 'import', 'products', null, { file: file.filename, created, updated });
      return { created, updated };
    });
    return { preview, ...result };
  });

  /**
   * Import customers and suppliers. Columns: Name, Type (customer / wholesale / supplier), Phone, Email, GSTIN, Address,
   * Credit limit, Payment terms (days), Opening balance (+ they owe you, − you owe them). Matches existing parties by GSTIN, then phone.
   */
  app.post('/parties/import', { preHandler: allow('owner', 'manager') }, async (req) => {
    const c = ctx(req);
    const q = parse(z.object({ commit: z.enum(['true', 'false']).default('false') }), req.query);
    const file = await req.file();
    if (!file) throw badRequest('Send the spreadsheet in a multipart field named "file"');
    const { headers, rows } = await readSheet(await file.toBuffer(), file.filename);
    const MAP: Record<string, string[]> = {
      name: ['name', 'party', 'party name', 'customer', 'customer name', 'supplier', 'supplier name', 'firm', 'company'],
      type: ['type', 'party type', 'category', 'group'], phone: ['phone', 'mobile', 'contact', 'phone no', 'mobile no', 'whatsapp'],
      email: ['email', 'e mail', 'mail'], gstin: ['gstin', 'gst', 'gst no', 'gstin no', 'gst number'], address: ['address', 'city', 'location'],
      limit: ['credit limit', 'limit'], terms: ['terms', 'payment terms', 'credit days', 'due days'], opening: ['opening', 'opening balance', 'balance', 'outstanding'],
    };
    const mapping = Object.fromEntries(headers.filter(Boolean).map((h) => [h, Object.entries(MAP).find(([, n]) => n.includes(norm(h)))?.[0] ?? null]));
    if (!Object.values(mapping).includes('name')) throw badRequest('No name column found. Name one column "Name".', { headers });
    const typeOf = (t: string) => (/supp|vendor|distrib|purchase/i.test(t) ? 'supplier' : /whole|dealer|retailer|b2b|shop/i.test(t) ? 'wholesale' : 'retail') as 'supplier' | 'wholesale' | 'retail';
    const gstOk = (g: string) => /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/.test(g);
    const items = rows.map((r) => {
      const o: Record<string, string> = {};
      for (const [h, v] of Object.entries(r)) if (mapping[h] && v) o[mapping[h]!] = v;
      const gstin = (o.gstin || '').toUpperCase().replace(/\s/g, '');
      return {
        name: (o.name || '').trim(), type: typeOf(o.type || ''), phone: o.phone || null, email: o.email || null, gstin: gstOk(gstin) ? gstin : null,
        badGstin: gstin && !gstOk(gstin) ? gstin : null, address: o.address || null,
        creditLimitPaise: o.limit ? toPaise(o.limit) : null, paymentTermsDays: o.terms ? parseInt(o.terms) || null : null, openingBalancePaise: o.opening ? toPaise(o.opening) : 0,
      };
    }).filter((x) => x.name);
    const existing = await db.select({ id: parties.id, gstin: parties.gstin, phone: parties.phone }).from(parties).where(eq(parties.shopId, c.shopId));
    const match = (x: (typeof items)[number]) => existing.find((p) => (x.gstin && p.gstin === x.gstin) || (x.phone && p.phone && p.phone.replace(/\D/g, '') === x.phone.replace(/\D/g, '')));
    const preview = { file: file.filename, mapping, totalRows: rows.length, toCreate: items.filter((x) => !match(x)).length, toUpdate: items.filter((x) => match(x)).length, invalidGstins: items.filter((x) => x.badGstin).map((x) => `${x.name}: ${x.badGstin}`), sample: items.slice(0, 20) };
    if (q.commit === 'false') return { preview };
    let created = 0, updated = 0;
    await db.transaction(async (tx) => {
      for (const { badGstin, ...x } of items) {
        const ex = match({ badGstin, ...x });
        if (ex) { await tx.update(parties).set(x).where(eq(parties.id, ex.id)); updated++; }
        else { await tx.insert(parties).values({ ...x, shopId: c.shopId }); created++; }
      }
      await audit(tx, c, 'import', 'parties', null, { file: file.filename, created, updated });
    });
    return { preview, created, updated };
  });

  /** A blank import sheet with the recommended columns. */
  app.get('/products/template', async (_req, reply) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Products');
    ws.columns = ['Name', 'Barcode', 'SKU', 'Brand', 'Category', 'Unit', 'HSN', 'GST %', 'Cost', 'Price', 'Wholesale', 'MRP', 'Stock', 'Reorder level', 'Location', 'Batch', 'Expiry']
      .map((h) => ({ header: h, key: h, width: h === 'Name' ? 32 : 14 }));
    ws.addRow({ Name: 'Toor dal 1 kg', Barcode: '8901234500028', Category: 'Staples', Unit: 'pcs', HSN: '0713', 'GST %': 5, Cost: 128, Price: 145, Wholesale: 138, MRP: 155, Stock: 40, 'Reorder level': 10, Location: 'Rack 1' });
    ws.getRow(1).font = { bold: true };
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('Content-Disposition', 'attachment; filename="stockbook-import-template.xlsx"');
    return reply.send(Buffer.from(await wb.xlsx.writeBuffer()));
  });

  /** Full workbook for the accountant or a backup: products, bills, lines, parties with balances, payments. */
  app.get('/export', { preHandler: allow('owner', 'manager') }, async (req, reply) => {
    const c = ctx(req);
    const { month: m } = parse(z.object({ month: month.optional() }), req.query);
    const [from, to] = m ? monthRange(m) : ['1900-01-01', '2999-12-31'];
    const rupees = (p: number | null | undefined) => (p == null ? null : p / 100);
    const wb = new ExcelJS.Workbook();
    const sheet = (name: string, rows: Record<string, unknown>[]) => {
      const ws = wb.addWorksheet(name);
      const keys = rows.length ? Object.keys(rows[0]) : ['No data'];
      ws.columns = keys.map((k) => ({ header: k, key: k, width: Math.max(12, Math.min(40, k.length + 4)) }));
      rows.forEach((r) => ws.addRow(r));
      ws.getRow(1).font = { bold: true };
      ws.views = [{ state: 'frozen', ySplit: 1 }];
    };

    const prods = await db.execute(sql`
      select p.*, coalesce((select sum(qty) from stock_levels s where s.product_id = p.id), 0) as stock
      from products p where p.shop_id = ${c.shopId} and p.is_active order by p.name`);
    sheet('Products', (prods.rows as Record<string, any>[]).map((p) => ({
      Name: p.name, Barcode: p.barcode, SKU: p.sku, Brand: p.brand, Category: p.category, Unit: p.unit, HSN: p.hsn, 'GST %': p.gst_bps / 100,
      Cost: rupees(Number(p.cost_paise)), Price: rupees(Number(p.price_paise)), Wholesale: rupees(p.wholesale_paise == null ? null : Number(p.wholesale_paise)),
      MRP: rupees(p.mrp_paise == null ? null : Number(p.mrp_paise)), Stock: Number(p.stock), 'Reorder level': Number(p.reorder_level), Location: p.location,
      'Stock value at cost': rupees(Math.round(Number(p.stock) * Number(p.cost_paise))), ...p.attrs,
    })));

    const bills = await db.select({ inv: invoices, party: parties.name, gstin: parties.gstin }).from(invoices).leftJoin(parties, eq(parties.id, invoices.partyId))
      .where(and(eq(invoices.shopId, c.shopId), gte(invoices.date, from), lte(invoices.date, to))).orderBy(asc(invoices.date), asc(invoices.createdAt));
    sheet('Bills', bills.map(({ inv, party, gstin }) => ({
      Date: inv.date, Type: inv.type, Number: inv.number, Party: party, 'Party GSTIN': gstin, Taxable: rupees(inv.taxablePaise), GST: rupees(inv.taxPaise),
      Discount: rupees(inv.discountPaise), 'Round off': rupees(inv.roundOffPaise), Total: rupees(inv.totalPaise), Paid: rupees(inv.paidPaise), Mode: inv.payMode, Status: inv.status,
    })));

    const ids = bills.map((b) => b.inv.id);
    const lines = ids.length ? await db.select().from(invoiceLines).where(inArray(invoiceLines.invoiceId, ids)) : [];
    const billById = new Map(bills.map((b) => [b.inv.id, b]));
    sheet('Bill lines', lines.map((l) => {
      const b = billById.get(l.invoiceId)!;
      return {
        Date: b.inv.date, Type: b.inv.type, Number: b.inv.number, Party: b.party, Item: l.name, HSN: l.hsn, Qty: l.qty, Rate: rupees(l.ratePaise),
        'Disc %': l.discountBps / 100, 'GST %': l.gstBps / 100, Taxable: rupees(l.taxablePaise), GST: rupees(l.taxPaise), Amount: rupees(l.totalPaise),
        'Unit cost': rupees(l.unitCostPaise), Batch: l.batchNo, Expiry: l.expiry, Status: b.inv.status,
      };
    }));

    const bal = await partyBalances(db, c.shopId);
    const ps = await db.select().from(parties).where(eq(parties.shopId, c.shopId)).orderBy(asc(parties.name));
    sheet('Parties', ps.map((p) => {
      const b = bal.get(p.id) ?? 0;
      return { Name: p.name, Type: p.type, Phone: p.phone, GSTIN: p.gstin, Address: p.address, 'They owe you': b > 0 ? b / 100 : 0, 'You owe them': b < 0 ? -b / 100 : 0 };
    }));

    const pays = await db.select({ p: payments, party: parties.name }).from(payments).leftJoin(parties, eq(parties.id, payments.partyId))
      .where(and(eq(payments.shopId, c.shopId), gte(payments.date, from), lte(payments.date, to))).orderBy(asc(payments.date));
    sheet('Payments & expenses', pays.map(({ p, party }) => ({ Date: p.date, Kind: p.kind, Amount: rupees(p.amountPaise), Mode: p.mode, Party: party, Head: p.category, Note: p.note })));

    const name = `stockbook-${m ?? 'all'}.xlsx`;
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('Content-Disposition', `attachment; filename="${name}"`);
    return reply.send(Buffer.from(await wb.xlsx.writeBuffer()));
  });
};

export default routes;
