-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "block_release_reason" TEXT,
ADD COLUMN     "block_released_by_id" UUID,
ADD COLUMN     "block_released_until" TIMESTAMP(3);

