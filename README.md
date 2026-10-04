# Stockbook

**Open http://localhost:3000 after `npm run dev`** to use the full business management app: dashboard, sales, purchases, bill scanner, inventory, customers and suppliers, finance, expenses, GST, reports, analytics and settings. Everything in it is live data from this server.

Backend for Stockbook: product catalog, barcode scanning, stock with batches and expiry, sales and purchase bills, suppliers and wholesale buyers, cash and bank accounts, GST reports, Excel import and export, and AI bill reading. One server safely hosts many shops.

Built with Node.js 20+, TypeScript, Fastify, PostgreSQL 16 and Drizzle ORM.

## Run it

With Docker (easiest):

```bash
cp .env.example .env          # set JWT_SECRET to a long random string
docker compose up --build     # API on http://localhost:3000
```

Without Docker, with PostgreSQL 16 installed:

```bash
npm install
cp .env.example .env          # set DATABASE_URL and JWT_SECRET
npm run db:migrate            # creates the tables
npm run db:seed               # optional demo shop: owner@demo.shop / demo1234
npm run dev                   # restarts on every code change
```

Tests (the API tests wipe the database you point them at, so use a separate one):

```bash
TEST_DATABASE_URL=postgres://stockbook:stockbook@localhost:5432/stockbook_test npm test
```

After changing `src/db/schema.ts`, run `npm run db:generate` to create a migration, then `npm run db:migrate`.

## The web app

`public/index.html` is the whole app in one file, served at `/`. It signs in with the same accounts as the API (demo: owner@demo.shop / demo1234; staff: sales@demo.shop / sales1234 as cashier, accounts@demo.shop / accounts1234 as manager).

The period picker at the top (last 30 days, this month, last month, this quarter, this financial year) drives every figure. Excel downloads are made in the browser, so they need the internet once to load the Excel library.

## Settings → Data manager

Every record in one place, with search: **products, customers & suppliers, bills, payments & expenses, categories, users**, plus **import & export**. Each row can be edited or deleted, and each tab has buttons to add new entries.

- **Bills** can be edited after saving (`PUT /invoices/:id`, same shape as creating one). The bill keeps its id and number; stock, cost prices and balances are recalculated. Cancelled bills cannot be edited.
- **Payments and expenses**: `PATCH /payments/:id`.
- **Users**: change name or role, reset a password, remove from the shop (`PATCH/DELETE /auth/staff/:id`, `POST /auth/staff/:id/password`); anyone can change their own password (`POST /auth/me/password`).
- **Categories**: rename or merge (`POST /products/categories/rename`).
- **Customers & suppliers from Excel**: `POST /excel/parties/import?commit=` (preview first, matches by GSTIN or phone).

## Bill Scanner

Turns a photo of a bill into structured data, then into a purchase entry or an expense.

1. Upload a photo (or PDF with AI reading), use the phone camera, or click "Try a sample bill".
2. It is read by one of two engines:
   - **AI reading** (best): set `ANTHROPIC_API_KEY` in `.env`. The server sends the photo to Claude and gets back vendor, GSTIN, bill number, dates, every item with HSN, quantity, rate and GST, and the totals.
   - **On-device OCR** (free, nothing leaves the computer): the browser cleans up the photo (rotation, grey, contrast, ~2000 px wide), reads it with Tesseract twice (whole bill, then the top fifth for the shop name and header), and `parseBillText` in `public/index.html` turns the text into data. The parser reads the table's header row to map numbers to columns in any order, repairs OCR misreads (lost decimal points, © for 0, split GSTINs, Pes for Pcs), joins wrapped descriptions, recovers a missing quantity from rate × amount, handles receipts with only quantity and amount, and converts GST-inclusive receipts. Lines it cannot read are listed for one-click adding. "Read again" retries in black-and-white, row-by-row mode. `test/parser.test.ts` checks it against real OCR output of four kinds of bill. Handwritten bills need AI.
3. The review screen shows the photo next to the extracted data. Every field and line is editable; each line is matched to a catalog product (or will become a new one). Arithmetic checks compare the lines with the printed totals, and a visual summary shows each item's share and the GST split (IGST across states, CGST + SGST within the state).
4. **Create purchase entry** adds the stock, updates cost prices, creates the supplier from the bill if needed, adds to the supplier's balance and attaches the photo. **Record as expense** files utility, rent and similar bills under Expenses.

Routes: `POST /scans`, `PUT /scans/:id/data`, `GET /scans`, `GET /scans/:id`, `POST /scans/:id/convert`, `DELETE /scans/:id`.

## How it is organised

```
src/
  db/schema.ts        every table, with the conventions explained at the top
  lib/money.ts        bill maths: GST inclusive/exclusive, discounts, rounding, CGST/SGST/IGST
  lib/stock.ts        the only place stock changes: movements, batches, first-expiry-first-out
  lib/barcode.ts      barcode validation and the lookup chain
  lib/ledger.ts       party balances, cash and bank balances
  lib/billdata.ts     bill photo → structured data: AI reading, checks, product matching
  modules/insights.ts P&L, cash flow, balance sheet, aging, inventory health, GST, analytics
  modules/scans.ts    bill scanner workflow
public/index.html     the web app
  modules/            one file per area of the API
drizzle/              SQL migrations
test/                 unit tests and an end-to-end test of a full shop day
```

