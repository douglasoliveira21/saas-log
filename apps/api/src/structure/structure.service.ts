import { ConflictException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthContext } from '../common/auth';
import { onlyDigits } from '../common/cnpj';
import { normalizeContact } from '../common/phone';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateCompanyDto,
  CreateEstablishmentDto,
  CreateWarehouseDto,
  UpdateCompanyDto,
  UpdateEstablishmentDto,
  UpdateWarehouseDto,
} from './structure.dto';

type Limits = { users?: number; establishments?: number; warehouses?: number };

function mapUnique(e: unknown, message: string): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException(message);
  throw e;
}

const cnpjOrUndef = (v?: string | null) => (v === null ? null : v ? onlyDigits(v) : undefined);
const upperUf = <T extends { state?: string | null }>(d: T) => ({ ...d, state: d.state === null ? null : d.state?.toUpperCase() });

@Injectable()
export class StructureService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Retorna a hierarquia empresa → estabelecimento → depósito do tenant. */
  tree(ctx: AuthContext) {
    return this.prisma.withContext(ctx, (tx) =>
      tx.company.findMany({
        where: { tenantId: ctx.tenantId! },
        orderBy: { createdAt: 'asc' },
        include: {
          establishments: { orderBy: { createdAt: 'asc' }, include: { warehouses: { orderBy: { code: 'asc' } } } },
        },
      }),
    );
  }

  async createCompany(ctx: AuthContext, dto: CreateCompanyDto) {
    return this.prisma.withContext(ctx, async (tx) => {
      const row = await tx.company
        .create({ data: { ...normalizeContact(dto), cnpj: cnpjOrUndef(dto.cnpj), tenantId: ctx.tenantId! } })
        .catch((e) => mapUnique(e, 'Já existe uma empresa com este CNPJ.'));
      await this.audit.record(tx, ctx, { action: 'company.created', entity: 'company', entityId: row.id, metadata: { legalName: row.legalName } });
      return row;
    });
  }

  async updateCompany(ctx: AuthContext, id: string, dto: UpdateCompanyDto) {
    return this.prisma.withContext(ctx, async (tx) => {
      await this.mustExist(tx.company.findFirst({ where: { id, tenantId: ctx.tenantId! }, select: { id: true } }));
      const row = await tx.company
        .update({ where: { id }, data: { ...normalizeContact(dto), cnpj: cnpjOrUndef(dto.cnpj) } })
        .catch((e) => mapUnique(e, 'Já existe uma empresa com este CNPJ.'));
      await this.audit.record(tx, ctx, { action: 'company.updated', entity: 'company', entityId: id, metadata: { fields: Object.keys(dto) } });
      return row;
    });
  }

  async createEstablishment(ctx: AuthContext, dto: CreateEstablishmentDto) {
    return this.prisma.withContext(ctx, async (tx) => {
      await this.mustExist(tx.company.findFirst({ where: { id: dto.companyId, tenantId: ctx.tenantId! }, select: { id: true } }));
      await this.enforceLimit(tx, ctx, 'establishments', () => tx.establishment.count({ where: { tenantId: ctx.tenantId!, active: true } }));
      const row = await tx.establishment
        .create({ data: { ...normalizeContact(upperUf(dto)), cnpj: cnpjOrUndef(dto.cnpj), tenantId: ctx.tenantId! } })
        .catch((e) => mapUnique(e, 'Já existe um estabelecimento com este CNPJ.'));
      await this.audit.record(tx, ctx, { action: 'establishment.created', entity: 'establishment', entityId: row.id, metadata: { name: row.name, kind: row.kind } });
      return row;
    });
  }

  async updateEstablishment(ctx: AuthContext, id: string, dto: UpdateEstablishmentDto) {
    return this.prisma.withContext(ctx, async (tx) => {
      const current = await tx.establishment.findFirst({ where: { id, tenantId: ctx.tenantId! }, select: { cnpj: true, state: true, stateRegistration: true } });
      if (!current) throw new NotFoundException('Registro não encontrado.');
      // Com documentos fiscais já registrados, CNPJ, UF e IE compõem a chave de acesso e a numeração: não mudam por aqui.
      const touchesFiscalId = (dto.cnpj !== undefined && (cnpjOrUndef(dto.cnpj) ?? null) !== current.cnpj)
        || (dto.state !== undefined && (dto.state?.toUpperCase() ?? null) !== current.state)
        || (dto.stateRegistration !== undefined && (dto.stateRegistration ?? null) !== current.stateRegistration);
      if (touchesFiscalId) {
        const docs = await tx.fiscalDocument.count({ where: { tenantId: ctx.tenantId!, establishmentId: id } });
        const series = await tx.fiscalSeries.count({ where: { tenantId: ctx.tenantId!, establishmentId: id } });
        if (docs + series > 0) throw new ConflictException('Este estabelecimento já possui documentos fiscais: CNPJ, UF e inscrição estadual não podem ser alterados. Cadastre um novo estabelecimento.');
      }
      const row = await tx.establishment
        .update({ where: { id }, data: { ...normalizeContact(upperUf(dto)), cnpj: cnpjOrUndef(dto.cnpj) } })
        .catch((e) => mapUnique(e, 'Já existe um estabelecimento com este CNPJ.'));
      await this.audit.record(tx, ctx, { action: 'establishment.updated', entity: 'establishment', entityId: id, metadata: { fields: Object.keys(dto) } });
      return row;
    });
  }

  async createWarehouse(ctx: AuthContext, dto: CreateWarehouseDto) {
    return this.prisma.withContext(ctx, async (tx) => {
      await this.mustExist(tx.establishment.findFirst({ where: { id: dto.establishmentId, tenantId: ctx.tenantId! }, select: { id: true } }));
      await this.enforceLimit(tx, ctx, 'warehouses', () => tx.warehouse.count({ where: { tenantId: ctx.tenantId!, active: true } }));
      const row = await tx.warehouse
        .create({ data: { ...upperUf(dto), code: dto.code.toUpperCase(), tenantId: ctx.tenantId! } })
        .catch((e) => mapUnique(e, 'Já existe um depósito com este código.'));
      await this.audit.record(tx, ctx, { action: 'warehouse.created', entity: 'warehouse', entityId: row.id, metadata: { code: row.code } });
      return row;
    });
  }

  async updateWarehouse(ctx: AuthContext, id: string, dto: UpdateWarehouseDto) {
    return this.prisma.withContext(ctx, async (tx) => {
      await this.mustExist(tx.warehouse.findFirst({ where: { id, tenantId: ctx.tenantId! }, select: { id: true } }));
      const row = await tx.warehouse.update({ where: { id }, data: upperUf(dto) });
      await this.audit.record(tx, ctx, { action: 'warehouse.updated', entity: 'warehouse', entityId: id, metadata: { fields: Object.keys(dto) } });
      return row;
    });
  }

  // ───────────── exclusão (somente cadastros sem uso; o resto se inativa) ─────────────

  private blocked(e: unknown): never {
    const text = String((e as Error)?.message ?? '');
    if ((e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003') || /foreign key|RESTRICT setting/i.test(text)) {
      throw new ConflictException('Este registro já está em uso (estoque, pedidos, notas ou integrações). Desative-o em vez de excluir.');
    }
    throw e;
  }

  async deleteCompany(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const c = await tx.company.findFirst({ where: { id, tenantId: ctx.tenantId! } });
      if (!c) throw new NotFoundException('Registro não encontrado.');
      const n = await tx.establishment.count({ where: { tenantId: ctx.tenantId!, companyId: id } });
      if (n > 0) throw new ConflictException(`A empresa possui ${n} estabelecimento(s). Exclua-os antes (ou desative a empresa).`);
      await tx.company.delete({ where: { id } }).catch((e) => this.blocked(e));
      await this.audit.record(tx, ctx, { action: 'company.deleted', entity: 'company', entityId: id, metadata: { legalName: c.legalName, cnpj: c.cnpj } });
      return { id, deleted: true };
    });
  }

  async deleteEstablishment(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const t = ctx.tenantId!;
      const e = await tx.establishment.findFirst({ where: { id, tenantId: t } });
      if (!e) throw new NotFoundException('Registro não encontrado.');
      const wh = await tx.warehouse.count({ where: { tenantId: t, establishmentId: id } });
      if (wh > 0) throw new ConflictException(`O estabelecimento possui ${wh} depósito(s). Exclua-os antes (ou desative o estabelecimento).`);
      const [docs, series, certs] = await Promise.all([
        tx.fiscalDocument.count({ where: { tenantId: t, establishmentId: id } }),
        tx.fiscalSeries.count({ where: { tenantId: t, establishmentId: id } }),
        tx.fiscalCertificate.count({ where: { tenantId: t, establishmentId: id } }),
      ]);
      if (docs + series + certs > 0) throw new ConflictException('O estabelecimento possui documentos, numeração ou certificado fiscal. Desative-o em vez de excluir.');
      const cfg = await tx.fiscalConfiguration.findFirst({ where: { tenantId: t, establishmentId: id } });
      if (cfg && cfg.status !== 'DRAFT') throw new ConflictException('A configuração fiscal deste estabelecimento já foi enviada ou validada pelo contador. Desative-o em vez de excluir.');
      if (cfg) await tx.fiscalConfiguration.delete({ where: { id: cfg.id } });
      await tx.establishment.delete({ where: { id } }).catch((err) => this.blocked(err));
      await this.audit.record(tx, ctx, { action: 'establishment.deleted', entity: 'establishment', entityId: id, metadata: { name: e.name, cnpj: e.cnpj } });
      return { id, deleted: true };
    });
  }

  async deleteWarehouse(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const w = await tx.warehouse.findFirst({ where: { id, tenantId: ctx.tenantId! } });
      if (!w) throw new NotFoundException('Registro não encontrado.');
      await tx.warehouse.delete({ where: { id } }).catch((e) => this.blocked(e));
      await this.audit.record(tx, ctx, { action: 'warehouse.deleted', entity: 'warehouse', entityId: id, metadata: { code: w.code, name: w.name } });
      return { id, deleted: true };
    });
  }

  /** Indicadores reais da visão geral + checklist de implantação (somente o que já existe nesta fase). */
  async overview(ctx: AuthContext) {
    return this.prisma.withContext(ctx, async (tx) => {
      const tenantId = ctx.tenantId!;
      const [companies, establishments, warehouses, users, companiesWithCnpj, establishmentsWithIe] = await Promise.all([
        tx.company.count({ where: { tenantId, active: true } }),
        tx.establishment.count({ where: { tenantId, active: true } }),
        tx.warehouse.count({ where: { tenantId, active: true } }),
        tx.membership.count({ where: { tenantId, status: 'ACTIVE' } }),
        tx.company.count({ where: { tenantId, cnpj: { not: null } } }),
        tx.establishment.count({ where: { tenantId, stateRegistration: { not: null } } }),
      ]);
      return {
        counts: { companies, establishments, warehouses, users },
        checklist: [
          { key: 'company', label: 'Empresa cadastrada com CNPJ', done: companiesWithCnpj > 0 },
          { key: 'establishment', label: 'Estabelecimento com inscrição estadual', done: establishmentsWithIe > 0 },
          { key: 'warehouse', label: 'Depósito cadastrado', done: warehouses > 0 },
          { key: 'users', label: 'Equipe convidada (além do proprietário)', done: users > 1 },
        ],
        pendingModules: ['Compras e vendas (Fase 3)', 'Fiscal (Fase 6)', 'Marketplaces (Fases 4-5)', 'Financeiro (Fase 7)'],
      };
    });
  }

  private async mustExist(p: Promise<unknown>): Promise<void> {
    if (!(await p)) throw new NotFoundException('Registro não encontrado.');
  }

  private async enforceLimit(
    tx: Prisma.TransactionClient,
    ctx: AuthContext,
    key: keyof Limits,
    count: () => Promise<number>,
  ): Promise<void> {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId! }, include: { plan: true } });
    const limit = (tenant.plan?.limits as Limits | undefined)?.[key];
    if (limit !== undefined && (await count()) >= limit) {
      throw new HttpException(`Limite do plano atingido (${limit}). Faça upgrade para continuar.`, HttpStatus.PAYMENT_REQUIRED);
    }
  }
}
