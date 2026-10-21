-- Logotipo do tenant: isolado por RLS; só imagens raster pequenas (o servidor valida o conteúdo; o banco repete os limites).
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_branding TO dh_app;
ALTER TABLE tenant_branding ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_branding FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_branding TO dh_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE tenant_branding ADD CONSTRAINT tenant_branding_size CHECK (octet_length(logo) BETWEEN 100 AND 1048576);
ALTER TABLE tenant_branding ADD CONSTRAINT tenant_branding_type CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp'));
