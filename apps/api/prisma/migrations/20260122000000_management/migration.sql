-- CreateTable
CREATE TABLE "sales_goals" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "salesperson_id" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "line_key" TEXT NOT NULL,
    "category_id" UUID,
    "period" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "budget_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sales_goals_tenant_id_salesperson_id_period_key" ON "sales_goals"("tenant_id", "salesperson_id", "period");

-- CreateIndex
CREATE UNIQUE INDEX "budget_lines_tenant_id_line_key_period_key" ON "budget_lines"("tenant_id", "line_key", "period");

-- AddForeignKey
ALTER TABLE "sales_goals" ADD CONSTRAINT "sales_goals_tenant_id_salesperson_id_fkey" FOREIGN KEY ("tenant_id", "salesperson_id") REFERENCES "salespeople"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_tenant_id_category_id_fkey" FOREIGN KEY ("tenant_id", "category_id") REFERENCES "financial_categories"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Metas e orçamento: isolamento por empresa (RLS) e valores válidos.
GRANT SELECT, INSERT, UPDATE ON sales_goals, budget_lines TO dh_app;
ALTER TABLE sales_goals ENABLE ROW LEVEL SECURITY; ALTER TABLE sales_goals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sales_goals TO dh_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE budget_lines ENABLE ROW LEVEL SECURITY; ALTER TABLE budget_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON budget_lines TO dh_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE sales_goals ADD CONSTRAINT sales_goals_valid CHECK (amount >= 0 AND period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
ALTER TABLE budget_lines ADD CONSTRAINT budget_lines_valid CHECK (amount >= 0 AND period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
