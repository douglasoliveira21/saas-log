ALTER TABLE establishments ADD COLUMN ibge_code text;
ALTER TABLE customers ADD COLUMN ibge_code text;
GRANT SELECT, INSERT, UPDATE ON establishments, customers TO dh_app;
