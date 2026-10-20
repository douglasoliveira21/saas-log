-- Grants (runtime dh_app). Razão e itens de reserva: sem UPDATE/DELETE onde a imutabilidade importa.
GRANT SELECT, INSERT, UPDATE ON product_categories, products, suppliers, stock_balances, stock_reservations,
  inventory_counts, inventory_count_items TO dh_app;
GRANT SELECT, INSERT, DELETE ON product_suppliers TO dh_app;
GRANT SELECT, INSERT ON stock_movements TO dh_app;   -- razão imutável

-- RLS por tenant
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['product_categories','products','suppliers','product_suppliers','stock_balances',
                           'stock_movements','stock_reservations','inventory_counts','inventory_count_items']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO dh_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

-- Invariantes de estoque garantidas pelo próprio banco (última linha de defesa contra venda acima do saldo).
ALTER TABLE stock_balances
  ADD CONSTRAINT stock_on_hand_nonneg CHECK (on_hand >= 0),
  ADD CONSTRAINT stock_reserved_nonneg CHECK (reserved >= 0),
  ADD CONSTRAINT stock_blocked_nonneg CHECK (blocked >= 0),
  ADD CONSTRAINT stock_available_nonneg CHECK (on_hand - reserved - blocked >= 0);
ALTER TABLE stock_movements ADD CONSTRAINT movement_qty_nonzero CHECK (quantity <> 0);
ALTER TABLE stock_reservations ADD CONSTRAINT reservation_qty_positive CHECK (quantity > 0);
