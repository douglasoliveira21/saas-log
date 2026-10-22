-- CreateEnum
CREATE TYPE "FiscalDocChoice" AS ENUM ('NONE', 'NFE', 'NFCE');

-- AlterTable
ALTER TABLE "sales_orders" ADD COLUMN     "fiscal_doc_type" "FiscalDocChoice" NOT NULL DEFAULT 'NONE';

