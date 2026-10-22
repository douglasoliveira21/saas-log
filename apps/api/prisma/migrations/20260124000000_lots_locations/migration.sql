-- AlterTable
ALTER TABLE "products" ADD COLUMN     "track_lots" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "stock_lots" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "expires_at" DATE,
    "on_hand" INTEGER NOT NULL DEFAULT 0,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_lot_movements" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "movement_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_lot_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_locations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_location_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "lot_id" UUID,
    "lot_key" TEXT NOT NULL DEFAULT 'NONE',
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "stock_location_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_checks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "items" JSONB NOT NULL DEFAULT '[]',
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_lots_tenant_id_product_id_warehouse_id_expires_at_idx" ON "stock_lots"("tenant_id", "product_id", "warehouse_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "stock_lots_tenant_id_product_id_warehouse_id_code_key" ON "stock_lots"("tenant_id", "product_id", "warehouse_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "stock_lots_tenant_id_id_key" ON "stock_lots"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "stock_lot_movements_tenant_id_movement_id_idx" ON "stock_lot_movements"("tenant_id", "movement_id");

-- CreateIndex
CREATE INDEX "stock_lot_movements_tenant_id_lot_id_idx" ON "stock_lot_movements"("tenant_id", "lot_id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_locations_tenant_id_warehouse_id_code_key" ON "warehouse_locations"("tenant_id", "warehouse_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_locations_tenant_id_id_key" ON "warehouse_locations"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "stock_location_items_tenant_id_product_id_idx" ON "stock_location_items"("tenant_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_location_items_tenant_id_location_id_product_id_lot_k_key" ON "stock_location_items"("tenant_id", "location_id", "product_id", "lot_key");

-- CreateIndex
CREATE INDEX "order_checks_tenant_id_order_id_idx" ON "order_checks"("tenant_id", "order_id");

-- AddForeignKey
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_tenant_id_warehouse_id_fkey" FOREIGN KEY ("tenant_id", "warehouse_id") REFERENCES "warehouses"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_lot_movements" ADD CONSTRAINT "stock_lot_movements_tenant_id_lot_id_fkey" FOREIGN KEY ("tenant_id", "lot_id") REFERENCES "stock_lots"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_locations" ADD CONSTRAINT "warehouse_locations_tenant_id_warehouse_id_fkey" FOREIGN KEY ("tenant_id", "warehouse_id") REFERENCES "warehouses"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_location_items" ADD CONSTRAINT "stock_location_items_tenant_id_location_id_fkey" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "warehouse_locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_location_items" ADD CONSTRAINT "stock_location_items_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_location_items" ADD CONSTRAINT "stock_location_items_tenant_id_lot_id_fkey" FOREIGN KEY ("tenant_id", "lot_id") REFERENCES "stock_lots"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_checks" ADD CONSTRAINT "order_checks_tenant_id_order_id_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "sales_orders"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Lotes, endereços e conferência: isolamento por empresa (RLS), permissões e invariantes.
GRANT SELECT, INSERT, UPDATE ON stock_lots, warehouse_locations TO dh_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON stock_location_items TO dh_app;
GRANT SELECT, INSERT ON stock_lot_movements, order_checks TO dh_app; -- registros imutáveis
ALTER TABLE stock_lots ENABLE ROW LEVEL SECURITY; ALTER TABLE stock_lots FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stock_lots TO dh_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE stock_lot_movements ENABLE ROW LEVEL SECURITY; ALTER TABLE stock_lot_movements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stock_lot_movements TO dh_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE warehouse_locations ENABLE ROW LEVEL SECURITY; ALTER TABLE warehouse_locations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON warehouse_locations TO dh_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE stock_location_items ENABLE ROW LEVEL SECURITY; ALTER TABLE stock_location_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stock_location_items TO dh_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE order_checks ENABLE ROW LEVEL SECURITY; ALTER TABLE order_checks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON order_checks TO dh_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE stock_lots ADD CONSTRAINT stock_lots_nonneg CHECK (on_hand >= 0 AND length(code) BETWEEN 1 AND 60);
ALTER TABLE stock_location_items ADD CONSTRAINT stock_location_items_nonneg CHECK (quantity >= 0);
ALTER TABLE order_checks ADD CONSTRAINT order_checks_status CHECK (status IN ('OK', 'DIVERGENT'));
