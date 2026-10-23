import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsEmail, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/auth';
import { Operation } from './engine';
import { coverage } from './sefaz/registry';
import { schemaManifest } from './sefaz/xsd';
import { FiscalConfigService } from './fiscal-config.service';
import { FiscalInboundService } from './fiscal-inbound.service';
import { FiscalOutgoingService } from './fiscal-outgoing.service';
import { TaxRulesService } from './tax-rules.service';

const OPS = ['PURCHASE', 'SALE', 'RETURN_SALE', 'RETURN_PURCHASE', 'TRANSFER', 'OTHER'];

class ConfigDto {
  @IsOptional() @IsIn(['HOMOLOGACAO', 'PRODUCAO']) environment?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(5) @IsIn(['NFE', 'NFCE', 'NFSE'], { each: true }) documentTypes?: string[];
  @IsOptional() @IsInt() @Min(1) @Max(889) nfeSeries?: number;
  @IsOptional() @IsString() @MaxLength(120) accountantName?: string;
  @IsOptional() @IsEmail() accountantEmail?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}
class ReasonDto { @IsString() @Length(3, 300) reason: string; }
class CertDto {
  @IsString() @MaxLength(400_000) pfxBase64: string;
  @IsString() @Length(1, 200) password: string;
}
class ImportDto {
  @IsString() @MaxLength(3_000_000) xml: string;
  @IsOptional() @IsString() @MaxLength(200) source?: string;
}
class LinkDto { @IsUUID() productId: string; }
class ReceiveDto {
  @IsUUID() purchaseOrderId: string;
  @IsOptional() @IsBoolean() acceptCostDivergence?: boolean;
}
class ScopeDto {
  @IsString() @Length(2, 120) name: string;
  @IsIn(OPS) operation: Operation;
  @IsOptional() @Matches(/^[A-Za-z]{2}$/) originUf?: string;
  @IsOptional() @Matches(/^[A-Za-z]{2}$/) destUf?: string;
  @IsOptional() @Matches(/^\d{2,8}$/) ncmPrefix?: string;
  @IsOptional() @IsString() @MaxLength(30) regime?: string;
  @IsOptional() @IsInt() @Min(0) @Max(8) productOrigin?: number;
  @IsOptional() @IsIn(['CONTRIBUINTE', 'NAO_CONTRIBUINTE']) recipientKind?: string;
  @IsOptional() @IsInt() @Min(0) @Max(1000) priority?: number;
}
class VersionDto {
  @IsDateString() validFrom: string;
  @IsOptional() @IsDateString() validTo?: string;
  @IsObject() config: Record<string, unknown>;
  @IsString() @Length(10, 1000) sourceReference: string;
}
class CreateRuleDto {
  @ValidateNested() @Type(() => ScopeDto) rule: ScopeDto;
  @ValidateNested() @Type(() => VersionDto) version: VersionDto;
}
class DraftPatchDto {
  @IsOptional() @IsDateString() validFrom?: string;
  @IsOptional() @IsDateString() validTo?: string;
  @IsOptional() @IsObject() config?: Record<string, unknown>;
  @IsOptional() @IsString() @Length(10, 1000) sourceReference?: string;
}
class ActiveDto { @IsBoolean() active: boolean; }
class CalcItemDto {
  @IsString() @MaxLength(40) key: string;
  @IsOptional() @IsString() @MaxLength(8) ncm?: string;
  @IsOptional() @IsInt() @Min(0) @Max(8) productOrigin?: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) value: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) freight?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) discount?: number;
}
class CalcDto {
  @IsIn(OPS) operation: Operation;
  @IsOptional() @IsDateString() date?: string;
  @IsOptional() @Matches(/^[A-Za-z]{2}$/) originUf?: string;
  @IsOptional() @Matches(/^[A-Za-z]{2}$/) destUf?: string;
  @IsOptional() @IsString() @MaxLength(30) regime?: string;
  @IsOptional() @IsIn(['CONTRIBUINTE', 'NAO_CONTRIBUINTE']) recipientKind?: string;
  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => CalcItemDto) items: CalcItemDto[];
  @IsOptional() @IsBoolean() persist?: boolean;
}
class PrepareDto {
  @IsUUID() salesOrderId: string;
  @IsOptional() @IsUUID() establishmentId?: string;
  /** 55 = NF-e, 65 = NFC-e. Sem valor, segue o que foi escolhido na venda. */
  @IsOptional() @IsIn(['55', '65']) model?: '55' | '65';
  @IsOptional() @IsIn(['CASH', 'CHECK', 'CREDIT', 'DEBIT', 'BOLETO', 'PIX', 'OTHER']) paymentMethod?: string;
}
class VoidDto {
  @IsUUID() establishmentId: string;
  @IsIn(['55', '65']) model: '55' | '65';
  @IsInt() @Min(1) @Max(999) series: number;
  @IsInt() @Min(1) @Max(999999999) from: number;
  @IsInt() @Min(1) @Max(999999999) to: number;
  @IsString() @Length(15, 255) reason: string;
}
class CancelDocDto { @IsString() @Length(15, 255) reason: string; }
class CscDto { @IsString() @MaxLength(6) id: string; @IsString() @MaxLength(64) token: string; }
class ProviderDto {
  @IsIn(['FOCUS_NFE', 'SEFAZ_DIRECT']) provider: 'FOCUS_NFE' | 'SEFAZ_DIRECT';
  @IsOptional() @ValidateNested() @Type(() => CscDto) cscHomologacao?: CscDto;
  @IsOptional() @ValidateNested() @Type(() => CscDto) cscProducao?: CscDto;
  @IsOptional() @IsString() @MaxLength(200) tokenHomologacao?: string;
  @IsOptional() @IsString() @MaxLength(200) tokenProducao?: string;
}
class TestProviderDto { @IsOptional() @IsIn(['HOMOLOGACAO', 'PRODUCAO']) environment?: 'HOMOLOGACAO' | 'PRODUCAO'; }
class PrepareReturnDto { @IsUUID() returnId: string; }
class CorrectionDto { @IsString() @Length(15, 1000) text: string; }
class ManifestDto { @IsIn(['CIENCIA', 'CONFIRMACAO', 'DESCONHECIMENTO', 'NAO_REALIZADA']) action: string; @IsOptional() @IsString() @Length(15, 255) justification?: string; }
class FileQuery { @IsIn(['danfe', 'xml']) kind: 'danfe' | 'xml'; }
class StatusQuery { @IsOptional() @IsString() @MaxLength(30) status?: string; }
class ReconcileQuery { @IsOptional() @IsUUID() purchaseOrderId?: string; }

