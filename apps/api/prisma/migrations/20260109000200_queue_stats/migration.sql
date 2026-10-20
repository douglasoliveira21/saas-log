-- Estatísticas globais da fila (sem conteúdo) para /metrics e /health/ready.
CREATE OR REPLACE FUNCTION queue_stats()
RETURNS TABLE (status text, jobs bigint, oldest_ready timestamp)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT j.status::text, count(*), min(j.run_at) FROM background_jobs j GROUP BY j.status;
$$;
REVOKE ALL ON FUNCTION queue_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION queue_stats() TO dh_app;
