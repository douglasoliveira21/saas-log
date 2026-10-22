-- NFC-e dividida pelo limite de valor do cupom: cupom N de M do mesmo pedido.
ALTER TABLE fiscal_documents ADD COLUMN split_index integer, ADD COLUMN split_total integer;
