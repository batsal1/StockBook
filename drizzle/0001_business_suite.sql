CREATE TABLE "bill_scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"attachment_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"engine" text,
	"data" jsonb,
	"raw_text" text,
	"invoice_id" uuid,
	"payment_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "due_date" date;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "credit_limit_paise" bigint;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "payment_terms_days" integer;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "tax_paise" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "recurring" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "invoice_prefix" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "default_gst_bps" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "payment_terms_days" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "expiry_warn_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "allow_negative_stock" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "cost_method" text DEFAULT 'latest' NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "fixed_assets_paise" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bill_scans" ADD CONSTRAINT "bill_scans_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_scans" ADD CONSTRAINT "bill_scans_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_scans" ADD CONSTRAINT "bill_scans_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_scans" ADD CONSTRAINT "bill_scans_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scans_shop_idx" ON "bill_scans" USING btree ("shop_id","created_at");