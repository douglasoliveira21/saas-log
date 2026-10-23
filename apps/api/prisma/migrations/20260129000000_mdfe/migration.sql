-- AlterTable
ALTER TABLE "drivers" ADD COLUMN     "cpf" TEXT;

-- AlterTable
ALTER TABLE "vehicles" ADD COLUMN     "body_code" TEXT NOT NULL DEFAULT '00',
ADD COLUMN     "plate_uf" CHAR(2),
ADD COLUMN     "renavam" TEXT,
ADD COLUMN     "tare_kg" INTEGER;

-- CreateTable
CREATE TABLE "mdfe_documents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "route_id" UUID NOT NULL,
    "vehicle_id" UUID,
    "establishment_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "environment" TEXT NOT NULL DEFAULT 'HOMOLOGACAO',
    "series" INTEGER,
    "number" INTEGER,
    "access_key" TEXT,
    "issued_at" TIMESTAMP(3),
    "protocol" TEXT,
    "close_protocol" TEXT,
    "cancel_protocol" TEXT,
    "status_code" TEXT,
    "status_message" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "issues" JSONB NOT NULL DEFAULT '[]',
    "signed_xml" TEXT,
    "authorized_xml" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mdfe_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mdfe_documents_tenant_id_route_id_idx" ON "mdfe_documents"("tenant_id", "route_id");

-- CreateIndex
CREATE INDEX "mdfe_documents_tenant_id_status_idx" ON "mdfe_documents"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "mdfe_documents_tenant_id_access_key_key" ON "mdfe_documents"("tenant_id", "access_key");

-- CreateIndex
CREATE UNIQUE INDEX "mdfe_documents_tenant_id_id_key" ON "mdfe_documents"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "mdfe_documents" ADD CONSTRAINT "mdfe_documents_tenant_id_vehicle_id_fkey" FOREIGN KEY ("tenant_id", "vehicle_id") REFERENCES "vehicles"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- MDF-e: isolamento por empresa (RLS), permissões e invariantes.
GRANT SELECT, INSERT, UPDATE ON mdfe_documents TO dh_app;
ALTER TABLE mdfe_documents ENABLE ROW LEVEL SECURITY; ALTER TABLE mdfe_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mdfe_documents TO dh_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE mdfe_documents ADD CONSTRAINT mdfe_status CHECK (status IN ('DRAFT', 'TRANSMITTING', 'PENDING_CONSULT', 'AUTHORIZED', 'REJECTED', 'CLOSED', 'CANCELLED'));
-- Um MDF-e ativo por viagem.
CREATE UNIQUE INDEX mdfe_one_active_per_route ON mdfe_documents (tenant_id, route_id) WHERE status NOT IN ('CANCELLED', 'REJECTED');
ALTER TABLE vehicles ADD CONSTRAINT vehicles_mdfe_valid CHECK ((tare_kg IS NULL OR tare_kg > 0) AND body_code IN ('00', '01', '02', '03', '04', '05'));
