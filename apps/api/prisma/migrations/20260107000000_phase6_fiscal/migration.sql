-- CreateTable
CREATE TABLE "fiscal_configurations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'HOMOLOGACAO',
    "document_types" TEXT[] DEFAULT ARRAY['NFE']::TEXT[],
    "nfe_series" INTEGER NOT NULL DEFAULT 1,
    "accountant_name" TEXT,
    "accountant_email" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "approved_by_id" UUID,
    "approved_at" TIMESTAMP(3),
    "notes" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fiscal_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fiscal_certificates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "cnpj" TEXT,
    "serial" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "not_before" TIMESTAMP(3) NOT NULL,
    "not_after" TIMESTAMP(3) NOT NULL,
    "pfx_enc" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "uploaded_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fiscal_certificates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fiscal_documents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "direction" TEXT NOT NULL,
    "model" TEXT NOT NULL DEFAULT '55',
    "status" TEXT NOT NULL,
    "access_key" TEXT,
    "series" INTEGER,
    "number" INTEGER,
    "environment" TEXT,
    "issued_at" TIMESTAMP(3),
    "establishment_id" UUID,
    "emitter_doc" TEXT,
    "emitter_name" TEXT,
    "emitter_uf" TEXT,
    "recipient_doc" TEXT,
    "total_products" DECIMAL(14,2),
    "total_invoice" DECIMAL(14,2),
    "total_freight" DECIMAL(14,2),
    "auth_protocol" TEXT,
    "auth_status_code" TEXT,
    "authenticity" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "issues" JSONB NOT NULL DEFAULT '[]',
    "installments" JSONB NOT NULL DEFAULT '[]',
    "supplier_id" UUID,
    "purchase_order_id" UUID,
    "receipt_id" UUID,
    "sales_order_id" UUID,
    "calculation_id" UUID,
    "provider_state" JSONB NOT NULL DEFAULT '{}',
    "imported_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fiscal_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fiscal_document_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "line" INTEGER NOT NULL,
    "supplier_code" TEXT,
    "gtin" TEXT,
    "description" TEXT NOT NULL,
    "ncm" TEXT,
    "cfop" TEXT,
    "unit" TEXT,
    "quantity" DECIMAL(14,4) NOT NULL,
    "unit_value" DECIMAL(14,6) NOT NULL,
    "total_value" DECIMAL(14,2) NOT NULL,
    "declared_tax" JSONB NOT NULL DEFAULT '{}',
    "product_id" UUID,
    "matched_by" TEXT,
    "stock_qty" INTEGER,

    CONSTRAINT "fiscal_document_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fiscal_xml_files" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'RECEIVED',
    "sha256" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "source" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fiscal_xml_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fiscal_series" (
    "tenant_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "model" TEXT NOT NULL DEFAULT '55',
    "series" INTEGER NOT NULL,
    "environment" TEXT NOT NULL,
    "last" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "fiscal_series_pkey" PRIMARY KEY ("tenant_id","establishment_id","model","series","environment")
);

-- CreateTable
CREATE TABLE "tax_rules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "origin_uf" CHAR(2),
    "dest_uf" CHAR(2),
    "ncm_prefix" TEXT,
    "regime" TEXT,
    "product_origin" INTEGER,
    "recipient_kind" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rule_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "valid_from" TIMESTAMP(3) NOT NULL,
    "valid_to" TIMESTAMP(3),
    "config" JSONB NOT NULL,
    "source_reference" TEXT NOT NULL,
    "created_by_id" UUID,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_rule_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_calculations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "engine_version" TEXT NOT NULL,
    "inputs" JSONB NOT NULL,
    "outputs" JSONB NOT NULL,
    "rule_version_ids" TEXT[],
    "pendencies" JSONB NOT NULL DEFAULT '[]',
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_calculations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_configurations_tenant_id_establishment_id_key" ON "fiscal_configurations"("tenant_id", "establishment_id");

-- CreateIndex
CREATE INDEX "fiscal_certificates_tenant_id_establishment_id_status_idx" ON "fiscal_certificates"("tenant_id", "establishment_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_certificates_tenant_id_id_key" ON "fiscal_certificates"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "fiscal_documents_tenant_id_direction_status_idx" ON "fiscal_documents"("tenant_id", "direction", "status");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_documents_tenant_id_access_key_key" ON "fiscal_documents"("tenant_id", "access_key");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_documents_tenant_id_id_key" ON "fiscal_documents"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_document_items_document_id_line_key" ON "fiscal_document_items"("document_id", "line");

-- CreateIndex
CREATE INDEX "fiscal_xml_files_tenant_id_document_id_idx" ON "fiscal_xml_files"("tenant_id", "document_id");

-- CreateIndex
CREATE INDEX "tax_rules_tenant_id_operation_active_idx" ON "tax_rules"("tenant_id", "operation", "active");

-- CreateIndex
CREATE UNIQUE INDEX "tax_rules_tenant_id_id_key" ON "tax_rules"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tax_rule_versions_rule_id_version_key" ON "tax_rule_versions"("rule_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "tax_rule_versions_tenant_id_id_key" ON "tax_rule_versions"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "tax_calculations_tenant_id_created_at_idx" ON "tax_calculations"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "tax_calculations_tenant_id_id_key" ON "tax_calculations"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "fiscal_configurations" ADD CONSTRAINT "fiscal_configurations_tenant_id_establishment_id_fkey" FOREIGN KEY ("tenant_id", "establishment_id") REFERENCES "establishments"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_certificates" ADD CONSTRAINT "fiscal_certificates_tenant_id_establishment_id_fkey" FOREIGN KEY ("tenant_id", "establishment_id") REFERENCES "establishments"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_tenant_id_supplier_id_fkey" FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "suppliers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_tenant_id_sales_order_id_fkey" FOREIGN KEY ("tenant_id", "sales_order_id") REFERENCES "sales_orders"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_document_items" ADD CONSTRAINT "fiscal_document_items_tenant_id_document_id_fkey" FOREIGN KEY ("tenant_id", "document_id") REFERENCES "fiscal_documents"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_document_items" ADD CONSTRAINT "fiscal_document_items_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_xml_files" ADD CONSTRAINT "fiscal_xml_files_tenant_id_document_id_fkey" FOREIGN KEY ("tenant_id", "document_id") REFERENCES "fiscal_documents"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rule_versions" ADD CONSTRAINT "tax_rule_versions_tenant_id_rule_id_fkey" FOREIGN KEY ("tenant_id", "rule_id") REFERENCES "tax_rules"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