@Controller('fiscal')
export class FiscalController {
  constructor(
    private readonly cfg: FiscalConfigService,
    private readonly inbound: FiscalInboundService,
    private readonly rules: TaxRulesService,
    private readonly outgoing: FiscalOutgoingService,
  ) {}

  // configuração, assistente e certificado
  @Get('establishments') @RequirePermissions('fiscal.view')
  establishments(@CurrentAuth() ctx: AuthContext) { return this.cfg.listEstablishments(ctx); }

  @Get('establishments/:id/config') @RequirePermissions('fiscal.view')
  config(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.cfg.getConfig(ctx, id); }

  @Put('establishments/:id/config') @RequirePermissions('fiscal.manage')
  updateConfig(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ConfigDto) { return this.cfg.updateConfig(ctx, id, dto); }

  @Post('establishments/:id/config/submit') @HttpCode(200) @RequirePermissions('fiscal.manage')
  submit(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.cfg.submitForAccountant(ctx, id); }

  @Post('establishments/:id/config/approve') @HttpCode(200) @RequirePermissions('fiscal.approve')
  approve(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.cfg.approve(ctx, id); }

  @Post('establishments/:id/config/reject') @HttpCode(200) @RequirePermissions('fiscal.approve')
  reject(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) { return this.cfg.reject(ctx, id, dto.reason); }

  @Post('establishments/:id/certificate') @RequirePermissions('fiscal.manage')
  certificate(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CertDto) { return this.cfg.uploadCertificate(ctx, id, dto); }

  @Get('establishments/:id/provider') @RequirePermissions('fiscal.view')
  getProvider(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.cfg.getProvider(ctx, id); }

  @Put('establishments/:id/provider') @RequirePermissions('fiscal.manage')
  setProvider(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ProviderDto) { return this.cfg.setProvider(ctx, id, dto); }

