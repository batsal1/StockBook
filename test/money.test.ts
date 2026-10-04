import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcBill, calcLine, gstSplit, paymentAccountEffect, toPaise } from '../src/lib/money.ts';
import { isValidGtin, normalizeBarcode } from '../src/lib/barcode.ts';

test('GST-inclusive line splits MRP into taxable value and tax', () => {
  // ₹145 × 2 at 5% inclusive = ₹290 total, ₹276.19 taxable, ₹13.81 GST
  assert.deepEqual(calcLine({ qty: 2, ratePaise: 14500, gstBps: 500 }, true), { taxablePaise: 27619, taxPaise: 1381, totalPaise: 29000 });
});

test('GST-exclusive line adds tax on top', () => {
  assert.deepEqual(calcLine({ qty: 10, ratePaise: 12800, gstBps: 500 }, false), { taxablePaise: 128000, taxPaise: 6400, totalPaise: 134400 });
});

test('line discount applies before tax', () => {
  assert.equal(calcLine({ qty: 1, ratePaise: 10000, discountBps: 1000, gstBps: 1800 }, false).totalPaise, 10620);
});

test('loose quantities work', () => {
  assert.equal(calcLine({ qty: 1.25, ratePaise: 8000, gstBps: 0 }, true).totalPaise, 10000);
});

test('bill rounds to the nearest rupee and records the round-off', () => {
  const b = calcBill([{ qty: 3, ratePaise: 3333, gstBps: 1800 }], { taxInclusive: true, roundToRupee: true });
  assert.equal(b.totalPaise, 10000);
  assert.equal(b.roundOffPaise, 1);
});

test('bill-level discount reduces the total', () => {
  const b = calcBill([{ qty: 1, ratePaise: 50000, gstBps: 500 }], { taxInclusive: true, discountPaise: 2000, roundToRupee: true });
  assert.equal(b.totalPaise, 48000);
});

test('GST splits into CGST + SGST inside a state and IGST across states', () => {
  assert.deepEqual(gstSplit('23AAAAA0000A1Z5', '23BBBBB0000B1Z5', 1001), { cgst: 500, sgst: 501, igst: 0 });
  assert.deepEqual(gstSplit('23AAAAA0000A1Z5', '27BBBBB0000B1Z5', 1001), { cgst: 0, sgst: 0, igst: 1001 });
  assert.deepEqual(gstSplit('23AAAAA0000A1Z5', null, 1000), { cgst: 500, sgst: 500, igst: 0 });
});

test('payments move cash and bank correctly', () => {
  assert.deepEqual(paymentAccountEffect('expense', 'cash', 500), { cash: -500, bank: 0 });
  assert.deepEqual(paymentAccountEffect('payment_in', 'upi', 500), { cash: 0, bank: 500 });
  assert.deepEqual(paymentAccountEffect('deposit', 'cash', 500), { cash: -500, bank: 500 });
});

test('rupees typed by people convert to paise', () => {
  assert.equal(toPaise('1,234.50'), 123450);
  assert.equal(toPaise(0.1 + 0.2), 30);
});

test('barcode check digits', () => {
  assert.equal(isValidGtin('4006381333931'), true); // EAN-13
  assert.equal(isValidGtin('4006381333932'), false);
  assert.equal(isValidGtin('036000291452'), true); // UPC-A
  assert.equal(isValidGtin('96385074'), true); // EAN-8
  assert.equal(normalizeBarcode(' 0036000291452 '), '036000291452');
});
