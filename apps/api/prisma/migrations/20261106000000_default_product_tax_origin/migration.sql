-- Assume origem nacional para produtos existentes e novos, mantendo a edição manual.
UPDATE products SET tax_origin = 0 WHERE tax_origin IS NULL;
ALTER TABLE products ALTER COLUMN tax_origin SET DEFAULT 0;