  @Delete('establishments/:id/provider') @RequirePermissions('fiscal.manage')
  clearProvider(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.cfg.clearProvider(ctx, id); }

  @Post('establishments/:id/provider/test') @HttpCode(200) @RequirePermissions('fiscal.manage')
  testProvider(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TestProviderDto) { return this.cfg.testProvider(ctx, id, dto.environment); }

  @Get('metrics') @RequirePermissions('fiscal.view')
  metrics(@CurrentAuth() ctx: AuthContext) { return this.cfg.metrics(ctx); }

  // documentos recebidos
  @Post('inbound/import') @RequirePermissions('fiscal.import')
  importXml(@CurrentAuth() ctx: AuthContext, @Body() dto: ImportDto) { return this.inbound.importXml(ctx, dto); }

  @Get('inbound') @RequirePermissions('fiscal.view')
  inboundList(@CurrentAuth() ctx: AuthContext, @Query() q: StatusQuery) { return this.inbound.list(ctx, q.status); }

  @Get('inbound/:id') @RequirePermissions('fiscal.view')
  inboundGet(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.inbound.get(ctx, id); }

  @Get('inbound/:id/xml') @RequirePermissions('fiscal.view')
  inboundXml(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.inbound.xml(ctx, id); }

  @Put('inbound/:id/items/:line/product') @RequirePermissions('fiscal.import')
  link(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('line', ParseIntPipe) line: number, @Body() dto: LinkDto) { return this.inbound.linkItem(ctx, id, line, dto.productId); }

  @Post('inbound/:id/supplier') @HttpCode(200) @RequirePermissions('fiscal.import')
  supplier(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.inbound.createSupplier(ctx, id); }

  @Get('inbound/:id/reconcile') @RequirePermissions('fiscal.import')
  reconcile(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: ReconcileQuery) { return this.inbound.reconcile(ctx, id, q.purchaseOrderId); }

  @Post('inbound/:id/receive') @HttpCode(200) @RequirePermissions('fiscal.import')
  receive(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReceiveDto) { return this.inbound.receive(ctx, id, dto); }

  // regras tributárias e motor
  @Get('rules') @RequirePermissions('fiscal.view')
  listRules(@CurrentAuth() ctx: AuthContext) { return this.rules.list(ctx); }

  @Post('rules') @RequirePermissions('fiscal.rules')
  createRule(@CurrentAuth() ctx: AuthContext, @Body() dto: CreateRuleDto) { return this.rules.create(ctx, dto.rule, dto.version); }

  @Post('rules/:id/versions') @RequirePermissions('fiscal.rules')
  addVersion(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VersionDto) { return this.rules.addVersion(ctx, id, dto); }

  @Put('rules/versions/:vid') @RequirePermissions('fiscal.rules')
  patchVersion(@CurrentAuth() ctx: AuthContext, @Param('vid', ParseUUIDPipe) vid: string, @Body() dto: DraftPatchDto) { return this.rules.updateDraft(ctx, vid, dto); }

  @Post('rules/versions/:vid/submit') @HttpCode(200) @RequirePermissions('fiscal.rules')
  submitVersion(@CurrentAuth() ctx: AuthContext, @Param('vid', ParseUUIDPipe) vid: string) { return this.rules.submit(ctx, vid); }

  @Post('rules/versions/:vid/approve') @HttpCode(200) @RequirePermissions('fiscal.approve')
  approveVersion(@CurrentAuth() ctx: AuthContext, @Param('vid', ParseUUIDPipe) vid: string) { return this.rules.approve(ctx, vid); }

  @Post('rules/versions/:vid/reject') @HttpCode(200) @RequirePermissions('fiscal.approve')
  rejectVersion(@CurrentAuth() ctx: AuthContext, @Param('vid', ParseUUIDPipe) vid: string, @Body() dto: ReasonDto) { return this.rules.reject(ctx, vid, dto.reason); }

  @Put('rules/:id/active') @RequirePermissions('fiscal.rules')
  active(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ActiveDto) { return this.rules.setActive(ctx, id, dto.active); }

