GRANT SELECT, INSERT, UPDATE ON financial_accounts, financial_categories, cost_centers, financial_titles, bank_statement_lines,
  marketplace_settlements, packagings, shipments, report_exports TO dh_app;
GRANT SELECT, INSERT ON financial_settlements TO dh_app;       -- baixas imutáveis: correção = estorno
GRANT SELECT, INSERT ON shipment_events TO dh_app;              -- histórico de rastreamento imutável
GRANT USAGE ON SEQUENCE shipment_events_id_seq TO dh_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['financial_accounts','financial_categories','cost_centers','financial_titles','financial_settlements','bank_statement_lines',
                           'marketplace_settlements','packagings','shipments','shipment_events','report_exports']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO dh_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

-- Invariantes financeiras no banco
ALTER TABLE financial_titles
  ADD CONSTRAINT ft_direction CHECK (direction IN ('PAYABLE', 'RECEIVABLE')),
  ADD CONSTRAINT ft_amount_pos CHECK (amount > 0),
  ADD CONSTRAINT ft_paid_range CHECK (paid_principal >= 0 AND paid_principal <= amount),
  ADD CONSTRAINT ft_installment CHECK (installment_no >= 1 AND installment_no <= installment_total);
ALTER TABLE financial_settlements
  ADD CONSTRAINT fs_kind CHECK (kind IN ('SETTLEMENT', 'REVERSAL')),
  ADD CONSTRAINT fs_sign CHECK ((kind = 'SETTLEMENT' AND principal > 0 AND interest >= 0 AND fine >= 0 AND discount >= 0)
                              OR (kind = 'REVERSAL' AND principal < 0 AND interest <= 0 AND fine <= 0 AND discount <= 0 AND reversal_of_id IS NOT NULL));
ALTER TABLE shipments ADD CONSTRAINT sh_dims CHECK ((weight_g IS NULL OR weight_g >= 0) AND (cost IS NULL OR cost >= 0));
ALTER TABLE packagings ADD CONSTRAINT pk_dims CHECK (length_mm > 0 AND width_mm > 0 AND height_mm > 0 AND max_weight_g > 0 AND tare_g >= 0);
