-- AlterTable
ALTER TABLE "products" ADD COLUMN     "attributes" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "condition" TEXT NOT NULL DEFAULT 'NEW',
ADD COLUMN     "mpn" TEXT,
ADD COLUMN     "title" TEXT,
ADD COLUMN     "warranty_months" INTEGER;

-- CreateTable
CREATE TABLE "product_images" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "content_type" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "alt" TEXT,
    "source_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "title" TEXT,
    "sku" TEXT,
    "gtin" TEXT,
    "price" DECIMAL(14,2),
    "quantity" INTEGER,
    "channel_status" TEXT,
    "permalink" TEXT,
    "snapshot" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "product_id" UUID,
    "matched_by" TEXT,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_images_tenant_id_product_id_position_idx" ON "product_images"("tenant_id", "product_id", "position");

-- CreateIndex
CREATE INDEX "channel_items_tenant_id_connection_id_status_idx" ON "channel_items"("tenant_id", "connection_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "channel_items_connection_id_external_id_key" ON "channel_items"("connection_id", "external_id");

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_items" ADD CONSTRAINT "channel_items_tenant_id_connection_id_fkey" FOREIGN KEY ("tenant_id", "connection_id") REFERENCES "marketplace_connections"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_items" ADD CONSTRAINT "channel_items_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