  @Post('engine/calculate') @HttpCode(200) @RequirePermissions('fiscal.view')
  calculate(@CurrentAuth() ctx: AuthContext, @Body() dto: CalcDto) {
    if (dto.persist && !ctx.permissions.has('fiscal.emit')) throw new ForbiddenException('Você não tem permissão para esta ação.');
    return this.rules.calculateEndpoint(ctx, {
      operation: dto.operation, date: dto.date ? new Date(dto.date) : new Date(), originUf: dto.originUf?.toUpperCase() ?? null, destUf: dto.destUf?.toUpperCase() ?? null, regime: dto.regime ?? null,
      recipientKind: dto.recipientKind ?? null, items: dto.items.map((i) => ({ key: i.key, ncm: i.ncm ?? null, productOrigin: i.productOrigin ?? null, value: i.value, freight: i.freight, discount: i.discount })),
    }, !!dto.persist);
  }

  // saída
  @Post('outgoing/prepare') @HttpCode(200) @RequirePermissions('fiscal.emit')
  prepare(@CurrentAuth() ctx: AuthContext, @Body() dto: PrepareDto) { return this.outgoing.prepare(ctx, dto); }

  @Get('outgoing') @RequirePermissions('fiscal.view')
  outgoingList(@CurrentAuth() ctx: AuthContext, @Query() q: StatusQuery) { return this.outgoing.list(ctx, q.status); }

  @Get('outgoing/returnable') @RequirePermissions('fiscal.view')
  returnable(@CurrentAuth() ctx: AuthContext) { return this.outgoing.returnable(ctx); }

  @Get('outgoing/:id') @RequirePermissions('fiscal.view')
  outgoingGet(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.outgoing.get(ctx, id); }

  @Post('outgoing/:id/revalidate') @HttpCode(200) @RequirePermissions('fiscal.emit')
  revalidate(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.outgoing.revalidate(ctx, id); }

  @Post('outgoing/:id/transmit') @HttpCode(200) @RequirePermissions('fiscal.emit')
  transmit(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.outgoing.transmit(ctx, id); }

  @Post('inutilizacao') @HttpCode(200) @RequirePermissions('fiscal.emit')
  inutilize(@CurrentAuth() ctx: AuthContext, @Body() dto: VoidDto) { return this.outgoing.inutilize(ctx, dto); }

  @Get('inutilizacao') @RequirePermissions('fiscal.view')
  voids(@CurrentAuth() ctx: AuthContext) { return this.outgoing.voids(ctx); }

  @Get('sefaz/coverage') @RequirePermissions('fiscal.view')
  coverage() { return { schemas: schemaManifest(), rows: coverage() }; }

  @Post('outgoing/:id/cancel') @HttpCode(200) @RequirePermissions('fiscal.emit')
  cancelDoc(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelDocDto) { return this.outgoing.cancel(ctx, id, dto.reason); }

  @Post('outgoing/prepare-return') @HttpCode(200) @RequirePermissions('fiscal.emit')
  prepareReturn(@CurrentAuth() ctx: AuthContext, @Body() dto: PrepareReturnDto) { return this.outgoing.prepareReturn(ctx, dto.returnId); }

  @Post('outgoing/:id/correction') @HttpCode(200) @RequirePermissions('fiscal.emit')
  correct(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CorrectionDto) { return this.outgoing.correct(ctx, id, dto.text); }

  @Get('outgoing/:id/events') @RequirePermissions('fiscal.view')
  outgoingEvents(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.outgoing.events(ctx, id); }

  @Post('inbound/:id/manifest') @HttpCode(200) @RequirePermissions('fiscal.emit')
  manifest(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ManifestDto) { return this.inbound.manifest(ctx, id, dto.action, dto.justification); }

  @Get('inbound/:id/events') @RequirePermissions('fiscal.view')
  inboundEvents(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.inbound.events(ctx, id); }

  @Get('outgoing/:id/file') @RequirePermissions('fiscal.view')
  async file(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: FileQuery, @Res() res: Response) {
    const f = await this.outgoing.file(ctx, id, q.kind);
    res.setHeader('Content-Type', f.contentType); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    res.setHeader('Content-Disposition', `${q.kind === 'xml' ? 'attachment' : 'inline'}; filename="${f.name}"`);
    res.send(f.content);
  }

  @Post('outgoing/:id/consult') @HttpCode(200) @RequirePermissions('fiscal.emit')
  consult(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.outgoing.consult(ctx, id); }
}
