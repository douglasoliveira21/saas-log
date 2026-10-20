GRANT SELECT, INSERT, UPDATE ON fiscal_configurations, fiscal_documents, tax_rules, tax_rule_versions TO dh_app;
GRANT SELECT, INSERT, UPDATE ON fiscal_certificates, fiscal_series TO dh_app;
GRANT SELECT, INSERT, UPDATE ON fiscal_document_items TO dh_app;
GRANT SELECT, INSERT ON fiscal_xml_files, tax_calculations TO dh_app;   -- XML e cálculos: imutáveis

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fiscal_configurations','fiscal_certificates','fiscal_documents','fiscal_document_items','fiscal_xml_files',
                           'fiscal_series','tax_rules','tax_rule_versions','tax_calculations']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO dh_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

-- Um único certificado ATIVO por estabelecimento.
CREATE UNIQUE INDEX fiscal_certificates_one_active ON fiscal_certificates (tenant_id, establishment_id) WHERE status = 'ACTIVE';

-- Versões de regra APROVADAS são imutáveis: só podem ser substituídas (status) ou encerradas (valid_to).
CREATE OR REPLACE FUNCTION guard_tax_rule_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('APPROVED', 'SUPERSEDED') AND (
       NEW.config IS DISTINCT FROM OLD.config OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
       OR NEW.source_reference IS DISTINCT FROM OLD.source_reference OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.rule_id IS DISTINCT FROM OLD.rule_id OR NEW.approved_by_id IS DISTINCT FROM OLD.approved_by_id
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at) THEN
    RAISE EXCEPTION 'Versão de regra tributária aprovada é imutável; crie uma nova versão.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tax_rule_version_guard BEFORE UPDATE ON tax_rule_versions FOR EACH ROW EXECUTE FUNCTION guard_tax_rule_version();

-- Itens de documento fiscal importado: dados do XML não mudam; só o vínculo com produto pode ser ajustado.
CREATE OR REPLACE FUNCTION guard_fiscal_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.quantity IS DISTINCT FROM OLD.quantity OR NEW.unit_value IS DISTINCT FROM OLD.unit_value OR NEW.total_value IS DISTINCT FROM OLD.total_value
     OR NEW.ncm IS DISTINCT FROM OLD.ncm OR NEW.cfop IS DISTINCT FROM OLD.cfop OR NEW.declared_tax IS DISTINCT FROM OLD.declared_tax
     OR NEW.description IS DISTINCT FROM OLD.description THEN
    RAISE EXCEPTION 'Dados fiscais do item são imutáveis.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_item_guard BEFORE UPDATE ON fiscal_document_items FOR EACH ROW EXECUTE FUNCTION guard_fiscal_item();

ALTER TABLE fiscal_series ADD CONSTRAINT fs_last_nonneg CHECK (last >= 0);
ALTER TABLE fiscal_documents ADD CONSTRAINT fd_direction CHECK (direction IN ('ENTRY', 'EXIT'));
