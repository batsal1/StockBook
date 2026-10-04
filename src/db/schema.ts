/**
 * Stockbook database schema.
 *
 * Conventions
 *  - Every business table carries shop_id: one database safely serves many shops (multi-tenant).
 *  - Money is stored as integer paise (₹1 = 100) to avoid floating-point rounding errors.
 *  - Tax rates are stored as basis points (5% = 500, 0.25% = 25).
 *  - Quantities are numeric(14,3) so loose goods (1.250 kg) work.
 *  - Stock is never edited directly: every change writes a stock_movements row and
 *    updates the cached stock_levels row in the same transaction.
 */
import { sql } from 'drizzle-orm';
import {
  pgTable, pgEnum, uuid, text, boolean, integer, bigint, numeric, date, timestamp, jsonb,
  primaryKey, index, uniqueIndex,
} from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const money = (name: string) => bigint(name, { mode: 'number' });
const qty = (name: string) => numeric(name, { precision: 14, scale: 3, mode: 'number' });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const roleEnum = pgEnum('role', ['owner', 'manager', 'cashier']);
export const partyTypeEnum = pgEnum('party_type', ['supplier', 'wholesale', 'retail']);
export const invoiceTypeEnum = pgEnum('invoice_type', ['sale', 'purchase', 'sale_return', 'purchase_return']);
export const payModeEnum = pgEnum('pay_mode', ['cash', 'upi', 'card', 'bank', 'credit']);
export const paymentKindEnum = pgEnum('payment_kind', ['payment_in', 'payment_out', 'expense', 'income', 'deposit', 'withdraw']);
export const movementReasonEnum = pgEnum('movement_reason', ['sale', 'purchase', 'sale_return', 'purchase_return', 'adjustment', 'opening', 'cancel']);
export const invoiceStatusEnum = pgEnum('invoice_status', ['active', 'cancelled']);

/* ---------- tenancy & people ---------- */

export const shops = pgTable('shops', {
  id: id(),
  name: text('name').notNull(),
  shopType: text('shop_type').notNull().default('general'), // grocery | cosmetics | pharmacy | apparel | electronics | hardware | stationery | general
  gstin: text('gstin'),
  address: text('address'),
  phone: text('phone'),
  taxInclusive: boolean('tax_inclusive').notNull().default(true), // prices include GST (MRP style)
  roundToRupee: boolean('round_to_rupee').notNull().default(true),
  openingCashPaise: money('opening_cash_paise').notNull().default(0),
  openingBankPaise: money('opening_bank_paise').notNull().default(0),
  extraFields: jsonb('extra_fields').$type<string[]>().notNull().default([]),
  email: text('email'),
  invoicePrefix: text('invoice_prefix'), // e.g. "INV-2026-"; empty = S/2026-27/0001 style
  defaultGstBps: integer('default_gst_bps').notNull().default(0),
  paymentTermsDays: integer('payment_terms_days').notNull().default(0), // default credit period for customers
  expiryWarnDays: integer('expiry_warn_days').notNull().default(30),
  allowNegativeStock: boolean('allow_negative_stock').notNull().default(true),
  costMethod: text('cost_method').notNull().default('latest'), // latest | average (weighted average)
  fixedAssetsPaise: money('fixed_assets_paise').notNull().default(0), // furniture, fittings, equipment for the balance sheet
  createdAt: createdAt(),
});

