-- AlterTable
ALTER TABLE "fiscal_documents" ADD COLUMN     "purpose" TEXT NOT NULL DEFAULT 'NORMAL',
ADD COLUMN     "ref_document_id" UUID,
ADD COLUMN     "return_id" UUID;


-- Uma só NF-e de devolução ativa por devolução registrada; finalidades válidas.
CREATE UNIQUE INDEX fiscal_documents_one_return_doc ON fiscal_documents (tenant_id, return_id) WHERE return_id IS NOT NULL AND status <> 'CANCELLED';
ALTER TABLE fiscal_documents ADD CONSTRAINT fiscal_documents_purpose CHECK (purpose IN ('NORMAL', 'RETURN_SALE'));
