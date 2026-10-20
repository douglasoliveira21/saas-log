GRANT SELECT, INSERT, UPDATE ON external_orders TO dh_app;
ALTER TABLE external_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON external_orders TO dh_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- Notificações de alguns provedores chegam em UM endereço por aplicativo (não por conexão) e identificam apenas a conta
-- do vendedor. Esta função estreita (SECURITY DEFINER) devolve somente tenant/conexão para resolver o destino; os dados
-- da conexão continuam protegidos por RLS.
CREATE OR REPLACE FUNCTION find_connections_by_account(p_provider text, p_account text)
RETURNS TABLE (tenant_id uuid, id uuid, status text)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT tenant_id, id, status::text FROM marketplace_connections
  WHERE provider = p_provider AND external_account_id = p_account AND status <> 'DISCONNECTED';
$$;
REVOKE ALL ON FUNCTION find_connections_by_account(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION find_connections_by_account(text, text) TO dh_app;
