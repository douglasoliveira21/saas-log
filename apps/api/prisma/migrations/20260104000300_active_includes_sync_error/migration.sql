-- Conexões em SYNC_ERROR continuam sendo reconciliadas: é a reconciliação bem-sucedida que as devolve a ACTIVE.
CREATE OR REPLACE FUNCTION list_active_connections()
RETURNS TABLE (tenant_id uuid, id uuid, provider text, config jsonb, token_expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT tenant_id, id, provider, config, token_expires_at FROM marketplace_connections WHERE status IN ('ACTIVE', 'SYNC_ERROR');
$$;
