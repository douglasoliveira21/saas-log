-- CreateTable
CREATE TABLE "drivers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "vehicle" TEXT,
    "plate" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "drivers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_routes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "route_date" DATE NOT NULL,
    "driver_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "notes" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancel_reason" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_stops" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "route_id" UUID NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "customer_name" TEXT NOT NULL,
    "customer_phone" TEXT,
    "address_text" TEXT NOT NULL,
    "zip_code" TEXT,
    "city" TEXT,
    "state" CHAR(2),
    "delivered_at" TIMESTAMP(3),
    "receiver_name" TEXT,
    "receiver_document" TEXT,
    "notes" TEXT,
    "failure_reason" TEXT,
    "lat" DECIMAL(9,6),
    "lng" DECIMAL(9,6),
    "accuracy_m" INTEGER,
    "resolved_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_stops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_proofs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "stop_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "taken_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_proofs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "drivers_tenant_id_user_id_key" ON "drivers"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "drivers_tenant_id_id_key" ON "drivers"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "delivery_routes_tenant_id_route_date_status_idx" ON "delivery_routes"("tenant_id", "route_date", "status");

-- CreateIndex
CREATE INDEX "delivery_routes_tenant_id_driver_id_status_idx" ON "delivery_routes"("tenant_id", "driver_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_routes_tenant_id_number_key" ON "delivery_routes"("tenant_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_routes_tenant_id_id_key" ON "delivery_routes"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "delivery_stops_tenant_id_route_id_sequence_idx" ON "delivery_stops"("tenant_id", "route_id", "sequence");

-- CreateIndex
CREATE INDEX "delivery_stops_tenant_id_sales_order_id_idx" ON "delivery_stops"("tenant_id", "sales_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_stops_tenant_id_id_key" ON "delivery_stops"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_stops_tenant_id_route_id_sales_order_id_key" ON "delivery_stops"("tenant_id", "route_id", "sales_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_proofs_tenant_id_stop_id_kind_key" ON "delivery_proofs"("tenant_id", "stop_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_proofs_tenant_id_sha256_key" ON "delivery_proofs"("tenant_id", "sha256");

-- AddForeignKey
ALTER TABLE "delivery_routes" ADD CONSTRAINT "delivery_routes_tenant_id_driver_id_fkey" FOREIGN KEY ("tenant_id", "driver_id") REFERENCES "drivers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_stops" ADD CONSTRAINT "delivery_stops_tenant_id_route_id_fkey" FOREIGN KEY ("tenant_id", "route_id") REFERENCES "delivery_routes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_stops" ADD CONSTRAINT "delivery_stops_tenant_id_sales_order_id_fkey" FOREIGN KEY ("tenant_id", "sales_order_id") REFERENCES "sales_orders"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_proofs" ADD CONSTRAINT "delivery_proofs_tenant_id_stop_id_fkey" FOREIGN KEY ("tenant_id", "stop_id") REFERENCES "delivery_stops"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

