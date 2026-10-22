import { BadRequestException } from '@nestjs/common';

export const PAYMENT_METHODS = ['CASH', 'PIX', 'DEBIT', 'CREDIT', 'BOLETO', 'CHECK', 'OTHER'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const MAX_INSTALLMENTS = 36;

export interface PaymentInput { paymentMethod?: PaymentMethod; installments?: number; firstDueDate?: string; intervalDays?: number }
export interface PaymentData { paymentMethod: PaymentMethod | null; installmentCount: number; firstDueDate: Date | null; installmentIntervalDays: number }

const DAY = 86_400_000;
const isoDate = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Regra da forma de pagamento da venda. Boleto exige número de parcelas (1 a 36) e o vencimento da 1ª parcela (hoje ou depois).
 * As demais formas são à vista: parcelas = 1 e sem vencimento. `today` é a data local (AAAA-MM-DD).
 */
export function normalizePayment(p: PaymentInput, today: string): PaymentData {
  const method = p.paymentMethod ?? null;
  if (method !== 'BOLETO') return { paymentMethod: method, installmentCount: 1, firstDueDate: null, installmentIntervalDays: 30 };
  const n = p.installments ?? 1;
  if (!Number.isInteger(n) || n < 1 || n > MAX_INSTALLMENTS) throw new BadRequestException(`Boleto: informe de 1 a ${MAX_INSTALLMENTS} parcelas.`);
  if (!p.firstDueDate || !isoDate.test(p.firstDueDate) || Number.isNaN(Date.parse(p.firstDueDate))) throw new BadRequestException('Boleto: informe a data de vencimento da primeira parcela.');
  if (p.firstDueDate < today) throw new BadRequestException('Boleto: o vencimento não pode ser anterior a hoje.');
  const interval = p.intervalDays ?? 30;
  if (!Number.isInteger(interval) || interval < 1 || interval > 365) throw new BadRequestException('Boleto: o intervalo entre parcelas deve ser de 1 a 365 dias.');
  return { paymentMethod: method, installmentCount: n, firstDueDate: new Date(`${p.firstDueDate}T00:00:00Z`), installmentIntervalDays: interval };
}

/** Parcelas do boleto: valor dividido em centavos (a última absorve o arredondamento) e vencimentos a cada `intervalDays` dias. */
export function boletoPlan(totalCents: number, count: number, firstDue: Date, intervalDays: number): { due: Date; cents: number }[] {
  const base = Math.floor(totalCents / count);
  return Array.from({ length: count }, (_, i) => ({ due: new Date(firstDue.getTime() + i * intervalDays * DAY), cents: i === count - 1 ? totalCents - base * (count - 1) : base }));
}
