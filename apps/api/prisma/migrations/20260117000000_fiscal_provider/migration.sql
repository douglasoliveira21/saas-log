-- CreateTable
CREATE TABLE "fiscal_provider_credentials" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "creds_enc" TEXT NOT NULL,
    "hint_homologacao" TEXT,
    "hint_producao" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fiscal_provider_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_provider_credentials_tenant_id_establishment_id_key" ON "fiscal_provider_credentials"("tenant_id", "establishment_id");


-- RLS: credenciais do provedor fiscal isoladas por empresa (o token fica cifrado; só a aplicação o decifra).
GRANT SELECT, INSERT, UPDATE, DELETE ON fiscal_provider_credentials TO dh_app;
ALTER TABLE fiscal_provider_credentials ENABLE ROW LEVEL SECURITY; ALTER TABLE fiscal_provider_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fiscal_provider_credentials TO dh_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE fiscal_provider_credentials ADD CONSTRAINT fiscal_provider_name_valid CHECK (provider IN ('FOCUS_NFE'));
