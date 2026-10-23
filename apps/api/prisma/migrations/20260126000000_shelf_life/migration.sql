-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "min_shelf_life_days" INTEGER;


ALTER TABLE customers ADD CONSTRAINT customers_min_shelf_life CHECK (min_shelf_life_days IS NULL OR min_shelf_life_days BETWEEN 1 AND 3650);