Design rules worth knowing before you change anything:

- **Money is integer paise** everywhere (₹145.50 = 14550). Tax rates are basis points (5% = 500). Quantities allow 3 decimals for loose goods.
- **Stock is never edited directly.** Every change goes through `applyStock`, which writes a `stock_movements` row, so you can always answer "why is this number what it is".
- **Bills are cancelled, never deleted.** Cancelling puts the stock back and drops the bill from balances, but it stays on record for audits and GST.
- **Every query is scoped by `shop_id`** taken from the signed-in token, never from the request body.

## Barcode lookup

`GET /products/lookup/:code` answers a scan in this order:

1. **The shop's own catalog.**
2. **Stockbook's shared product master** (`global_products`). Every shop that saves a product with a barcode adds to it, so coverage of local Indian brands grows with every shop that joins.
3. **Outside databases**, first hit wins: Open Food Facts, Open Beauty Facts and Open Products Facts (free), UPCitemdb (free trial, or paid with `UPCITEMDB_KEY`), Barcode Lookup (paid, `BARCODELOOKUP_KEY`). Hits are cached into the master.
4. **Nothing found:** the app offers `POST /ai/product-from-photo` (read the packet) or manual entry.

GS1 India's DataKart is the official source for 890-prefix (Indian) barcodes. Once you have API access from GS1 India, add it as a provider in `src/lib/barcode.ts`.

## API

All routes except `/auth/register`, `/auth/login` and `/health` need `Authorization: Bearer <token>`. Errors look like `{"error": "bad_request", "message": "…"}`.

| Area | Routes |
|---|---|
| Account | `POST /auth/register`, `POST /auth/login`, `GET /auth/me`, `PATCH /auth/shop`, `POST /auth/branches`, `GET/POST /auth/staff` |
| Catalog | `GET /products?q=&category=&stock=low\|out\|expiring`, `GET /products/categories`, `GET /products/lookup/:barcode`, `GET/PATCH/DELETE /products/:id`, `POST /products`, `POST /products/:id/adjust` |
| Bills | `POST /invoices`, `POST /invoices/sync`, `GET /invoices?type=&from=&to=&partyId=`, `GET /invoices/:id`, `POST /invoices/:id/cancel` |
| Parties | `GET/POST /parties`, `GET/PATCH/DELETE /parties/:id`, `GET /parties/:id/statement` |
| Money | `POST /payments` (payment in/out, expense, income, cash deposit/withdrawal), `GET /payments`, `DELETE /payments/:id` |
| Reports | `GET /reports/summary?month=`, `/reports/daily-sales`, `/reports/gst`, `/reports/low-stock`, `/reports/expiring?days=`, `/reports/daybook?date=` |
| Files | `POST /files` (bill photo or PDF), `GET /files`, `GET /files/:id` |
| Excel | `POST /excel/products/import?commit=&stockMode=opening\|set`, `GET /excel/products/template`, `GET /excel/export?month=` |
| AI | `POST /ai/read-bill`, `POST /ai/product-from-photo` (need `ANTHROPIC_API_KEY`) |
| Insights | `GET /insights/dashboard`, `/pnl`, `/cashflow`, `/balance-sheet`, `/aging?side=receivable\|payable`, `/inventory`, `/dead-stock`, `/stock-ledger`, `/expenses`, `/tax`, `/analytics`, `/search?q=` (all take `?from=&to=`) |
| Bill scanner | `POST /scans`, `PUT /scans/:id/data`, `GET /scans`, `GET /scans/:id`, `POST /scans/:id/convert`, `DELETE /scans/:id` |

A sale, as the counter app sends it:

```json
POST /invoices
{
  "clientRef": "device-7f3a-000123",
  "type": "sale",
  "partyId": "…optional, required for credit…",
  "payMode": "upi",
  "lines": [
    { "productId": "…", "qty": 2, "ratePaise": 14500 },
    { "productId": "…", "qty": 1.25, "ratePaise": 8000, "discountBps": 500 }
  ]
}
```

Leave out `paidPaise` when the customer pays in full. Purchases also accept `batchNo` and `expiry` on each line, and a `newProduct` instead of `productId` for items not yet in the catalog.

**Offline billing:** the app saves bills on the phone with a `clientRef` (a UUID made on the device) and uploads them with `POST /invoices/sync` when the internet returns. Sending the same bill twice never creates a duplicate.

**Roles:** owners can do everything. Managers can do everything except shop settings and staff. Cashiers can make sales, sale returns, add customers and record money received.

## Before going live

- Put the API behind HTTPS (Caddy or Nginx) and use a long random `JWT_SECRET`.
- Move bill files to object storage (S3, Cloudflare R2 or DigitalOcean Spaces) by replacing the three functions in `src/lib/storage.ts`.
- Turn on daily PostgreSQL backups.
- Add rate limiting on `/auth` routes (`@fastify/rate-limit`).
