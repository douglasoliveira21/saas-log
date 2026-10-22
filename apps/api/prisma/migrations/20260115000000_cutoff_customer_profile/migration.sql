-- CreateEnum
CREATE TYPE "CustomerPurchaseType" AS ENUM ('NEW', 'ACTIVE', 'RETURNING');

-- AlterTable
ALTER TABLE "sales_orders" ADD COLUMN     "customer_type" "CustomerPurchaseType",
ADD COLUMN     "dispatch_date" DATE,
ADD COLUMN     "dispatch_deferred" BOOLEAN NOT NULL DEFAULT false;