export const users = pgTable('users', {
  id: id(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  phone: text('phone'),
  passwordHash: text('password_hash').notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('users_email_uq').on(sql`lower(${t.email})`)]);

export const memberships = pgTable('memberships', {
  id: id(),
  shopId: uuid('shop_id').notNull().references(() => shops.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: roleEnum('role').notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('memberships_shop_user_uq').on(t.shopId, t.userId)]);

export const branches = pgTable('branches', {
  id: id(),
  shopId: uuid('shop_id').notNull().references(() => shops.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: createdAt(),
});

/* ---------- catalog & stock ---------- */

export const products = pgTable('products', {
  id: id(),
  shopId: uuid('shop_id').notNull().references(() => shops.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  barcode: text('barcode'),
  sku: text('sku'),
  brand: text('brand'),
  category: text('category'),
  unit: text('unit').notNull().default('pcs'),
  hsn: text('hsn'),
  gstBps: integer('gst_bps').notNull().default(0),
  costPaise: money('cost_paise').notNull().default(0), // latest purchase cost, excluding GST
  pricePaise: money('price_paise').notNull().default(0), // retail selling price
  wholesalePaise: money('wholesale_paise'),
  mrpPaise: money('mrp_paise'),
  reorderLevel: qty('reorder_level').notNull().default(0),
  location: text('location'),
  trackBatches: boolean('track_batches').notNull().default(false), // batch + expiry, FIFO by expiry
  attrs: jsonb('attrs').$type<Record<string, string>>().notNull().default({}), // shade, size, salt, colour…
  isActive: boolean('is_active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('products_shop_barcode_uq').on(t.shopId, t.barcode).where(sql`${t.barcode} is not null`),
  uniqueIndex('products_shop_sku_uq').on(t.shopId, t.sku).where(sql`${t.sku} is not null`),
  index('products_shop_idx').on(t.shopId, t.isActive),
  // typo-tolerant search ("shampo" → "shampoo") using the pg_trgm extension
  index('products_name_trgm').using('gin', sql`${t.name} gin_trgm_ops`),
  index('products_brand_trgm').using('gin', sql`${t.brand} gin_trgm_ops`),
]);

export const stockLevels = pgTable('stock_levels', {
  shopId: uuid('shop_id').notNull().references(() => shops.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  branchId: uuid('branch_id').notNull().references(() => branches.id, { onDelete: 'cascade' }),
  qty: qty('qty').notNull().default(0),
}, (t) => [primaryKey({ columns: [t.productId, t.branchId] })]);

export const batches = pgTable('batches', {
  id: id(),
  shopId: uuid('shop_id').notNull().references(() => shops.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  branchId: uuid('branch_id').notNull().references(() => branches.id, { onDelete: 'cascade' }),
  batchNo: text('batch_no').notNull(),
  expiry: date('expiry', { mode: 'string' }),
  qty: qty('qty').notNull().default(0),
  costPaise: money('cost_paise').notNull().default(0),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('batches_uq').on(t.productId, t.branchId, t.batchNo),
  index('batches_expiry_idx').on(t.shopId, t.expiry),
]);

export const stockMovements = pgTable('stock_movements', {
  id: id(),
  shopId: uuid('shop_id').notNull().references(() => shops.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  branchId: uuid('branch_id').notNull().references(() => branches.id),
  batchId: uuid('batch_id').references(() => batches.id),
  qtyChange: qty('qty_change').notNull(),
  reason: movementReasonEnum('reason').notNull(),
  invoiceId: uuid('invoice_id'),
  note: text('note'),
  userId: uuid('user_id'),
  createdAt: createdAt(),
}, (t) => [index('movements_product_idx').on(t.productId, t.createdAt), index('movements_invoice_idx').on(t.invoiceId)]);

/** Shared product master across all shops: grows every time any shop identifies a barcode. */
export const globalProducts = pgTable('global_products', {
  barcode: text('barcode').primaryKey(),
  name: text('name').notNull(),
  brand: text('brand'),
  category: text('category'),
  unit: text('unit'),
  size: text('size'),
  hsn: text('hsn'),
  gstBps: integer('gst_bps'),
  mrpPaise: money('mrp_paise'),
  imageUrl: text('image_url'),
  source: text('source').notNull(), // shop | openfoodfacts | openbeautyfacts | upcitemdb | ...
  confirmations: integer('confirmations').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ---------- parties, bills, money ---------- */

export const parties = pgTable('parties', {
  id: id(),
  shopId: uuid('shop_id').notNull().references(() => shops.id, { onDelete: 'cascade' }),
  type: partyTypeEnum('type').notNull(),
  name: text('name').notNull(),
  phone: text('phone'),
  gstin: text('gstin'),
  address: text('address'),
  openingBalancePaise: money('opening_balance_paise').notNull().default(0), // + they owe the shop, − shop owes them
  email: text('email'),
  creditLimitPaise: money('credit_limit_paise'), // null = no limit
  paymentTermsDays: integer('payment_terms_days'), // null = shop default
  isActive: boolean('is_active').notNull().default(true),
  createdAt: createdAt(),
}, (t) => [index('parties_shop_idx').on(t.shopId, t.type), index('parties_name_trgm').using('gin', sql`${t.name} gin_trgm_ops`)]);

export const attachments = pgTable('attachments', {
  id: id(),
  shopId: uuid('shop_id').notNull().references(() => shops.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  mime: text('mime').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  storageKey: text('storage_key').notNull(),
  uploadedBy: uuid('uploaded_by'),
  createdAt: createdAt(),
});

export const invoices = pgTable('invoices', {
  id: id(),
  shopId: uuid('shop_id').notNull().references(() => shops.id, { onDelete: 'cascade' }),
  branchId: uuid('branch_id').notNull().references(() => branches.id),
  type: invoiceTypeEnum('type').notNull(),
  number: text('number').notNull(),
  date: date('date', { mode: 'string' }).notNull(),
  dueDate: date('due_date', { mode: 'string' }),
  partyId: uuid('party_id').references(() => parties.id),
  clientRef: text('client_ref'), // set by offline apps so a retried sync never creates a duplicate bill
  taxInclusive: boolean('tax_inclusive').notNull(),
  taxablePaise: money('taxable_paise').notNull(),
  taxPaise: money('tax_paise').notNull(),
  discountPaise: money('discount_paise').notNull().default(0),
  roundOffPaise: money('round_off_paise').notNull().default(0),
  totalPaise: money('total_paise').notNull(),
  paidPaise: money('paid_paise').notNull().default(0),
  payMode: payModeEnum('pay_mode').notNull(),
  notes: text('notes'),
  attachmentId: uuid('attachment_id').references(() => attachments.id),
  status: invoiceStatusEnum('status').notNull().default('active'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('invoices_client_ref_uq').on(t.shopId, t.clientRef).where(sql`${t.clientRef} is not null`),
  index('invoices_shop_date_idx').on(t.shopId, t.date),
  index('invoices_party_idx').on(t.partyId),
]);

export const invoiceLines = pgTable('invoice_lines', {
  id: id(),
  invoiceId: uuid('invoice_id').notNull().references(() => invoices.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').notNull().references(() => products.id),
  name: text('name').notNull(),
  hsn: text('hsn'),
  qty: qty('qty').notNull(),
  ratePaise: money('rate_paise').notNull(),
  discountBps: integer('discount_bps').notNull().default(0),
  gstBps: integer('gst_bps').notNull().default(0),
  taxablePaise: money('taxable_paise').notNull(),
  taxPaise: money('tax_paise').notNull(),
  totalPaise: money('total_paise').notNull(),
  unitCostPaise: money('unit_cost_paise').notNull().default(0), // cost at time of sale, for margin
  batchNo: text('batch_no'),
  expiry: date('expiry', { mode: 'string' }),
}, (t) => [index('lines_invoice_idx').on(t.invoiceId), index('lines_product_idx').on(t.productId)]);

export const payments = pgTable('payments', {
  id: id(),
  shopId: uuid('shop_id').notNull().references(() => shops.id, { onDelete: 'cascade' }),
  kind: paymentKindEnum('kind').notNull(),
  amountPaise: money('amount_paise').notNull(),
  mode: payModeEnum('mode').notNull().default('cash'),
  partyId: uuid('party_id').references(() => parties.id),
  category: text('category'), // expense head: rent, salary…
  taxPaise: money('tax_paise').notNull().default(0), // GST included in an expense (input tax)
  recurring: boolean('recurring').notNull().default(false),
  note: text('note'),
  date: date('date', { mode: 'string' }).notNull(),
  attachmentId: uuid('attachment_id').references(() => attachments.id),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
}, (t) => [index('payments_shop_date_idx').on(t.shopId, t.date), index('payments_party_idx').on(t.partyId)]);

/** Gap-free bill numbers per shop and series, incremented atomically. */
export const sequences = pgTable('sequences', {
  shopId: uuid('shop_id').notNull().references(() => shops.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  next: integer('next').notNull().default(1),
}, (t) => [primaryKey({ columns: [t.shopId, t.key] })]);

export const auditLogs = pgTable('audit_logs', {
  id: id(),
  shopId: uuid('shop_id').notNull(),
  userId: uuid('user_id'),
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  entityId: text('entity_id'),
  data: jsonb('data'),
  createdAt: createdAt(),
}, (t) => [index('audit_shop_idx').on(t.shopId, t.createdAt)]);

/** Photos of bills turned into structured data, before and after they become a purchase or expense. */
export const billScans = pgTable('bill_scans', {
  id: id(),
  shopId: uuid('shop_id').notNull().references(() => shops.id, { onDelete: 'cascade' }),
  attachmentId: uuid('attachment_id').notNull().references(() => attachments.id),
  status: text('status').notNull().default('pending'), // pending | extracted | converted
  engine: text('engine'), // ai | ocr | manual
  data: jsonb('data').$type<Record<string, unknown>>(),
  rawText: text('raw_text'),
  invoiceId: uuid('invoice_id').references(() => invoices.id),
  paymentId: uuid('payment_id').references(() => payments.id),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('scans_shop_idx').on(t.shopId, t.createdAt)]);
