-- CreateTable
CREATE TABLE "negotiations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "customer_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "original_amount" DECIMAL(14,2) NOT NULL,
    "interest" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "fine" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(14,2) NOT NULL,
    "installments" INTEGER NOT NULL,
    "first_due_date" DATE NOT NULL,
    "interval_days" INTEGER NOT NULL DEFAULT 30,
    "notes" TEXT,
    "cancel_reason" TEXT,
    "cancelled_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "negotiations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "negotiation_titles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "negotiation_id" UUID NOT NULL,
    "title_id" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "due_date" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "negotiation_titles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "negotiations_tenant_id_customer_id_idx" ON "negotiations"("tenant_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "negotiations_tenant_id_number_key" ON "negotiations"("tenant_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "negotiations_tenant_id_id_key" ON "negotiations"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "negotiation_titles_tenant_id_title_id_idx" ON "negotiation_titles"("tenant_id", "title_id");

-- CreateIndex
CREATE INDEX "negotiation_titles_tenant_id_negotiation_id_idx" ON "negotiation_titles"("tenant_id", "negotiation_id");

-- AddForeignKey
ALTER TABLE "negotiations" ADD CONSTRAINT "negotiations_tenant_id_customer_id_fkey" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negotiation_titles" ADD CONSTRAINT "negotiation_titles_tenant_id_negotiation_id_fkey" FOREIGN KEY ("tenant_id", "negotiation_id") REFERENCES "negotiations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negotiation_titles" ADD CONSTRAINT "negotiation_titles_tenant_id_title_id_fkey" FOREIGN KEY ("tenant_id", "title_id") REFERENCES "financial_titles"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Negociação de dívida: isolamento por empresa (RLS) e permissões do papel da aplicação.
GRANT SELECT, INSERT, UPDATE ON negotiations TO dh_app;
GRANT SELECT, INSERT ON negotiation_titles TO dh_app;
ALTER TABLE negotiations ENABLE ROW LEVEL SECURITY; ALTER TABLE negotiations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON negotiations TO dh_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE negotiation_titles ENABLE ROW LEVEL SECURITY; ALTER TABLE negotiation_titles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON negotiation_titles TO dh_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE negotiations ADD CONSTRAINT negotiations_valid CHECK (installments BETWEEN 1 AND 36 AND total_amount > 0 AND interest >= 0 AND fine >= 0 AND discount >= 0 AND status IN ('ACTIVE', 'CANCELLED'));
