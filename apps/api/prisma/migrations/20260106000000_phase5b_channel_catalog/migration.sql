-- CreateTable
CREATE TABLE "channel_listings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "external_item_id" TEXT,
    "title" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "price" DECIMAL(14,2),
    "last_published_price" DECIMAL(14,2),
    "last_published_qty" INTEGER,
    "sync_status" TEXT,
    "sync_error" TEXT,
    "last_sync_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_history" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "old_price" DECIMAL(14,2),
    "new_price" DECIMAL(14,2) NOT NULL,
    "margin_pct" DECIMAL(7,2),
    "reason" TEXT NOT NULL,
    "user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_category_mappings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "external_category_id" TEXT NOT NULL,
    "external_category_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_category_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "channel_listings_tenant_id_connection_id_idx" ON "channel_listings"("tenant_id", "connection_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_listings_connection_id_product_id_key" ON "channel_listings"("connection_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_listings_connection_id_external_item_id_key" ON "channel_listings"("connection_id", "external_item_id");

-- CreateIndex
CREATE INDEX "price_history_tenant_id_product_id_connection_id_created_at_idx" ON "price_history"("tenant_id", "product_id", "connection_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "channel_category_mappings_connection_id_category_id_key" ON "channel_category_mappings"("connection_id", "category_id");

-- AddForeignKey
ALTER TABLE "channel_listings" ADD CONSTRAINT "channel_listings_tenant_id_connection_id_fkey" FOREIGN KEY ("tenant_id", "connection_id") REFERENCES "marketplace_connections"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_listings" ADD CONSTRAINT "channel_listings_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_category_mappings" ADD CONSTRAINT "channel_category_mappings_tenant_id_connection_id_fkey" FOREIGN KEY ("tenant_id", "connection_id") REFERENCES "marketplace_connections"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_category_mappings" ADD CONSTRAINT "channel_category_mappings_tenant_id_category_id_fkey" FOREIGN KEY ("tenant_id", "category_id") REFERENCES "product_categories"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

