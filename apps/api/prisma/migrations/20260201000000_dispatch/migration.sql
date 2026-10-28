-- AlterTable
ALTER TABLE "sales_orders" ADD COLUMN     "fulfillment_note" TEXT,
ADD COLUMN     "packed_at" TIMESTAMP(3),
ADD COLUMN     "packed_by_id" UUID,
ADD COLUMN     "picking_by_id" UUID,
ADD COLUMN     "picking_started_at" TIMESTAMP(3),
ADD COLUMN     "rush" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "rush_reason" TEXT;


CREATE INDEX sales_orders_fulfillment_idx ON sales_orders (tenant_id, status, confirmed_at) WHERE status IN ('CONFIRMED', 'PICKING', 'PACKED');
