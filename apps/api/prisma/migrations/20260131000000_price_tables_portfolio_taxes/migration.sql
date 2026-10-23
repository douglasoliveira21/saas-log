-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "price_table" TEXT NOT NULL DEFAULT 'RETAIL',
ADD COLUMN     "salesperson_id" UUID;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "wholesale_price" DECIMAL(14,2);

-- AlterTable
ALTER TABLE "sales_orders" ADD COLUMN     "price_table" TEXT NOT NULL DEFAULT 'RETAIL';

-- CreateTable
CREATE TABLE "federal_tax_configs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "regime" "TaxRegime" NOT NULL,
    "pis_rate" DECIMAL(7,4) NOT NULL,
    "cofins_rate" DECIMAL(7,4) NOT NULL,
    "sc_article" TEXT,
    "show_total_taxes" BOOLEAN NOT NULL DEFAULT false,
    "presumed_credit" BOOLEAN NOT NULL DEFAULT false,
    "exceeded_sublimit" BOOLEAN NOT NULL DEFAULT false,
    "icms_by_uf" JSONB NOT NULL DEFAULT '[]',
    "ibs_cbs_by_uf" JSONB NOT NULL DEFAULT '[]',
    "updated_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "federal_tax_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "federal_tax_configs_tenant_id_company_id_key" ON "federal_tax_configs"("tenant_id", "company_id");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_tenant_id_salesperson_id_fkey" FOREIGN KEY ("tenant_id", "salesperson_id") REFERENCES "salespeople"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Impostos federais: por empresa (RLS) e valores válidos.
GRANT SELECT, INSERT, UPDATE ON federal_tax_configs TO dh_app;
ALTER TABLE federal_tax_configs ENABLE ROW LEVEL SECURITY; ALTER TABLE federal_tax_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON federal_tax_configs TO dh_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE federal_tax_configs ADD CONSTRAINT federal_tax_rates CHECK (pis_rate BETWEEN 0 AND 100 AND cofins_rate BETWEEN 0 AND 100);
-- Tabelas de preço e preço de atacado.
ALTER TABLE customers ADD CONSTRAINT customers_price_table CHECK (price_table IN ('RETAIL', 'WHOLESALE'));
ALTER TABLE sales_orders ADD CONSTRAINT sales_orders_price_table CHECK (price_table IN ('RETAIL', 'WHOLESALE'));
ALTER TABLE products ADD CONSTRAINT products_wholesale_price CHECK (wholesale_price IS NULL OR wholesale_price >= 0);
