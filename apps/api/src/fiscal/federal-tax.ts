import { BadRequestException, Body, Controller, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { TaxRegime } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/auth';
import { PrismaService } from '../prisma/prisma.service';

const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];
const rate = { maxDecimalPlaces: 4, allowNaN: false, allowInfinity: false } as const;

class IcmsRow {
  @Matches(/^[A-Za-z]{2}$/, { message: 'UF inválida.' }) uf: string;
  @Matches(/^\d{2,3}$/, { message: 'CST/CSOSN deve ter 2 ou 3 dígitos.' }) cst: string;
  @IsOptional() @IsNumber(rate) @Min(0) @Max(100) ratePct?: number;
}
class IbsCbsRow {
  @Matches(/^[A-Za-z]{2}$/, { message: 'UF inválida.' }) uf: string;
  @Matches(/^\d{3}$/, { message: 'CST do IBS/CBS deve ter 3 dígitos.' }) cst: string;
  @IsString() @MaxLength(10) classification: string;
}
class TaxDto {
  @IsEnum(TaxRegime) regime: TaxRegime;
  @IsNumber(rate) @Min(0) @Max(100) pisRate: number;
  @IsNumber(rate) @Min(0) @Max(100) cofinsRate: number;
  @IsOptional() @IsString() @MaxLength(60) scArticle?: string | null;
  @IsBoolean() showTotalTaxes: boolean;
  @IsBoolean() presumedCredit: boolean;
  @IsBoolean() exceededSublimit: boolean;
  @IsArray() @ArrayMaxSize(27) @ValidateNested({ each: true }) @Type(() => IcmsRow) icmsByUf: IcmsRow[];
  @IsArray() @ArrayMaxSize(27) @ValidateNested({ each: true }) @Type(() => IbsCbsRow) ibsCbsByUf: IbsCbsRow[];
}

const uniqueUf = (rows: { uf: string }[], what: string) => {
  const ufs = rows.map((r) => r.uf.toUpperCase());
  for (const u of ufs) if (!UFS.includes(u)) throw new BadRequestException(`UF inválida em ${what}: ${u}.`);
  if (new Set(ufs).size !== ufs.length) throw new BadRequestException(`UF repetida em ${what}.`);
};

/**
 * Impostos federais da empresa (menu Impostos). O sistema NÃO sugere alíquotas: o contador informa os valores. Esta tela guarda a
 * configuração; o cálculo das notas continua usando as regras tributárias aprovadas (Fiscal → Regras tributárias).
 */
@Injectable()
export class FederalTaxService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  list(ctx: AuthContext) {
    return this.prisma.withContext(ctx, async (tx) => {
      const companies = await tx.company.findMany({ where: { tenantId: ctx.tenantId!, active: true }, orderBy: { legalName: 'asc' }, select: { id: true, legalName: true, tradeName: true, cnpj: true, taxRegime: true } });
      const cfgs = await tx.federalTaxConfig.findMany({ where: { tenantId: ctx.tenantId! } });
      return companies.map((c) => {
        const x = cfgs.find((k) => k.companyId === c.id);
        return { company: c, config: x ? { regime: x.regime, pisRate: Number(x.pisRate), cofinsRate: Number(x.cofinsRate), scArticle: x.scArticle, showTotalTaxes: x.showTotalTaxes, presumedCredit: x.presumedCredit, exceededSublimit: x.exceededSublimit, icmsByUf: x.icmsByUf, ibsCbsByUf: x.ibsCbsByUf, updatedAt: x.updatedAt } : null };
      });
    });
  }

  save(ctx: AuthContext, companyId: string, dto: TaxDto) {
    uniqueUf(dto.icmsByUf, 'ICMS por Estado');
    uniqueUf(dto.ibsCbsByUf, 'IBS/CBS por Estado');
    return this.prisma.withContext(ctx, async (tx) => {
      const c = await tx.company.findFirst({ where: { id: companyId, tenantId: ctx.tenantId! }, select: { id: true } });
      if (!c) throw new NotFoundException('Empresa não encontrada.');
      const data = {
        regime: dto.regime, pisRate: dto.pisRate, cofinsRate: dto.cofinsRate, scArticle: dto.scArticle?.trim() || null,
        showTotalTaxes: dto.showTotalTaxes, presumedCredit: dto.presumedCredit, exceededSublimit: dto.exceededSublimit,
        icmsByUf: dto.icmsByUf.map((r) => ({ uf: r.uf.toUpperCase(), cst: r.cst, ...(r.ratePct !== undefined ? { ratePct: r.ratePct } : {}) })),
        ibsCbsByUf: dto.ibsCbsByUf.map((r) => ({ uf: r.uf.toUpperCase(), cst: r.cst, classification: r.classification.trim() })),
        updatedById: ctx.userId,
      };
      await tx.federalTaxConfig.upsert({ where: { tenantId_companyId: { tenantId: ctx.tenantId!, companyId } }, create: { tenantId: ctx.tenantId!, companyId, ...data }, update: data });
      await this.audit.record(tx, ctx, { action: 'federal_tax.saved', entity: 'company', entityId: companyId, metadata: { regime: dto.regime, pisRate: dto.pisRate, cofinsRate: dto.cofinsRate, icms: data.icmsByUf.length, ibsCbs: data.ibsCbsByUf.length } });
      return { ok: true };
    });
  }
}

@Controller('fiscal/federal-taxes')
export class FederalTaxController {
  constructor(private readonly svc: FederalTaxService) {}

  @Get() @RequirePermissions('fiscal.view')
  list(@CurrentAuth() ctx: AuthContext) { return this.svc.list(ctx); }

  @Put(':companyId') @RequirePermissions('fiscal.manage')
  save(@CurrentAuth() ctx: AuthContext, @Param('companyId', ParseUUIDPipe) companyId: string, @Body() dto: TaxDto) { return this.svc.save(ctx, companyId, dto); }
}
