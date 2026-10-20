-- AlterTable
ALTER TABLE "sales_commissions" ADD COLUMN     "payout_title_id" UUID;

-- CreateTable
CREATE TABLE "financial_accounts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "bank_name" TEXT,
    "agency" TEXT,
    "account_number" TEXT,
    "opening_balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "opening_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financial_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_categories" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financial_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_centers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_centers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_titles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "direction" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "counterparty_kind" TEXT NOT NULL DEFAULT 'OTHER',
    "supplier_id" UUID,
    "customer_id" UUID,
    "salesperson_id" UUID,
    "connection_id" UUID,
    "counterparty_name" TEXT,
    "description" TEXT NOT NULL,
    "document_ref" TEXT,
    "installment_no" INTEGER NOT NULL DEFAULT 1,
    "installment_total" INTEGER NOT NULL DEFAULT 1,
    "issue_date" TIMESTAMP(3),
    "due_date" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "paid_principal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "category_id" UUID,
    "cost_center_id" UUID,
    "origin" TEXT NOT NULL DEFAULT 'MANUAL',
    "origin_ref" TEXT,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancel_reason" TEXT,
    "notes" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "financial_titles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_settlements" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "title_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'SETTLEMENT',
    "amount" DECIMAL(14,2) NOT NULL,
    "principal" DECIMAL(14,2) NOT NULL,
    "interest" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "fine" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "paid_at" TIMESTAMP(3) NOT NULL,
    "reversal_of_id" UUID,
    "note" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financial_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_statement_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "fitid" TEXT NOT NULL,
    "posted_at" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "description" TEXT NOT NULL,
    "settlement_id" UUID,
    "matched_at" TIMESTAMP(3),
    "matched_by_id" UUID,
    "batch" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_statement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_settlements" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "report_ref" TEXT NOT NULL,
    "external_order_id" TEXT NOT NULL,
    "gross" DECIMAL(14,2) NOT NULL,
    "commission" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "fixed_fee" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "payment_fee" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "shipping" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "adjustments" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "refunds" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "net_reported" DECIMAL(14,2) NOT NULL,
    "expected_date" TIMESTAMP(3),
    "received_date" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'IMPORTED',
    "sales_order_id" UUID,
    "title_id" UUID,
    "divergence" JSONB NOT NULL DEFAULT '[]',
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketplace_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "packagings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "length_mm" INTEGER NOT NULL,
    "width_mm" INTEGER NOT NULL,
    "height_mm" INTEGER NOT NULL,
    "max_weight_g" INTEGER NOT NULL,
    "tare_g" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "packagings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "carrier" TEXT NOT NULL,
    "service" TEXT,
    "tracking_code" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "packaging_id" UUID,
    "weight_g" INTEGER,
    "length_mm" INTEGER,
    "width_mm" INTEGER,
    "height_mm" INTEGER,
    "cost" DECIMAL(14,2),
    "posted_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_events" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "location" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_exports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "report" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "row_count" INTEGER,
    "file_name" TEXT,
    "content" BYTEA,
    "error" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_exports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "financial_accounts_tenant_id_name_key" ON "financial_accounts"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "financial_accounts_tenant_id_id_key" ON "financial_accounts"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "financial_categories_tenant_id_name_key" ON "financial_categories"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "financial_categories_tenant_id_id_key" ON "financial_categories"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "cost_centers_tenant_id_name_key" ON "cost_centers"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "cost_centers_tenant_id_id_key" ON "cost_centers"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "financial_titles_tenant_id_direction_status_due_date_idx" ON "financial_titles"("tenant_id", "direction", "status", "due_date");

-- CreateIndex
CREATE UNIQUE INDEX "financial_titles_tenant_id_origin_origin_ref_key" ON "financial_titles"("tenant_id", "origin", "origin_ref");

-- CreateIndex
CREATE UNIQUE INDEX "financial_titles_tenant_id_id_key" ON "financial_titles"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "financial_settlements_reversal_of_id_key" ON "financial_settlements"("reversal_of_id");

-- CreateIndex
CREATE INDEX "financial_settlements_tenant_id_account_id_paid_at_idx" ON "financial_settlements"("tenant_id", "account_id", "paid_at");

-- CreateIndex
CREATE INDEX "financial_settlements_tenant_id_title_id_idx" ON "financial_settlements"("tenant_id", "title_id");

-- CreateIndex
CREATE UNIQUE INDEX "financial_settlements_tenant_id_id_key" ON "financial_settlements"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "bank_statement_lines_tenant_id_account_id_posted_at_idx" ON "bank_statement_lines"("tenant_id", "account_id", "posted_at");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_lines_account_id_fitid_key" ON "bank_statement_lines"("account_id", "fitid");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_lines_settlement_id_key" ON "bank_statement_lines"("settlement_id");

-- CreateIndex
CREATE INDEX "marketplace_settlements_tenant_id_connection_id_status_idx" ON "marketplace_settlements"("tenant_id", "connection_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_settlements_connection_id_report_ref_external_o_key" ON "marketplace_settlements"("connection_id", "report_ref", "external_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "packagings_tenant_id_name_key" ON "packagings"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "packagings_tenant_id_id_key" ON "packagings"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "shipments_tenant_id_status_idx" ON "shipments"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_tenant_id_carrier_tracking_code_key" ON "shipments"("tenant_id", "carrier", "tracking_code");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_tenant_id_id_key" ON "shipments"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "shipment_events_tenant_id_shipment_id_occurred_at_idx" ON "shipment_events"("tenant_id", "shipment_id", "occurred_at");

-- CreateIndex
CREATE INDEX "report_exports_tenant_id_created_at_idx" ON "report_exports"("tenant_id", "created_at");

-- AddForeignKey
ALTER TABLE "financial_titles" ADD CONSTRAINT "financial_titles_tenant_id_category_id_fkey" FOREIGN KEY ("tenant_id", "category_id") REFERENCES "financial_categories"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_titles" ADD CONSTRAINT "financial_titles_tenant_id_cost_center_id_fkey" FOREIGN KEY ("tenant_id", "cost_center_id") REFERENCES "cost_centers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_settlements" ADD CONSTRAINT "financial_settlements_tenant_id_title_id_fkey" FOREIGN KEY ("tenant_id", "title_id") REFERENCES "financial_titles"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_settlements" ADD CONSTRAINT "financial_settlements_tenant_id_account_id_fkey" FOREIGN KEY ("tenant_id", "account_id") REFERENCES "financial_accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_tenant_id_account_id_fkey" FOREIGN KEY ("tenant_id", "account_id") REFERENCES "financial_accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_tenant_id_sales_order_id_fkey" FOREIGN KEY ("tenant_id", "sales_order_id") REFERENCES "sales_orders"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_tenant_id_shipment_id_fkey" FOREIGN KEY ("tenant_id", "shipment_id") REFERENCES "shipments"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

