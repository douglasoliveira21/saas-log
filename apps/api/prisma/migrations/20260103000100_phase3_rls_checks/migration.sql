GRANT SELECT, INSERT, UPDATE ON tenant_settings, document_counters, customers, salespeople, commission_rules,
  sales_orders, return_requests, sales_commissions, purchase_orders, goods_receipts TO dh_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON sales_order_items, purchase_order_items TO dh_app;   -- itens editáveis só em rascunho (regra na aplicação)
GRANT SELECT, INSERT, UPDATE ON goods_receipt_items TO dh_app;
GRANT SELECT, INSERT ON return_items TO dh_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_settings','document_counters','customers','salespeople','commission_rules','sales_orders',
    'sales_order_items','return_requests','return_items','sales_commissions','purchase_orders','purchase_order_items',
    'goods_receipts','goods_receipt_items']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO dh_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

ALTER TABLE sales_order_items ADD CONSTRAINT soi_qty_pos CHECK (quantity > 0),
  ADD CONSTRAINT soi_price_nonneg CHECK (unit_price >= 0 AND total >= 0),
  ADD CONSTRAINT soi_discount_range CHECK (discount_pct >= 0 AND discount_pct <= 100);
ALTER TABLE return_items ADD CONSTRAINT ri_qty_pos CHECK (quantity > 0);
ALTER TABLE purchase_order_items ADD CONSTRAINT poi_qty_pos CHECK (qty_ordered > 0),
  ADD CONSTRAINT poi_received_range CHECK (qty_received >= 0 AND qty_received <= qty_ordered),
  ADD CONSTRAINT poi_cost_nonneg CHECK (unit_cost >= 0);
ALTER TABLE goods_receipt_items ADD CONSTRAINT gri_qty_pos CHECK (quantity > 0);
ALTER TABLE commission_rules ADD CONSTRAINT cr_value CHECK (
  (kind = 'PERCENT' AND percent IS NOT NULL AND percent >= 0 AND percent <= 100) OR
  (kind = 'FIXED_PER_UNIT' AND fixed_amount IS NOT NULL AND fixed_amount >= 0));
