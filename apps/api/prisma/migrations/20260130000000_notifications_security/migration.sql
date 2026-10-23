-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "notify_opt_out" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "recovery_codes" JSONB,
ADD COLUMN     "totp_enabled_at" TIMESTAMP(3),
ADD COLUMN     "totp_secret" TEXT;

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_invites" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "invited_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_connections" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "instance_name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DISCONNECTED',
    "phone" TEXT,
    "last_error" TEXT,
    "connected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_rules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "email_enabled" BOOLEAN NOT NULL DEFAULT false,
    "whatsapp_enabled" BOOLEAN NOT NULL DEFAULT false,
    "days_before" INTEGER NOT NULL DEFAULT 2,
    "min_overdue_days" INTEGER NOT NULL DEFAULT 1,
    "repeat_every_days" INTEGER NOT NULL DEFAULT 7,
    "order_statuses" JSONB NOT NULL DEFAULT '["CONFIRMED","SHIPPED","DELIVERED"]',
    "subject" TEXT,
    "body" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_logs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "customer_id" UUID,
    "ref_type" TEXT,
    "ref_id" TEXT,
    "dedupe_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),

    CONSTRAINT "notification_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goal_bonus_tiers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "min_pct" DECIMAL(7,2) NOT NULL,
    "kind" TEXT NOT NULL,
    "percent" DECIMAL(7,4),
    "fixed_amount" DECIMAL(14,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goal_bonus_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goal_bonuses" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "salesperson_id" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "goal_amount" DECIMAL(14,2) NOT NULL,
    "achieved" DECIMAL(14,2) NOT NULL,
    "attainment_pct" DECIMAL(9,2) NOT NULL,
    "tier_id" UUID,
    "tier_name" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'EARNED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMP(3),

    CONSTRAINT "goal_bonuses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_invites_token_hash_key" ON "user_invites"("token_hash");

-- CreateIndex
CREATE INDEX "user_invites_tenant_id_email_idx" ON "user_invites"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_connections_tenant_id_key" ON "whatsapp_connections"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_connections_instance_name_key" ON "whatsapp_connections"("instance_name");

-- CreateIndex
CREATE UNIQUE INDEX "notification_rules_tenant_id_type_key" ON "notification_rules"("tenant_id", "type");

-- CreateIndex
CREATE INDEX "notification_logs_tenant_id_status_created_at_idx" ON "notification_logs"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notification_logs_tenant_id_dedupe_key_channel_key" ON "notification_logs"("tenant_id", "dedupe_key", "channel");

-- CreateIndex
CREATE INDEX "goal_bonus_tiers_tenant_id_active_idx" ON "goal_bonus_tiers"("tenant_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "goal_bonuses_tenant_id_salesperson_id_period_key" ON "goal_bonuses"("tenant_id", "salesperson_id", "period");


-- Redefinição de senha: como users/refresh_sessions, não é por empresa (o usuário pode ter várias).
GRANT SELECT, INSERT, UPDATE ON password_reset_tokens TO dh_app;

-- Tabelas por empresa: isolamento (RLS) e permissões.
GRANT SELECT, INSERT, UPDATE, DELETE ON user_invites, whatsapp_connections, notification_rules, notification_logs, goal_bonus_tiers, goal_bonuses TO dh_app;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['user_invites', 'whatsapp_connections', 'notification_rules', 'notification_logs', 'goal_bonus_tiers', 'goal_bonuses'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO dh_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

ALTER TABLE notification_rules ADD CONSTRAINT notification_rules_valid CHECK (type IN ('INVOICE_DUE', 'ORDER_STATUS', 'COLLECTION') AND days_before BETWEEN 0 AND 30 AND min_overdue_days BETWEEN 1 AND 90 AND repeat_every_days BETWEEN 1 AND 90);
ALTER TABLE notification_logs ADD CONSTRAINT notification_logs_valid CHECK (channel IN ('EMAIL', 'WHATSAPP') AND status IN ('QUEUED', 'SENT', 'FAILED', 'SKIPPED'));
ALTER TABLE whatsapp_connections ADD CONSTRAINT whatsapp_status CHECK (status IN ('DISCONNECTED', 'CONNECTING', 'CONNECTED'));
ALTER TABLE goal_bonus_tiers ADD CONSTRAINT goal_tier_valid CHECK (min_pct > 0 AND ((kind = 'PERCENT' AND percent IS NOT NULL AND percent >= 0) OR (kind = 'FIXED' AND fixed_amount IS NOT NULL AND fixed_amount >= 0)));
ALTER TABLE goal_bonuses ADD CONSTRAINT goal_bonus_status CHECK (status IN ('EARNED', 'PAID') AND amount >= 0);
ALTER TABLE users ADD CONSTRAINT users_totp_consistent CHECK (totp_enabled_at IS NULL OR totp_secret IS NOT NULL);

-- Varredura em segundo plano: quais empresas têm aviso ligado ou fila pendente (só os ids; os dados são lidos já com o contexto da empresa).
CREATE FUNCTION list_notification_tenants() RETURNS TABLE (tenant_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT tenant_id FROM notification_rules WHERE email_enabled OR whatsapp_enabled
  UNION SELECT tenant_id FROM notification_logs WHERE status = 'QUEUED'
$$;
REVOKE ALL ON FUNCTION list_notification_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_notification_tenants() TO dh_app;
