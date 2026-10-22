-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "credit_limit" DECIMAL(14,2);

-- AlterTable
ALTER TABLE "sales_orders" ADD COLUMN     "client_ref" TEXT;

-- CreateTable
CREATE TABLE "quotes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "customer_id" UUID NOT NULL,
    "salesperson_id" UUID,
    "warehouse_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "valid_until" DATE NOT NULL,
    "payment_method" TEXT,
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discount_total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "shipping" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "order_id" UUID,
    "lost_reason" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "quote_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price" DECIMAL(14,2) NOT NULL,
    "discount_pct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "quote_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quotes_tenant_id_status_idx" ON "quotes"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_tenant_id_number_key" ON "quotes"("tenant_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_tenant_id_id_key" ON "quotes"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "quote_items_quote_id_product_id_key" ON "quote_items"("quote_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_orders_tenant_id_client_ref_key" ON "sales_orders"("tenant_id", "client_ref");

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_tenant_id_customer_id_fkey" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_tenant_id_quote_id_fkey" FOREIGN KEY ("tenant_id", "quote_id") REFERENCES "quotes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Orçamentos: isolamento por empresa (RLS), valores válidos e limite de crédito não negativo.
GRANT SELECT, INSERT, UPDATE ON quotes TO dh_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON quote_items TO dh_app;
ALTER TABLE quotes ENABLE ROW LEVEL SECURITY; ALTER TABLE quotes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON quotes TO dh_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE quote_items ENABLE ROW LEVEL SECURITY; ALTER TABLE quote_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON quote_items TO dh_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE quotes ADD CONSTRAINT quotes_valid CHECK (status IN ('OPEN', 'CONVERTED', 'LOST') AND total >= 0 AND subtotal >= 0);
ALTER TABLE quote_items ADD CONSTRAINT quote_items_valid CHECK (quantity > 0 AND unit_price >= 0 AND discount_pct BETWEEN 0 AND 100);
ALTER TABLE customers ADD CONSTRAINT customers_credit_limit CHECK (credit_limit IS NULL OR credit_limit >= 0);
