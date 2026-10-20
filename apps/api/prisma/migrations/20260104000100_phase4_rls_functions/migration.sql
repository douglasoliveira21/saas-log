GRANT SELECT, INSERT, UPDATE ON marketplace_connections, external_entity_mappings, webhook_events, background_jobs TO dh_app;
GRANT SELECT, INSERT ON integration_logs TO dh_app;      -- append-only
GRANT USAGE ON SEQUENCE integration_logs_id_seq TO dh_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['marketplace_connections','external_entity_mappings','webhook_events','integration_logs','background_jobs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO dh_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

ALTER TABLE background_jobs ADD CONSTRAINT job_attempts_nonneg CHECK (attempts >= 0 AND max_attempts BETWEEN 1 AND 20);

-- O worker precisa enxergar jobs de TODOS os tenants. Em vez de dar BYPASSRLS ao papel de runtime, expomos duas
-- funções estreitas (SECURITY DEFINER, dono = superusuário que roda as migrações). Todo o processamento posterior
-- de cada job volta a ocorrer com o contexto RLS do tenant do job.
CREATE OR REPLACE FUNCTION claim_background_jobs(p_limit int, p_worker text)
RETURNS SETOF background_jobs LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE background_jobs SET status = 'RUNNING', locked_at = now(), locked_by = p_worker, attempts = attempts + 1
  WHERE id IN (
    SELECT id FROM background_jobs
    WHERE (status = 'QUEUED' AND run_at <= now())
       OR (status = 'RUNNING' AND locked_at < now() - interval '5 minutes')   -- worker que morreu no meio
    ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT p_limit)
  RETURNING *;
$$;

CREATE OR REPLACE FUNCTION list_active_connections()
RETURNS TABLE (tenant_id uuid, id uuid, provider text, config jsonb, token_expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT tenant_id, id, provider, config, token_expires_at FROM marketplace_connections WHERE status = 'ACTIVE';
$$;

REVOKE ALL ON FUNCTION claim_background_jobs(int, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION list_active_connections() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_background_jobs(int, text) TO dh_app;
GRANT EXECUTE ON FUNCTION list_active_connections() TO dh_app;
