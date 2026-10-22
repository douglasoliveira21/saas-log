-- CreateTable
CREATE TABLE "fiscal_voids" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "series" INTEGER NOT NULL,
    "from_number" INTEGER NOT NULL,
    "to_number" INTEGER NOT NULL,
    "environment" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "protocol" TEXT NOT NULL,
    "status_code" TEXT NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fiscal_voids_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fiscal_voids_tenant_id_establishment_id_model_series_idx" ON "fiscal_voids"("tenant_id", "establishment_id", "model", "series");


-- Emissão direta na SEFAZ: novo valor de provedor e RLS da inutilização.
ALTER TABLE fiscal_provider_credentials DROP CONSTRAINT fiscal_provider_name_valid;
ALTER TABLE fiscal_provider_credentials ADD CONSTRAINT fiscal_provider_name_valid CHECK (provider IN ('FOCUS_NFE', 'SEFAZ_DIRECT'));
GRANT SELECT, INSERT ON fiscal_voids TO dh_app; -- registro imutável da inutilização
ALTER TABLE fiscal_voids ENABLE ROW LEVEL SECURITY; ALTER TABLE fiscal_voids FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fiscal_voids TO dh_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE fiscal_voids ADD CONSTRAINT fiscal_voids_range CHECK (from_number >= 1 AND to_number >= from_number AND model IN ('55', '65'));
