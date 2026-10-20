import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthContext } from '../common/auth';
import { PrismaService } from '../prisma/prisma.service';
import { calculate, ENGINE_VERSION, EngineInput, EngineOutput, Operation, RuleCandidate, RuleConfig } from './engine';

type Tx = Prisma.TransactionClient;

const OPERATIONS: Operation[] = ['PURCHASE', 'SALE', 'RETURN_SALE', 'RETURN_PURCHASE', 'TRANSFER', 'OTHER'];

/** Valida a estrutura da configuração (formato). Os VALORES (alíquotas, CST, CFOP) são responsabilidade do contador. */
export function validateRuleConfig(cfg: unknown): RuleConfig {
  if (!cfg || typeof cfg !== 'object') throw new BadRequestException('Configuração da regra inválida.');
  const c = cfg as Partial<RuleConfig>;
  if (c.cfop !== undefined && !/^\d{4}$/.test(c.cfop)) throw new BadRequestException('CFOP deve ter 4 dígitos.');
  if (!c.taxes || typeof c.taxes !== 'object' || !Object.keys(c.taxes).length) throw new BadRequestException('Informe ao menos um tributo na regra.');
  for (const [code, p] of Object.entries(c.taxes)) {
    if (!/^[A-Z][A-Z0-9_]{1,15}$/.test(code)) throw new BadRequestException(`Código de tributo inválido: ${code}.`);
    if (p.ratePct !== undefined && !(typeof p.ratePct === 'number' && p.ratePct >= 0 && p.ratePct <= 100)) throw new BadRequestException(`${code}: alíquota deve estar entre 0 e 100.`);
    if (p.baseReductionPct !== undefined && !(typeof p.baseReductionPct === 'number' && p.baseReductionPct >= 0 && p.baseReductionPct <= 100)) throw new BadRequestException(`${code}: redução de base deve estar entre 0 e 100.`);
    if (p.cst !== undefined && !/^\d{2,3}$/.test(p.cst)) throw new BadRequestException(`${code}: CST deve ter 2 ou 3 dígitos.`);
    if (p.csosn !== undefined && !/^\d{3}$/.test(p.csosn)) throw new BadRequestException(`${code}: CSOSN deve ter 3 dígitos.`);
    if ((p.kind ?? 'PERCENT') === 'PERCENT' && p.ratePct === undefined) throw new BadRequestException(`${code}: informe a alíquota (ou marque o tipo como ST/DIFAL/FCP para registrar a pendência).`);
  }
  return { cfop: c.cfop, includeFreightInBase: !!c.includeFreightInBase, taxes: c.taxes };
}

export interface RuleScope {
  name: string;
  operation: Operation;
  originUf?: string;
  destUf?: string;
  ncmPrefix?: string;
  regime?: string;
  productOrigin?: number;
  recipientKind?: string;
  priority?: number;
}

