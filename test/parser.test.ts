/**
 * The free on-device bill reader (parseBillText in public/index.html) on real OCR output of four kinds of bill:
 * a clean GST invoice, a kirana bill photographed on a phone, a wide GST invoice with per-line tax columns,
 * and a narrow thermal receipt with no rate column. Each bill's lines must add up to its printed total.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync('public/index.html', 'utf8');
const src = html.slice(html.indexOf('function parseBillText'), html.indexOf('/* ================= bill scanner ================= */'));
const parseBillText = new Function(src + '; return parseBillText;')() as (t: string, g?: string, h?: string) => any;
const fx = (n: string) => readFileSync('test/fixtures/' + n, 'utf8');
const SHOP = '23ABCDE1234F1Z5';
const linesTotal = (r: any) => r.items.reduce((s: number, i: any) => s + i.qty * i.rate * (1 - (i.discount || 0) / 100) * (1 + (i.gstRate || 0) / 100), 0);

test('clean GST invoice', () => {
  const r = parseBillText(fx('sample-bill-ocr.txt'), SHOP);
  assert.equal(r.vendor.name, 'BEAUTY WORLD PVT LTD');
  assert.equal(r.vendor.gstin, '27AABCB2222E1Z3');
  assert.deepEqual([r.billNo, r.date, r.dueDate, r.total], ['BW/26-27/0871', '2026-10-02', '2026-10-09', 8904]);
  assert.deepEqual(r.items.map((i: any) => i.name), ['Kajal Pencil Black', 'Matte Lipstick Rose', 'Neem Face Wash 100 ml', 'Rose Water Toner 200 ml']);
  assert.ok(Math.abs(linesTotal(r) - r.total) < 1);
});

test('kirana bill photographed on a phone (raw OCR, with misreads)', () => {
  const r = parseBillText(fx('kirana-photo-ocr.txt'), SHOP);
  assert.equal(r.vendor.gstin, '23AAKFS4521M1ZQ', 'GSTIN split by a space and "Z" read as "2"');
  assert.equal(r.date, '2026-09-28', 'date with a month name');
  assert.equal(r.items.length, 6);
  assert.deepEqual(r.unparsedLines, []);
  const salt = r.items.find((i: any) => /salt/i.test(i.name));
  assert.equal(salt.rate, 22.5, 'decimal point the OCR dropped (2250 → 22.50)');
  const rice = r.items.find((i: any) => /basmati/i.test(i.name));
  assert.equal(rice.qty, 4, 'quantity the OCR lost, worked out from rate and amount');
  assert.equal(r.items.find((i: any) => /sunflower/i.test(i.name)).discount, 2);
  assert.match(r.items[0].name, /\(1 kg pouch\)/, 'wrapped description joined');
  assert.ok(Math.abs(linesTotal(r) - r.total) < 1, `lines ${linesTotal(r)} vs total ${r.total}`);
});

test('same photo after clean-up, with the header read separately', () => {
  const r = parseBillText(fx('kirana-photo-cleaned-ocr.txt'), SHOP, fx('kirana-photo-cleaned-top-ocr.txt'));
  assert.equal(r.vendor.name, 'SHREE GANESH TRADERS');
  assert.equal(r.billNo, 'SGT/1187');
  assert.equal(r.items.length, 6);
  assert.equal(r.items.find((i: any) => /basmati/i.test(i.name)).unit, 'bag');
  assert.ok(Math.abs(linesTotal(r) - r.total) < 1);
});

test('wide GST invoice with a different column order and per-line CGST/SGST', () => {
  const r = parseBillText(fx('wide-gst-ocr.txt'), SHOP);
  assert.equal(r.vendor.name, 'Glow Cosmetics Distributors LLP');
  assert.deepEqual([r.billNo, r.date, r.total], ['GCD-2026-0456', '2026-10-01', 10338]);
  assert.equal(r.items.length, 5);
  assert.deepEqual(r.items.map((i: any) => i.gstRate), [18, 18, 18, 5, 12]);
  assert.deepEqual(r.items.map((i: any) => i.hsn), ['3304', '3304', '3305', '3304', '6217']);
  assert.equal(r.items[2].name, 'Herbal Shampoo 340 ml');
  assert.equal(r.items[3].name, 'Bridal Bindi Set', '"Set" is part of the name, not a unit');
  assert.ok(Math.abs(linesTotal(r) - r.total) < 1);
});

test('thermal receipt with only quantity and amount, prices including GST', () => {
  const r = parseBillText(fx('thermal-receipt-ocr.txt'), SHOP);
  assert.deepEqual([r.vendor.name, r.billNo, r.total], ['CITY PACKAGING STORE', '4521', 1273]);
  assert.equal(r.items.length, 4);
  assert.ok(r.items.every((i: any) => i.gstRate === 18));
  assert.ok(Math.abs(linesTotal(r) - r.total) < 1, 'rates converted to before-GST so totals still match');
});

test('expense bill and junk text', () => {
  const e = parseBillText('MP Paschim Kshetra Vidyut Vitaran\nElectricity Bill\nBill No: 87766512 Bill Date: 05/10/2026\nDue Date: 15/10/2026\nTotal Amount Payable 4,620.00', SHOP);
  assert.deepEqual([e.kind, e.category, e.total, e.dueDate], ['expense', 'Electricity', 4620, '2026-10-15']);
  const j = parseBillText('', SHOP);
  assert.equal(j.items.length, 0);
});
