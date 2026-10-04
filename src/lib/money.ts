/**
 * All bill arithmetic lives here as pure functions so it can be unit-tested
 * and reused unchanged by the mobile app (copy this file into the Flutter/JS client
 * or port it line for line).
 *
 * Units: money in integer paise, rates in basis points (1% = 100 bps).
 */

export type InvoiceType = 'sale' | 'purchase' | 'sale_return' | 'purchase_return';

export interface LineInput {
  qty: number;
  ratePaise: number; // per unit, as entered on the bill
  discountBps?: number; // line discount
  gstBps?: number;
}

export interface LineResult {
  taxablePaise: number;
  taxPaise: number;
  totalPaise: number;
}

const round = (n: number) => Math.round(n + Number.EPSILON * Math.sign(n));

/** One bill line. With inclusive pricing the rate already contains GST (MRP style). */
export function calcLine(line: LineInput, taxInclusive: boolean): LineResult {
  const gross = line.qty * line.ratePaise * (1 - (line.discountBps ?? 0) / 10_000);
  const g = (line.gstBps ?? 0) / 10_000;
  if (taxInclusive) {
    const total = round(gross);
    const taxable = round(total / (1 + g));
    return { taxablePaise: taxable, taxPaise: total - taxable, totalPaise: total };
  }
  const taxable = round(gross);
  const tax = round(taxable * g);
  return { taxablePaise: taxable, taxPaise: tax, totalPaise: taxable + tax };
}

export interface BillResult {
  lines: LineResult[];
  taxablePaise: number;
  taxPaise: number;
  discountPaise: number;
  roundOffPaise: number;
  totalPaise: number;
}

/** Whole bill: line totals, bill-level discount, then optional rounding to the nearest rupee. */
export function calcBill(lines: LineInput[], opts: { taxInclusive: boolean; discountPaise?: number; roundToRupee?: boolean }): BillResult {
  const res = lines.map((l) => calcLine(l, opts.taxInclusive));
  const taxable = res.reduce((s, l) => s + l.taxablePaise, 0);
  const tax = res.reduce((s, l) => s + l.taxPaise, 0);
  const discount = Math.max(0, Math.round(opts.discountPaise ?? 0));
  const beforeRound = res.reduce((s, l) => s + l.totalPaise, 0) - discount;
  const total = opts.roundToRupee ? Math.round(beforeRound / 100) * 100 : beforeRound;
  return { lines: res, taxablePaise: taxable, taxPaise: tax, discountPaise: discount, roundOffPaise: total - beforeRound, totalPaise: total };
}

/** Direction of stock for each bill type. */
export const STOCK_SIGN: Record<InvoiceType, 1 | -1> = { sale: -1, purchase: 1, sale_return: 1, purchase_return: -1 };
/** Direction of cash for money paid on the bill (+ money comes in). */
export const CASH_SIGN: Record<InvoiceType, 1 | -1> = { sale: 1, purchase: -1, sale_return: -1, purchase_return: 1 };
/** Effect of the unpaid part on the party balance (+ party owes the shop). */
export const PARTY_SIGN: Record<InvoiceType, 1 | -1> = { sale: 1, purchase: -1, sale_return: -1, purchase_return: 1 };

export type PaymentKind = 'payment_in' | 'payment_out' | 'expense' | 'income' | 'deposit' | 'withdraw';
/** Effect of a payment on a party balance. */
export const PAYMENT_PARTY_SIGN: Partial<Record<PaymentKind, 1 | -1>> = { payment_in: -1, payment_out: 1 };

export type PayMode = 'cash' | 'upi' | 'card' | 'bank' | 'credit';
export const accountOf = (mode: PayMode): 'cash' | 'bank' | null => (mode === 'credit' ? null : mode === 'cash' ? 'cash' : 'bank');

/** Effect of a payment row on the cash and bank accounts. */
export function paymentAccountEffect(kind: PaymentKind, mode: PayMode, amount: number): { cash: number; bank: number } {
  if (kind === 'deposit') return { cash: -amount, bank: amount };
  if (kind === 'withdraw') return { cash: amount, bank: -amount };
  const sign = kind === 'payment_in' || kind === 'income' ? 1 : -1;
  return accountOf(mode) === 'cash' ? { cash: sign * amount, bank: 0 } : { cash: 0, bank: sign * amount };
}

/** "₹1,234.50" for logs, exports and messages. */
export function formatINR(paise: number): string {
  return '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Rupees as typed by a person ("1,234.5") → paise. */
export function toPaise(rupees: string | number): number {
  const n = typeof rupees === 'number' ? rupees : parseFloat(String(rupees).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** GST is split CGST+SGST inside a state and IGST across states; the first two GSTIN digits are the state code. */
export function gstSplit(shopGstin: string | null | undefined, partyGstin: string | null | undefined, taxPaise: number) {
  const interState = !!shopGstin && !!partyGstin && shopGstin.slice(0, 2) !== partyGstin.slice(0, 2);
  if (interState) return { cgst: 0, sgst: 0, igst: taxPaise };
  const cgst = Math.floor(taxPaise / 2);
  return { cgst, sgst: taxPaise - cgst, igst: 0 };
}
