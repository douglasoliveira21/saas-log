-- Papel de runtime (sem BYPASSRLS, sem ownership). A senha/LOGIN é definida por scripts/db-setup.ts.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dh_app') THEN
    CREATE ROLE dh_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO dh_app;

-- Contexto da requisição (definido por transação: set_config(..., true)).
CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

-- Permissões mínimas por tabela.
GRANT SELECT ON plans TO dh_app;
GRANT SELECT, INSERT, UPDATE ON users, refresh_sessions TO dh_app;
GRANT SELECT, INSERT, UPDATE ON tenants, roles, memberships, companies, establishments, warehouses TO dh_app;
GRANT SELECT, INSERT, DELETE ON role_permissions TO dh_app;
GRANT SELECT, INSERT ON audit_logs TO dh_app;       -- append-only: sem UPDATE/DELETE
GRANT USAGE ON SEQUENCE audit_logs_id_seq TO dh_app;

-- RLS habilitado e FORÇADO (vale também para o dono da tabela).
ALTER TABLE tenants          ENABLE ROW LEVEL SECURITY;  ALTER TABLE tenants          FORCE ROW LEVEL SECURITY;
ALTER TABLE roles            ENABLE ROW LEVEL SECURITY;  ALTER TABLE roles            FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;  ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
ALTER TABLE memberships      ENABLE ROW LEVEL SECURITY;  ALTER TABLE memberships      FORCE ROW LEVEL SECURITY;
ALTER TABLE companies        ENABLE ROW LEVEL SECURITY;  ALTER TABLE companies        FORCE ROW LEVEL SECURITY;
ALTER TABLE establishments   ENABLE ROW LEVEL SECURITY;  ALTER TABLE establishments   FORCE ROW LEVEL SECURITY;
ALTER TABLE warehouses       ENABLE ROW LEVEL SECURITY;  ALTER TABLE warehouses       FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_logs       ENABLE ROW LEVEL SECURITY;  ALTER TABLE audit_logs       FORCE ROW LEVEL SECURITY;

-- Tabelas puramente do tenant.
CREATE POLICY tenant_isolation ON role_permissions TO dh_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON companies TO dh_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON establishments TO dh_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON warehouses TO dh_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON audit_logs TO dh_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- Memberships: o tenant vê todas as suas; o usuário enxerga as próprias (para listar seus tenants no login).
CREATE POLICY membership_select ON memberships FOR SELECT TO dh_app
  USING (tenant_id = app_tenant_id() OR user_id = app_user_id());
CREATE POLICY membership_write ON memberships FOR INSERT TO dh_app
  WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY membership_update ON memberships FOR UPDATE TO dh_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- Papéis: legíveis dentro do tenant ou quando referenciados por uma membership do próprio usuário.
CREATE POLICY roles_select ON roles FOR SELECT TO dh_app
  USING (tenant_id = app_tenant_id()
         OR id IN (SELECT role_id FROM memberships WHERE user_id = app_user_id()));
CREATE POLICY roles_insert ON roles FOR INSERT TO dh_app WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY roles_update ON roles FOR UPDATE TO dh_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- Tenants: leitura do corrente ou dos tenants em que o usuário é membro; escrita só no corrente.
CREATE POLICY tenants_select ON tenants FOR SELECT TO dh_app
  USING (id = app_tenant_id()
         OR id IN (SELECT tenant_id FROM memberships WHERE user_id = app_user_id()));
CREATE POLICY tenants_insert ON tenants FOR INSERT TO dh_app WITH CHECK (id = app_tenant_id());
CREATE POLICY tenants_update ON tenants FOR UPDATE TO dh_app
  USING (id = app_tenant_id()) WITH CHECK (id = app_tenant_id());

-- Plano padrão de avaliação.
INSERT INTO plans (id, code, name, limits, active)
VALUES (gen_random_uuid(), 'trial', 'Avaliação', '{"users":5,"establishments":2,"warehouses":3}', true)
ON CONFLICT (code) DO NOTHING;
