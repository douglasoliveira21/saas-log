-- Formaliza o acesso ao portal administrativo. Somente o papel proprietário recebe
-- a permissão automaticamente; papéis personalizados precisam de concessão explícita.
INSERT INTO role_permissions (role_id, tenant_id, permission)
SELECT r.id, r.tenant_id, 'tenant.super_admin'
FROM roles r
WHERE r.key = 'owner'
ON CONFLICT (role_id, permission) DO NOTHING;
