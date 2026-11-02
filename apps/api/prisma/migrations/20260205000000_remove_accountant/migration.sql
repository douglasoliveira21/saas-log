-- Remove o ator "contador" e o fluxo obrigatório de validação externa.
-- As associações desse papel são removidas; o usuário permanece cadastrado e pode receber outro papel explicitamente.
DELETE FROM memberships
WHERE role_id IN (SELECT id FROM roles WHERE key = 'accountant' AND is_system = TRUE);

DELETE FROM role_permissions
WHERE role_id IN (SELECT id FROM roles WHERE key = 'accountant' AND is_system = TRUE)
   OR permission = 'fiscal.approve';

DELETE FROM roles WHERE key = 'accountant' AND is_system = TRUE;

UPDATE fiscal_configurations
SET status = 'APPROVED'
WHERE status IN ('DRAFT', 'PENDING_ACCOUNTANT');

ALTER TABLE fiscal_configurations
  ALTER COLUMN status SET DEFAULT 'APPROVED',
  DROP COLUMN accountant_name,
  DROP COLUMN accountant_email;
