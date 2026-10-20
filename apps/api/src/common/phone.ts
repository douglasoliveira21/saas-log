import { registerDecorator, type ValidationOptions } from 'class-validator';
import { normalizePhone } from '../lookup/lookup';

/** Telefone brasileiro com DDD (10 ou 11 dígitos, aceita +55 e máscara). Vazio é permitido (use @IsOptional). */
export function IsBrPhone(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isBrPhone',
      target: object.constructor,
      propertyName,
      options: { message: 'Telefone inválido: informe DDD + número (ex.: (11) 99999-9999).', ...options },
      validator: { validate: (v: unknown) => v === undefined || v === null || v === '' || (typeof v === 'string' && normalizePhone(v) !== null) },
    });
}

/** Padroniza antes de gravar: telefone e CEP só com dígitos (a formatação é feita na exibição). */
export function normalizeContact<T extends { phone?: string; contactPhone?: string; zipCode?: string }>(dto: T): T {
  const out = { ...dto };
  if (typeof out.phone === 'string') out.phone = normalizePhone(out.phone) ?? undefined;
  if (typeof out.contactPhone === 'string') out.contactPhone = normalizePhone(out.contactPhone) ?? undefined;
  if (typeof out.zipCode === 'string') out.zipCode = out.zipCode.replace(/\D/g, '') || undefined;
  return out;
}
