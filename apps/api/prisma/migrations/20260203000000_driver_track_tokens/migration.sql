-- CreateTable
CREATE TABLE "driver_track_tokens" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "driver_track_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "driver_track_tokens_token_hash_key" ON "driver_track_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "driver_track_tokens_tenant_id_driver_id_idx" ON "driver_track_tokens"("tenant_id", "driver_id");

-- AddForeignKey
ALTER TABLE "driver_track_tokens" ADD CONSTRAINT "driver_track_tokens_tenant_id_driver_id_fkey" FOREIGN KEY ("tenant_id", "driver_id") REFERENCES "drivers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Acesso e isolamento por empresa (como as demais tabelas)
GRANT SELECT, INSERT, UPDATE, DELETE ON driver_track_tokens TO dh_app;
ALTER TABLE driver_track_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_track_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON driver_track_tokens TO dh_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- A rota pública do aplicativo não sabe a empresa: acha o motorista pelo hash do token. Só devolve se tudo continua válido:
-- token não revogado nem vencido, motorista ativo, usuário ativo e participação ativa na empresa.
CREATE OR REPLACE FUNCTION find_driver_by_track_token(p_hash text)
RETURNS TABLE (tenant_id uuid, driver_id uuid, user_id uuid, token_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.tenant_id, t.driver_id, d.user_id, t.id
  FROM driver_track_tokens t
  JOIN drivers d ON d.tenant_id = t.tenant_id AND d.id = t.driver_id
  JOIN users u ON u.id = d.user_id
  JOIN memberships m ON m.tenant_id = t.tenant_id AND m.user_id = d.user_id
  WHERE t.token_hash = p_hash AND t.revoked_at IS NULL AND t.expires_at > now()
    AND d.active AND u.status = 'ACTIVE' AND m.status = 'ACTIVE'
$$;
REVOKE ALL ON FUNCTION find_driver_by_track_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION find_driver_by_track_token(text) TO dh_app;
