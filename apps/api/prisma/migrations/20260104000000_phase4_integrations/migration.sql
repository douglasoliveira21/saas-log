-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('NOT_CONNECTED', 'AWAITING_AUTHORIZATION', 'TEST_PENDING', 'INCOMPLETE_CONFIG', 'CONNECTED', 'ACTIVE', 'PAUSED', 'TOKEN_EXPIRED', 'SYNC_ERROR', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED');

-- CreateTable
CREATE TABLE "marketplace_connections" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'NOT_CONNECTED',
    "external_account_id" TEXT,
    "warehouse_id" UUID,
    "config" JSONB NOT NULL DEFAULT '{}',
    "credentials_enc" TEXT,
    "webhook_secret_enc" TEXT,
    "oauth_nonce" TEXT,
    "token_expires_at" TIMESTAMP(3),
    "tested_at" TIMESTAMP(3),
    "last_sync_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketplace_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_entity_mappings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "internal_id" UUID,
    "external_id" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_entity_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "event_type" TEXT,
    "payload" JSONB NOT NULL,
    "status" "WebhookStatus" NOT NULL DEFAULT 'RECEIVED',
    "error" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_logs" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID,
    "level" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status_code" INTEGER,
    "duration_ms" INTEGER,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "background_jobs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMP(3),
    "locked_by" TEXT,
    "last_error" TEXT,
    "result" JSONB,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "background_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "marketplace_connections_tenant_id_status_idx" ON "marketplace_connections"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_connections_tenant_id_provider_external_account_key" ON "marketplace_connections"("tenant_id", "provider", "external_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_connections_tenant_id_id_key" ON "marketplace_connections"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "external_entity_mappings_tenant_id_entity_type_internal_id_idx" ON "external_entity_mappings"("tenant_id", "entity_type", "internal_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_entity_mappings_connection_id_entity_type_external_key" ON "external_entity_mappings"("connection_id", "entity_type", "external_id");

-- CreateIndex
CREATE INDEX "webhook_events_tenant_id_status_idx" ON "webhook_events"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_connection_id_dedupe_key_key" ON "webhook_events"("connection_id", "dedupe_key");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_tenant_id_id_key" ON "webhook_events"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "integration_logs_tenant_id_connection_id_created_at_idx" ON "integration_logs"("tenant_id", "connection_id", "created_at");

-- CreateIndex
CREATE INDEX "background_jobs_status_run_at_idx" ON "background_jobs"("status", "run_at");

-- CreateIndex
CREATE INDEX "background_jobs_tenant_id_connection_id_status_idx" ON "background_jobs"("tenant_id", "connection_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "background_jobs_tenant_id_idempotency_key_key" ON "background_jobs"("tenant_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "marketplace_connections" ADD CONSTRAINT "marketplace_connections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_connections" ADD CONSTRAINT "marketplace_connections_tenant_id_warehouse_id_fkey" FOREIGN KEY ("tenant_id", "warehouse_id") REFERENCES "warehouses"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_entity_mappings" ADD CONSTRAINT "external_entity_mappings_tenant_id_connection_id_fkey" FOREIGN KEY ("tenant_id", "connection_id") REFERENCES "marketplace_connections"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_tenant_id_connection_id_fkey" FOREIGN KEY ("tenant_id", "connection_id") REFERENCES "marketplace_connections"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_logs" ADD CONSTRAINT "integration_logs_tenant_id_connection_id_fkey" FOREIGN KEY ("tenant_id", "connection_id") REFERENCES "marketplace_connections"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "background_jobs" ADD CONSTRAINT "background_jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "background_jobs" ADD CONSTRAINT "background_jobs_tenant_id_connection_id_fkey" FOREIGN KEY ("tenant_id", "connection_id") REFERENCES "marketplace_connections"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

