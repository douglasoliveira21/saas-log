-- AlterTable
ALTER TABLE "sales_orders" ADD COLUMN     "external_ref" TEXT,
ADD COLUMN     "external_source" TEXT;

-- CreateTable
CREATE TABLE "external_orders" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "external_status" TEXT,
    "sales_order_id" UUID,
    "reason" TEXT,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "external_orders_tenant_id_connection_id_status_idx" ON "external_orders"("tenant_id", "connection_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "external_orders_connection_id_external_id_key" ON "external_orders"("connection_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_orders_tenant_id_external_source_external_ref_key" ON "sales_orders"("tenant_id", "external_source", "external_ref");

-- AddForeignKey
ALTER TABLE "external_orders" ADD CONSTRAINT "external_orders_tenant_id_connection_id_fkey" FOREIGN KEY ("tenant_id", "connection_id") REFERENCES "marketplace_connections"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_orders" ADD CONSTRAINT "external_orders_tenant_id_sales_order_id_fkey" FOREIGN KEY ("tenant_id", "sales_order_id") REFERENCES "sales_orders"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

