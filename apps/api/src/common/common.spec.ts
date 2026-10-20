import { isValidCnpj } from './cnpj';
import { hashPassword, validatePasswordPolicy, verifyPassword } from './password';
import { ALL_PERMISSIONS, PERMISSIONS, SYSTEM_ROLES } from '../access/permissions';
import { scrub } from '../audit/audit.service';

describe('senha', () => {
  it('gera hash verificável e rejeita senha errada', async () => {
    const h = await hashPassword('Segredo#12345');
    expect(h).not.toContain('Segredo');
    expect(await verifyPassword('Segredo#12345', h)).toBe(true);
    expect(await verifyPassword('outra-senha1', h)).toBe(false);
  });
  it('aplica política mínima', () => {
    expect(validatePasswordPolicy('curta1')).not.toBeNull();
    expect(validatePasswordPolicy('somenteletras')).not.toBeNull();
    expect(validatePasswordPolicy('Valida12345')).toBeNull();
  });
});

describe('CNPJ', () => {
  it('valida dígitos verificadores', () => {
    expect(isValidCnpj('11.222.333/0001-81')).toBe(true);
    expect(isValidCnpj('11.222.333/0001-82')).toBe(false);
    expect(isValidCnpj('00000000000000')).toBe(false);
    expect(isValidCnpj('123')).toBe(false);
  });
});

describe('papéis de sistema', () => {
  it('só referenciam permissões do catálogo', () => {
    for (const role of SYSTEM_ROLES) {
      for (const p of role.permissions) expect(p in PERMISSIONS).toBe(true);
    }
  });
  it('proprietário possui todas as permissões e admin não administra o tenant', () => {
    const owner = SYSTEM_ROLES.find((r) => r.key === 'owner')!;
    expect(owner.permissions).toHaveLength(ALL_PERMISSIONS.length);
    expect(SYSTEM_ROLES.find((r) => r.key === 'admin')!.permissions).not.toContain('tenant.manage');
  });
  it('cobre os 12 papéis iniciais da especificação', () => {
    expect(SYSTEM_ROLES).toHaveLength(12);
  });
});

describe('auditoria', () => {
  it('remove segredos dos metadados', () => {
    const out = scrub({ email: 'a@b.c', password: 'x', nested: { accessToken: 'y', ok: 1 }, list: [{ senha: 'z' }] }) as any;
    expect(out.password).toBe('[REDACTED]');
    expect(out.nested.accessToken).toBe('[REDACTED]');
    expect(out.nested.ok).toBe(1);
    expect(out.list[0].senha).toBe('[REDACTED]');
    expect(out.email).toBe('a@b.c');
  });
});
