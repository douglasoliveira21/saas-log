CREATE TABLE bank_integrations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  provider text NOT NULL,
  environment text NOT NULL DEFAULT 'SANDBOX',
  client_id_enc text,
  client_secret_enc text,
  certificate_enc text,
  certificate_password_enc text,
  cooperative text,
  agency text,
  account_number text,
  wallet text,
  pix_key text,
  webhook_registered_at timestamp,
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT bank_integrations_provider_ck CHECK (provider IN ('SICOOB')),
  CONSTRAINT bank_integrations_environment_ck CHECK (environment IN ('SANDBOX', 'PRODUCTION'))
);
GRANT SELECT, INSERT, UPDATE ON bank_integrations TO dh_app;
ALTER TABLE bank_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_integrations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bank_integrations TO dh_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
