GRANT SELECT, INSERT, UPDATE ON channel_listings TO dh_app;
GRANT SELECT, INSERT, DELETE ON channel_category_mappings TO dh_app;
GRANT SELECT, INSERT ON price_history TO dh_app;   -- histórico imutável
GRANT USAGE ON SEQUENCE price_history_id_seq TO dh_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['channel_listings','channel_category_mappings','price_history']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO dh_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

ALTER TABLE channel_listings ADD CONSTRAINT cl_price_nonneg CHECK (price IS NULL OR price >= 0), ADD CONSTRAINT cl_qty_nonneg CHECK (last_published_qty IS NULL OR last_published_qty >= 0);
ALTER TABLE price_history ADD CONSTRAINT ph_price_nonneg CHECK (new_price >= 0);
