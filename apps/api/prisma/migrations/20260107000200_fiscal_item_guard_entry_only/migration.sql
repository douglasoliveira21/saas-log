-- Itens de documentos de ENTRADA (XML recebido) são imutáveis. Itens de documentos de SAÍDA em preparação precisam
-- ser recalculados (CFOP/impostos) a cada revalidação, então a regra só vale para ENTRY.
CREATE OR REPLACE FUNCTION guard_fiscal_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE dir text;
BEGIN
  SELECT direction INTO dir FROM fiscal_documents WHERE id = NEW.document_id;
  IF dir = 'ENTRY' AND (
       NEW.quantity IS DISTINCT FROM OLD.quantity OR NEW.unit_value IS DISTINCT FROM OLD.unit_value OR NEW.total_value IS DISTINCT FROM OLD.total_value
       OR NEW.ncm IS DISTINCT FROM OLD.ncm OR NEW.cfop IS DISTINCT FROM OLD.cfop OR NEW.declared_tax IS DISTINCT FROM OLD.declared_tax
       OR NEW.description IS DISTINCT FROM OLD.description) THEN
    RAISE EXCEPTION 'Dados fiscais do item são imutáveis.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
