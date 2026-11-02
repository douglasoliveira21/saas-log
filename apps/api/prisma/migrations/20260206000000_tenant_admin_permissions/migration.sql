-- A autorização administrativa passa a seguir as permissões específicas de cada módulo.
-- Propriedade, assinatura e suporte continuam protegidos por tenant.manage.
DELETE FROM role_permissions WHERE permission = 'tenant.super_admin';
