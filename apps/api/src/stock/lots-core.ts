import { BadRequestException, ConflictException } from '@nestjs/common';
import { MovementType, Prisma, StockMovement } from '@prisma/client';
import { AuthContext } from '../common/auth';
import { localToday } from '../sales/cutoff';

type Tx = Prisma.TransactionClient;

/** Dados de lote e endereço que acompanham um movimento de estoque. */
export interface LotInput {
  /** Entrada: código do lote (obrigatório para produto com controle de lote) e validade AAAA-MM-DD. */
  lotCode?: string;
  expiresAt?: string;
  /** Saída: lote específico (padrão: o que vence primeiro). */
  lotId?: string;
  /** Devolução: referência da saída original (ex.: reserva:UUID) para o saldo voltar aos mesmos lotes. */
  restoreFrom?: string;
  /** Entrada: endereço do depósito onde a mercadoria foi guardada. */
  locationCode?: string;
}
export interface MovementLike extends LotInput {
  /** Saída: ignora lotes com menos dias de validade que isso (exigência do cliente/canal). */
  minShelfLifeDays?: number; productId: string; warehouseId: string; type: MovementType; quantity: number; reversalOfId?: string; transferId?: string }

/** Tipos que podem baixar lote vencido (perda, avaria, ajuste); venda e uso interno não podem. */
const MAY_USE_EXPIRED: MovementType[] = ['LOSS', 'DAMAGE', 'ADJUSTMENT', 'REVERSAL'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export const normalizeLotCode = (v: string) => {
  const c = v.trim().toUpperCase();
  if (!c || c.length > 60) throw new BadRequestException('Código do lote inválido (1 a 60 caracteres).');
  return c;
};
const parseExpiry = (v?: string) => {
  if (!v) return null;
  if (!ISO.test(v) || Number.isNaN(Date.parse(v))) throw new BadRequestException('Validade inválida: use AAAA-MM-DD.');
  return new Date(`${v}T00:00:00Z`);
};

/** Cria o lote ou soma ao existente (a validade de um lote não pode mudar). */
async function addToLot(tx: Tx, ctx: AuthContext, productId: string, warehouseId: string, code: string, expires: Date | null, qty: number): Promise<string> {
  const lot = await tx.stockLot.findUnique({ where: { tenantId_productId_warehouseId_code: { tenantId: ctx.tenantId!, productId, warehouseId, code } } });
  if (lot) {
    if (expires && lot.expiresAt && lot.expiresAt.getTime() !== expires.getTime()) throw new ConflictException(`O lote ${code} já existe com validade ${day(lot.expiresAt)}: use outro código para outra validade.`);
    await tx.stockLot.update({ where: { id: lot.id }, data: { onHand: { increment: qty }, ...(expires && !lot.expiresAt ? { expiresAt: expires } : {}) } });
    return lot.id;
  }
  return (await tx.stockLot.create({ data: { tenantId: ctx.tenantId!, productId, warehouseId, code, expiresAt: expires, onHand: qty } })).id;
}

async function takeFromLot(tx: Tx, ctx: AuthContext, lotId: string, qty: number, label: string) {
  const r = await tx.stockLot.updateMany({ where: { id: lotId, tenantId: ctx.tenantId!, onHand: { gte: qty } }, data: { onHand: { decrement: qty } } });
  if (r.count === 0) throw new ConflictException(`O lote ${label} não tem ${qty} unidade(s) disponível(is).`);
}

/** Sai dos lotes que vencem primeiro (PEPS/FEFO); lote vencido só sai em perda, avaria ou ajuste. */
async function fefo(tx: Tx, ctx: AuthContext, m: MovementLike, need: number): Promise<{ lotId: string; qty: number }[]> {
  const excludeExpired = !MAY_USE_EXPIRED.includes(m.type);
  const today = localToday();
  const lots = await tx.$queryRaw<{ id: string; code: string; on_hand: number; expires_at: Date | null }[]>`
    SELECT id, code, on_hand, expires_at FROM stock_lots
    WHERE tenant_id = ${ctx.tenantId}::uuid AND product_id = ${m.productId}::uuid AND warehouse_id = ${m.warehouseId}::uuid AND on_hand > 0
    ORDER BY expires_at ASC NULLS LAST, received_at ASC, code ASC FOR UPDATE`;
  const out: { lotId: string; qty: number }[] = [];
  let left = need; let expiredQty = 0;
  const minDays = excludeExpired ? Math.max(0, m.minShelfLifeDays ?? 0) : 0;
  let shortQty = 0;
  for (const l of lots) {
    if (excludeExpired && l.expires_at && day(l.expires_at)! < today) { expiredQty += l.on_hand; continue; }
    if (minDays > 0 && l.expires_at && (Date.parse(`${day(l.expires_at)}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000 < minDays) { shortQty += l.on_hand; continue; }
    if (left === 0) break;
    const take = Math.min(left, l.on_hand);
    await takeFromLot(tx, ctx, l.id, take, l.code);
    out.push({ lotId: l.id, qty: take }); left -= take;
  }
  if (left > 0 && shortQty > 0) {
    throw new ConflictException(`Faltam ${left} unidade(s) em lotes com pelo menos ${minDays} dia(s) de validade (há ${shortQty} em lote com validade mais curta, que este cliente/canal não aceita).`);
  }
  if (left > 0) {
    throw new ConflictException(expiredQty > 0
      ? `Faltam ${left} unidade(s) em lotes dentro da validade (há ${expiredQty} em lote vencido, que não pode ser vendido ou usado). Dê baixa do vencido como perda.`
      : `Os lotes do produto não cobrem a saída: faltam ${left} unidade(s). Confira os lotes em Estoque → Lotes.`);
  }
  return out;
}

/** Quanto cada lote entra (+) ou sai (−) neste movimento. */
async function lotAllocations(tx: Tx, ctx: AuthContext, mv: StockMovement, m: MovementLike): Promise<{ lotId: string; qty: number }[]> {
  const qty = mv.quantity;
  if (qty > 0) {
    if (m.reversalOfId) {
      const orig = await tx.stockLotMovement.findMany({ where: { tenantId: ctx.tenantId!, movementId: m.reversalOfId } });
      if (!orig.length) throw new ConflictException('O movimento original não tem lotes registrados: estorne por ajuste informando o lote.');
      const out: { lotId: string; qty: number }[] = [];
      for (const o of orig.filter((x) => x.quantity < 0)) { await tx.stockLot.update({ where: { id: o.lotId }, data: { onHand: { increment: -o.quantity } } }); out.push({ lotId: o.lotId, qty: -o.quantity }); }
      return out;
    }
    if (m.type === 'TRANSFER_IN' && m.transferId) {
      const outMv = await tx.stockMovement.findFirst({ where: { tenantId: ctx.tenantId!, transferId: m.transferId, type: 'TRANSFER_OUT', productId: m.productId } });
      const src = outMv ? await tx.stockLotMovement.findMany({ where: { tenantId: ctx.tenantId!, movementId: outMv.id }, include: { lot: true } }) : [];
      if (!src.length) throw new ConflictException('A saída da transferência não tem lotes registrados.');
      const res: { lotId: string; qty: number }[] = [];
      for (const s of src) res.push({ lotId: await addToLot(tx, ctx, m.productId, m.warehouseId, s.lot.code, s.lot.expiresAt, -s.quantity), qty: -s.quantity });
      return res;
    }
    if (m.restoreFrom) {
      const exits = await tx.stockMovement.findMany({ where: { tenantId: ctx.tenantId!, productId: m.productId, reference: m.restoreFrom, type: 'SALE_EXIT' }, select: { id: true } });
      const taken = exits.length ? await tx.stockLotMovement.findMany({ where: { tenantId: ctx.tenantId!, movementId: { in: exits.map((e) => e.id) } }, orderBy: { createdAt: 'asc' } }) : [];
      const res: { lotId: string; qty: number }[] = []; let left = qty;
      for (const t of taken) { if (left === 0) break; const back = Math.min(left, -t.quantity); if (back > 0) { await tx.stockLot.update({ where: { id: t.lotId }, data: { onHand: { increment: back } } }); res.push({ lotId: t.lotId, qty: back }); left -= back; } }
      if (left > 0) res.push({ lotId: await addToLot(tx, ctx, m.productId, m.warehouseId, 'DEVOLUCAO', null, left), qty: left });
      return res;
    }
    if (m.lotCode && m.expiresAt && ISO.test(m.expiresAt) && m.expiresAt < localToday()) throw new BadRequestException('Este lote já está vencido (validade anterior a hoje): não pode entrar no estoque.');
    if (m.lotCode) return [{ lotId: await addToLot(tx, ctx, m.productId, m.warehouseId, normalizeLotCode(m.lotCode), parseExpiry(m.expiresAt), qty), qty }];
    if (m.type === 'RETURN_ENTRY') return [{ lotId: await addToLot(tx, ctx, m.productId, m.warehouseId, 'DEVOLUCAO', null, qty), qty }];
    throw new BadRequestException('Este produto tem controle de lote: informe o lote (código e, se houver, a validade).');
  }
  const need = -qty;
  if (m.reversalOfId) {
    const orig = await tx.stockLotMovement.findMany({ where: { tenantId: ctx.tenantId!, movementId: m.reversalOfId }, include: { lot: true } });
    if (!orig.length) throw new ConflictException('O movimento original não tem lotes registrados: dê baixa por ajuste informando o lote.');
    const res: { lotId: string; qty: number }[] = [];
    for (const o of orig.filter((x) => x.quantity > 0)) { await takeFromLot(tx, ctx, o.lotId, o.quantity, o.lot.code); res.push({ lotId: o.lotId, qty: o.quantity }); }
    return res;
  }
  if (m.lotId) {
    const lot = await tx.stockLot.findFirst({ where: { id: m.lotId, tenantId: ctx.tenantId!, productId: m.productId, warehouseId: m.warehouseId } });
    if (!lot) throw new BadRequestException('Lote não encontrado neste depósito.');
    if (!MAY_USE_EXPIRED.includes(m.type) && lot.expiresAt && day(lot.expiresAt)! < localToday()) throw new ConflictException(`O lote ${lot.code} está vencido e não pode ser usado nesta operação.`);
    await takeFromLot(tx, ctx, lot.id, need, lot.code);
    return [{ lotId: lot.id, qty: need }];
  }
  return fefo(tx, ctx, m, need);
}

/** Tira das posições (endereços) o que saiu do depósito: lote a lote, pelo código do endereço. O que não estava endereçado simplesmente sai do "sem endereço". */
async function consumeLocations(tx: Tx, ctx: AuthContext, productId: string, warehouseId: string, parts: { lotId: string | null; qty: number }[]) {
  for (const p of parts) {
    let left = p.qty;
    const items = await tx.stockLocationItem.findMany({ where: { tenantId: ctx.tenantId!, productId, lotId: p.lotId, location: { warehouseId } }, include: { location: { select: { code: true } } } });
    for (const it of items.sort((a, b) => a.location.code.localeCompare(b.location.code))) {
      if (left === 0) break;
      const take = Math.min(left, it.quantity);
      if (take === it.quantity) await tx.stockLocationItem.delete({ where: { id: it.id } }); else await tx.stockLocationItem.update({ where: { id: it.id }, data: { quantity: { decrement: take } } });
      left -= take;
    }
  }
}

export async function addToLocation(tx: Tx, ctx: AuthContext, warehouseId: string, code: string, productId: string, lotId: string | null, qty: number) {
  const loc = await tx.warehouseLocation.findFirst({ where: { tenantId: ctx.tenantId!, warehouseId, code: code.trim().toUpperCase(), active: true } });
  if (!loc) throw new BadRequestException(`Endereço "${code}" não existe neste depósito (ou está inativo).`);
  const lotKey = lotId ?? 'NONE';
  await tx.stockLocationItem.upsert({
    where: { tenantId_locationId_productId_lotKey: { tenantId: ctx.tenantId!, locationId: loc.id, productId, lotKey } },
    create: { tenantId: ctx.tenantId!, locationId: loc.id, productId, lotId, lotKey, quantity: qty }, update: { quantity: { increment: qty } },
  });
}

/** Gancho chamado por toda movimentação de estoque (entrada, saída, ajuste, transferência, consumo de reserva). */
export async function applyLotsAndLocations(tx: Tx, ctx: AuthContext, mv: StockMovement, m: MovementLike): Promise<void> {
  const product = await tx.product.findFirst({ where: { id: mv.productId, tenantId: ctx.tenantId! }, select: { trackLots: true } });
  const tracked = !!product?.trackLots;
  const parts: { lotId: string | null; qty: number }[] = tracked
    ? (await lotAllocations(tx, ctx, mv, m)).map((a) => ({ lotId: a.lotId, qty: a.qty }))
    : [{ lotId: null, qty: Math.abs(mv.quantity) }];
  if (tracked) await tx.stockLotMovement.createMany({ data: parts.map((p) => ({ tenantId: ctx.tenantId!, movementId: mv.id, lotId: p.lotId!, quantity: mv.quantity < 0 ? -p.qty : p.qty })) });
  if (mv.quantity < 0) await consumeLocations(tx, ctx, mv.productId, mv.warehouseId, parts);
  else if (m.locationCode) for (const p of parts) await addToLocation(tx, ctx, mv.warehouseId, m.locationCode, mv.productId, p.lotId, p.qty);
}

/** Unidades em lotes que ainda atendem à validade mínima (para conferir na confirmação do pedido). Produto sem controle de lote: nulo. */
export async function validShelfLifeQty(tx: Tx, tenantId: string, productId: string, warehouseId: string, minDays: number): Promise<number | null> {
  const p = await tx.product.findFirst({ where: { id: productId, tenantId }, select: { trackLots: true } });
  if (!p?.trackLots) return null;
  const limit = new Date(Date.parse(`${localToday()}T00:00:00Z`) + Math.max(0, minDays) * 86_400_000);
  const agg = await tx.stockLot.aggregate({ where: { tenantId, productId, warehouseId, onHand: { gt: 0 }, OR: [{ expiresAt: null }, { expiresAt: { gte: limit } }] }, _sum: { onHand: true } });
  return agg._sum.onHand ?? 0;
}
