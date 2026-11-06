-- O importador é idempotente e usa upsert em legacy_import_records.
-- A tabela já permitia SELECT/INSERT, mas o ramo de atualização também
-- precisa de UPDATE para reprocessar clientes já migrados.
GRANT UPDATE ON legacy_import_records TO dh_app;