@Injectable()
export class TaxRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(ctx: AuthContext) {
    return this.prisma.withContext(ctx, (tx) =>
      tx.taxRule.findMany({ where: { tenantId: ctx.tenantId! }, orderBy: { createdAt: 'asc' }, include: { versions: { orderBy: { version: 'desc' } } } }),
    );
  }

  create(ctx: AuthContext, scope: RuleScope, version: { validFrom: string; validTo?: string; config: unknown; sourceReference: string }) {
    if (!OPERATIONS.includes(scope.operation)) throw new BadRequestException('Operação inválida.');
    const config = validateRuleConfig(version.config);
    return this.prisma.withContext(ctx, async (tx) => {
      const rule = await tx.taxRule.create({
        data: {
          tenantId: ctx.tenantId!, name: scope.name.trim(), operation: scope.operation, originUf: scope.originUf?.toUpperCase(), destUf: scope.destUf?.toUpperCase(),
          ncmPrefix: scope.ncmPrefix, regime: scope.regime, productOrigin: scope.productOrigin, recipientKind: scope.recipientKind, priority: scope.priority ?? 0, createdById: ctx.userId,
        },
      });
      const v = await tx.taxRuleVersion.create({
        data: { tenantId: ctx.tenantId!, ruleId: rule.id, version: 1, validFrom: new Date(version.validFrom), validTo: version.validTo ? new Date(version.validTo) : null, config: config as unknown as Prisma.InputJsonValue, sourceReference: version.sourceReference.trim(), createdById: ctx.userId },
      });
      await this.audit.record(tx, ctx, { action: 'tax_rule.created', entity: 'tax_rule', entityId: rule.id, metadata: { name: rule.name, versionId: v.id } });
      return { ruleId: rule.id, versionId: v.id };
    });
  }

  /** Nova versão (rascunho) a partir de uma regra existente; a versão aprovada anterior permanece intacta até a nova ser aprovada. */
  addVersion(ctx: AuthContext, ruleId: string, version: { validFrom: string; validTo?: string; config: unknown; sourceReference: string }) {
    const config = validateRuleConfig(version.config);
    return this.prisma.withContext(ctx, async (tx) => {
      if (!(await tx.taxRule.findFirst({ where: { id: ruleId, tenantId: ctx.tenantId! } }))) throw new NotFoundException('Regra não encontrada.');
      const open = await tx.taxRuleVersion.findFirst({ where: { ruleId, tenantId: ctx.tenantId!, status: { in: ['DRAFT', 'PENDING_APPROVAL'] } } });
      if (open) throw new ConflictException(`Já existe a versão ${open.version} em ${open.status === 'DRAFT' ? 'rascunho' : 'aprovação'}.`);
      const last = await tx.taxRuleVersion.findFirst({ where: { ruleId, tenantId: ctx.tenantId! }, orderBy: { version: 'desc' } });
      const v = await tx.taxRuleVersion.create({
        data: { tenantId: ctx.tenantId!, ruleId, version: (last?.version ?? 0) + 1, validFrom: new Date(version.validFrom), validTo: version.validTo ? new Date(version.validTo) : null, config: config as unknown as Prisma.InputJsonValue, sourceReference: version.sourceReference.trim(), createdById: ctx.userId },
      });
      await this.audit.record(tx, ctx, { action: 'tax_rule.version_created', entity: 'tax_rule', entityId: ruleId, metadata: { versionId: v.id, version: v.version } });
      return { versionId: v.id, version: v.version };
    });
  }

  updateDraft(ctx: AuthContext, versionId: string, patch: { validFrom?: string; validTo?: string; config?: unknown; sourceReference?: string }) {
    return this.prisma.withContext(ctx, async (tx) => {
      const v = await this.version(tx, ctx, versionId);
      if (v.status !== 'DRAFT') throw new ConflictException('Somente versões em rascunho podem ser editadas; crie uma nova versão.');
      const config = patch.config !== undefined ? validateRuleConfig(patch.config) : undefined;
      await tx.taxRuleVersion.update({
        where: { id: versionId },
        data: {
          ...(patch.validFrom ? { validFrom: new Date(patch.validFrom) } : {}), ...(patch.validTo ? { validTo: new Date(patch.validTo) } : {}),
          ...(config ? { config: config as unknown as Prisma.InputJsonValue } : {}), ...(patch.sourceReference ? { sourceReference: patch.sourceReference.trim() } : {}),
        },
      });
      await this.audit.record(tx, ctx, { action: 'tax_rule.draft_updated', entity: 'tax_rule_version', entityId: versionId });
      return { versionId };
    });
  }

  submit(ctx: AuthContext, versionId: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const v = await this.version(tx, ctx, versionId);
      if (v.status !== 'DRAFT') throw new ConflictException('Somente rascunhos podem ser enviados para aprovação.');
      await tx.taxRuleVersion.update({ where: { id: versionId }, data: { status: 'PENDING_APPROVAL' } });
      await this.audit.record(tx, ctx, { action: 'tax_rule.submitted', entity: 'tax_rule_version', entityId: versionId });
      return { versionId, status: 'PENDING_APPROVAL' as const };
    });
  }

  /** Aprovação (validação do contador). Substitui a versão aprovada anterior encerrando sua vigência na véspera da nova. */
  approve(ctx: AuthContext, versionId: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const v = await this.version(tx, ctx, versionId);
      if (v.status !== 'PENDING_APPROVAL') throw new ConflictException('A versão não está aguardando aprovação.');
      if (v.createdById === ctx.userId && !ctx.permissions.has('tenant.manage')) throw new ForbiddenException('A aprovação deve ser feita por outra pessoa (segregação de funções).');
      const previous = await tx.taxRuleVersion.findMany({ where: { ruleId: v.ruleId, tenantId: ctx.tenantId!, status: 'APPROVED' } });
      for (const p of previous) {
        const end = new Date(v.validFrom.getTime() - 1);
        await tx.taxRuleVersion.update({ where: { id: p.id }, data: { status: 'SUPERSEDED', validTo: p.validTo && p.validTo < end ? p.validTo : end } });
      }
      await tx.taxRuleVersion.update({ where: { id: versionId }, data: { status: 'APPROVED', approvedById: ctx.userId, approvedAt: new Date() } });
      await this.audit.record(tx, ctx, { action: 'tax_rule.approved', entity: 'tax_rule_version', entityId: versionId, metadata: { ruleId: v.ruleId, version: v.version, supersedes: previous.map((p) => p.version) } });
      return { versionId, status: 'APPROVED' as const };
    });
  }

  reject(ctx: AuthContext, versionId: string, reason: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const v = await this.version(tx, ctx, versionId);
      if (v.status !== 'PENDING_APPROVAL') throw new ConflictException('A versão não está aguardando aprovação.');
      await tx.taxRuleVersion.update({ where: { id: versionId }, data: { status: 'DRAFT' } });
      await this.audit.record(tx, ctx, { action: 'tax_rule.rejected', entity: 'tax_rule_version', entityId: versionId, metadata: { reason } });
      return { versionId, status: 'DRAFT' as const };
    });
  }

  setActive(ctx: AuthContext, ruleId: string, active: boolean) {
    return this.prisma.withContext(ctx, async (tx) => {
      if (!(await tx.taxRule.findFirst({ where: { id: ruleId, tenantId: ctx.tenantId! } }))) throw new NotFoundException('Regra não encontrada.');
      await tx.taxRule.update({ where: { id: ruleId }, data: { active } });
      await this.audit.record(tx, ctx, { action: active ? 'tax_rule.enabled' : 'tax_rule.disabled', entity: 'tax_rule', entityId: ruleId });
      return { ruleId, active };
    });
  }

  // ───────────── cálculo ─────────────

  /** Candidatas: somente regras ativas com versão APROVADA (a vigência é conferida pelo motor, na data do documento). */
  async candidates(tx: Tx, tenantId: string): Promise<RuleCandidate[]> {
    const rules = await tx.taxRule.findMany({ where: { tenantId, active: true }, include: { versions: { where: { status: { in: ['APPROVED', 'SUPERSEDED'] } } } } });
    const out: RuleCandidate[] = [];
    for (const r of rules) {
      for (const v of r.versions) {
        out.push({
          ruleId: r.id, name: r.name, operation: r.operation as Operation, originUf: r.originUf, destUf: r.destUf, ncmPrefix: r.ncmPrefix, regime: r.regime,
          productOrigin: r.productOrigin, recipientKind: r.recipientKind, priority: r.priority,
          version: { id: v.id, version: v.version, validFrom: v.validFrom, validTo: v.validTo, config: v.config as unknown as RuleConfig, sourceReference: v.sourceReference },
        });
      }
    }
    return out;
  }

  async compute(tx: Tx, tenantId: string, input: EngineInput): Promise<EngineOutput> {
    return calculate(input, await this.candidates(tx, tenantId));
  }

  /** Cálculo com retrato opcional (reprodutível): entradas, saídas, versões de regra e versão do motor. */
  calculateEndpoint(ctx: AuthContext, input: EngineInput, persist: boolean) {
    return this.prisma.withContext(ctx, async (tx) => {
      const out = await this.compute(tx, ctx.tenantId!, input);
      let calculationId: string | null = null;
      if (persist) {
        const row = await tx.taxCalculation.create({
          data: {
            tenantId: ctx.tenantId!, operation: input.operation, engineVersion: ENGINE_VERSION, inputs: JSON.parse(JSON.stringify(input)) as Prisma.InputJsonValue, outputs: JSON.parse(JSON.stringify(out)) as Prisma.InputJsonValue,
            ruleVersionIds: out.rulesUsed.map((r) => r.versionId), pendencies: out.pendencies as unknown as Prisma.InputJsonValue, createdById: ctx.userId,
          },
        });
        calculationId = row.id;
      }
      return { ...out, calculationId };
    });
  }

  private async version(tx: Tx, ctx: Pick<AuthContext, 'tenantId'>, id: string) {
    const v = await tx.taxRuleVersion.findFirst({ where: { id, tenantId: ctx.tenantId! } });
    if (!v) throw new NotFoundException('Versão de regra não encontrada.');
    return v;
  }
}
