-- AlterTable
ALTER TABLE "delivery_routes" ADD COLUMN     "vehicle_id" UUID;

-- CreateTable
CREATE TABLE "rfq_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "needed_by" DATE,
    "notes" TEXT,
    "order_ids" JSONB NOT NULL DEFAULT '[]',
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "rfq_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rfq_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "rfq_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "rfq_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rfq_suppliers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "rfq_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "lead_time_days" INTEGER,
    "freight" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "payment_terms" TEXT,
    "notes" TEXT,
    "responded_at" TIMESTAMP(3),

    CONSTRAINT "rfq_suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rfq_prices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "rfq_supplier_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "unit_cost" DECIMAL(14,4) NOT NULL,

    CONSTRAINT "rfq_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plate" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'VAN',
    "capacity_kg" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fleet_costs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "route_id" UUID,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "date" DATE NOT NULL,
    "note" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fleet_costs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rfq_requests_tenant_id_status_idx" ON "rfq_requests"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "rfq_requests_tenant_id_number_key" ON "rfq_requests"("tenant_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "rfq_requests_tenant_id_id_key" ON "rfq_requests"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "rfq_items_rfq_id_product_id_key" ON "rfq_items"("rfq_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "rfq_items_tenant_id_id_key" ON "rfq_items"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "rfq_suppliers_rfq_id_supplier_id_key" ON "rfq_suppliers"("rfq_id", "supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "rfq_suppliers_tenant_id_id_key" ON "rfq_suppliers"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "rfq_prices_rfq_supplier_id_product_id_key" ON "rfq_prices"("rfq_supplier_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_tenant_id_plate_key" ON "vehicles"("tenant_id", "plate");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_tenant_id_id_key" ON "vehicles"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "fleet_costs_tenant_id_vehicle_id_date_idx" ON "fleet_costs"("tenant_id", "vehicle_id", "date");

-- CreateIndex
CREATE INDEX "fleet_costs_tenant_id_route_id_idx" ON "fleet_costs"("tenant_id", "route_id");

-- AddForeignKey
ALTER TABLE "delivery_routes" ADD CONSTRAINT "delivery_routes_tenant_id_vehicle_id_fkey" FOREIGN KEY ("tenant_id", "vehicle_id") REFERENCES "vehicles"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_items" ADD CONSTRAINT "rfq_items_tenant_id_rfq_id_fkey" FOREIGN KEY ("tenant_id", "rfq_id") REFERENCES "rfq_requests"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_items" ADD CONSTRAINT "rfq_items_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_suppliers" ADD CONSTRAINT "rfq_suppliers_tenant_id_rfq_id_fkey" FOREIGN KEY ("tenant_id", "rfq_id") REFERENCES "rfq_requests"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_suppliers" ADD CONSTRAINT "rfq_suppliers_tenant_id_supplier_id_fkey" FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "suppliers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_prices" ADD CONSTRAINT "rfq_prices_tenant_id_rfq_supplier_id_fkey" FOREIGN KEY ("tenant_id", "rfq_supplier_id") REFERENCES "rfq_suppliers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_costs" ADD CONSTRAINT "fleet_costs_tenant_id_vehicle_id_fkey" FOREIGN KEY ("tenant_id", "vehicle_id") REFERENCES "vehicles"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Cotações de compra e frota: isolamento por empresa (RLS), permissões e invariantes.
GRANT SELECT, INSERT, UPDATE ON rfq_requests, rfq_suppliers, vehicles TO dh_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON rfq_items, rfq_prices TO dh_app;
GRANT SELECT, INSERT ON fleet_costs TO dh_app; -- lançamento imutável (correção = novo lançamento negativo não permitido; estorno por exclusão não existe)
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['rfq_requests','rfq_items','rfq_suppliers','rfq_prices','vehicles','fleet_costs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO dh_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;
ALTER TABLE rfq_requests ADD CONSTRAINT rfq_status CHECK (status IN ('OPEN', 'CLOSED', 'CANCELLED'));
ALTER TABLE rfq_items ADD CONSTRAINT rfq_items_qty CHECK (quantity > 0);
ALTER TABLE rfq_prices ADD CONSTRAINT rfq_prices_cost CHECK (unit_cost >= 0);
ALTER TABLE rfq_suppliers ADD CONSTRAINT rfq_suppliers_valid CHECK (freight >= 0 AND (lead_time_days IS NULL OR lead_time_days BETWEEN 0 AND 365));
ALTER TABLE vehicles ADD CONSTRAINT vehicles_valid CHECK (capacity_kg IS NULL OR capacity_kg > 0);
ALTER TABLE fleet_costs ADD CONSTRAINT fleet_costs_valid CHECK (amount > 0 AND kind IN ('FUEL', 'TOLL', 'MAINTENANCE', 'DRIVER', 'INSURANCE', 'OTHER'));
