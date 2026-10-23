-- CreateTable
CREATE TABLE "fiscal_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "tp_evento" TEXT NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 1,
    "text" TEXT,
    "status" TEXT NOT NULL,
    "status_code" TEXT,
    "protocol" TEXT,
    "message" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fiscal_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fiscal_events_tenant_id_document_id_tp_evento_seq_idx" ON "fiscal_events"("tenant_id", "document_id", "tp_evento", "seq");

-- AddForeignKey
ALTER TABLE "fiscal_events" ADD CONSTRAINT "fiscal_events_tenant_id_document_id_fkey" FOREIGN KEY ("tenant_id", "document_id") REFERENCES "fiscal_documents"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Eventos fiscais (CC-e e manifestação): isolamento por empresa (RLS); registro imutável.
GRANT SELECT, INSERT ON fiscal_events TO dh_app;
ALTER TABLE fiscal_events ENABLE ROW LEVEL SECURITY; ALTER TABLE fiscal_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fiscal_events TO dh_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE fiscal_events ADD CONSTRAINT fiscal_events_valid CHECK (kind IN ('CCE', 'MANIFEST') AND status IN ('REGISTERED', 'REJECTED') AND seq BETWEEN 1 AND 20);
