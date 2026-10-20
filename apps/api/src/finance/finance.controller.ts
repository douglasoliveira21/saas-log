import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/auth';
import { BankService } from './bank.service';
import { FinanceService } from './finance.service';
import { MarketplaceFinanceService } from './marketplace-finance.service';
import { StatementsService } from './statements.service';

const KINDS_CATEGORY = ['REVENUE', 'DEDUCTION', 'COGS', 'VARIABLE_EXPENSE', 'OPERATING_EXPENSE', 'FINANCIAL', 'OTHER'];
const money = { maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false } as const;

class AccountDto {
  @IsString() @Length(2, 80) name: string;
  @IsIn(['BANK', 'CASH', 'MARKETPLACE', 'OTHER']) kind: string;
  @IsOptional() @IsString() @MaxLength(80) bankName?: string;
  @IsOptional() @IsString() @MaxLength(20) agency?: string;
  @IsOptional() @IsString() @MaxLength(30) accountNumber?: string;
  @IsOptional() @IsNumber(money) @Min(-1e9) @Max(1e9) openingBalance?: number;
  @IsOptional() @IsDateString() openingDate?: string;
}
class ActiveDto { @IsBoolean() active: boolean; }
class CategoryDto { @IsString() @Length(2, 80) name: string; @IsIn(KINDS_CATEGORY) kind: string; }
class NameDto { @IsString() @Length(2, 80) name: string; }

class InstallmentDto { @IsDateString() dueDate: string; @IsNumber(money) @Min(0.01) amount: number; }
class TitleDto {
  @IsIn(['PAYABLE', 'RECEIVABLE']) direction: 'PAYABLE' | 'RECEIVABLE';
  @IsString() @Length(2, 200) description: string;
  @IsNumber(money) @Min(0.01) @Max(1e9) amount: number;
  @IsDateString() dueDate: string;
  @IsOptional() @IsUUID() supplierId?: string;
  @IsOptional() @IsUUID() customerId?: string;
  @IsOptional() @IsString() @MaxLength(120) counterpartyName?: string;
  @IsOptional() @IsString() @MaxLength(60) documentRef?: string;
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsUUID() costCenterId?: string;
  @IsOptional() @IsDateString() issueDate?: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsOptional() @IsIn(['SINGLE', 'SPLIT', 'RECURRING']) mode?: 'SINGLE' | 'SPLIT' | 'RECURRING';
  @IsOptional() @IsInt() @Min(2) @Max(60) count?: number;
}
class ReasonDto { @IsString() @Length(3, 300) reason: string; }
class SettleDto {
  @IsUUID() accountId: string;
  @IsNumber(money) @Min(0.01) @Max(1e9) amount: number;
  @IsOptional() @IsNumber(money) @Min(0) interest?: number;
  @IsOptional() @IsNumber(money) @Min(0) fine?: number;
  @IsOptional() @IsNumber(money) @Min(0) discount?: number;
  @IsOptional() @IsDateString() paidAt?: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
  @IsOptional() @IsNumber(money) @Min(0) expectedOutstanding?: number;
}
class FromXmlDto { @IsOptional() @IsUUID() categoryId?: string; @IsOptional() @IsUUID() costCenterId?: string; @IsOptional() @IsDateString() dueDate?: string; }
class FromOrderDto {
  @IsOptional() @IsArray() @ArrayMaxSize(60) @ValidateNested({ each: true }) @Type(() => InstallmentDto) installments?: InstallmentDto[];
  @IsOptional() @IsInt() @Min(1) @Max(60) count?: number;
  @IsOptional() @IsDateString() firstDueDate?: string;
  @IsOptional() @IsInt() @Min(1) @Max(365) intervalDays?: number;
  @IsOptional() @IsUUID() categoryId?: string;
}
class PayoutDto { @IsUUID() salespersonId: string; @IsDateString() dueDate: string; @IsOptional() @IsUUID() categoryId?: string; @IsOptional() @IsUUID() costCenterId?: string; }

class ListQuery {
  @IsOptional() @IsIn(['PAYABLE', 'RECEIVABLE']) direction?: string;
  @IsOptional() @IsIn(['OPEN', 'PARTIAL', 'PAID', 'CANCELLED']) status?: string;
  @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean() overdue?: boolean;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsString() @MaxLength(80) search?: string;
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsUUID() costCenterId?: string;
  @IsOptional() @IsIn(['MANUAL', 'FISCAL_XML', 'SALES_ORDER', 'COMMISSION', 'MARKETPLACE']) origin?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}
class RangeQuery {
  @IsDateString() from: string;
  @IsDateString() to: string;
  @IsOptional() @IsIn(['day', 'week', 'month']) granularity?: 'day' | 'week' | 'month';
  @IsOptional() @IsUUID() accountId?: string;
  @IsOptional() @IsUUID() costCenterId?: string;
}

class StatementDto {
  @IsIn(['OFX', 'CSV']) format: 'OFX' | 'CSV';
  @IsString() @MaxLength(3_000_000) content: string;
}
class LinesQuery { @IsOptional() @Transform(({ value }) => (value === undefined ? undefined : value === 'true')) @IsBoolean() matched?: boolean; }
class MatchDto { @IsUUID() settlementId: string; }

class MktImportDto { @IsString() @Length(2, 80) reportRef: string; @IsString() @MaxLength(3_000_000) csv: string; }
class MktReconcileDto { @IsUUID() accountId: string; @IsOptional() @IsBoolean() acceptDivergence?: boolean; @IsOptional() @IsString() @MaxLength(300) note?: string; }
class MktListQuery { @IsOptional() @IsIn(['IMPORTED', 'UNLINKED', 'DIVERGENT', 'RECONCILED']) status?: string; }

@Controller('finance')
export class FinanceController {
  constructor(
    private readonly svc: FinanceService,
    private readonly bank: BankService,
    private readonly mkt: MarketplaceFinanceService,
    private readonly stm: StatementsService,
  ) {}

  // cadastros
  @Get('accounts') @RequirePermissions('finance.view')
  accounts(@CurrentAuth() ctx: AuthContext) { return this.svc.listAccounts(ctx); }
  @Post('accounts') @RequirePermissions('finance.manage')
  createAccount(@CurrentAuth() ctx: AuthContext, @Body() dto: AccountDto) { return this.svc.createAccount(ctx, dto); }
  @Put('accounts/:id/active') @RequirePermissions('finance.manage')
  setActive(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ActiveDto) { return this.svc.setAccountActive(ctx, id, dto.active); }
  @Get('categories') @RequirePermissions('finance.view')
  categories(@CurrentAuth() ctx: AuthContext) { return this.svc.listCategories(ctx); }
  @Post('categories') @RequirePermissions('finance.manage')
  createCategory(@CurrentAuth() ctx: AuthContext, @Body() dto: CategoryDto) { return this.svc.createCategory(ctx, dto); }
  @Get('cost-centers') @RequirePermissions('finance.view')
  costCenters(@CurrentAuth() ctx: AuthContext) { return this.svc.listCostCenters(ctx); }
  @Post('cost-centers') @RequirePermissions('finance.manage')
  createCostCenter(@CurrentAuth() ctx: AuthContext, @Body() dto: NameDto) { return this.svc.createCostCenter(ctx, dto.name); }

  // títulos
  @Get('titles') @RequirePermissions('finance.view')
  list(@CurrentAuth() ctx: AuthContext, @Query() q: ListQuery) { return this.svc.list(ctx, q); }
  @Get('summary') @RequirePermissions('finance.view')
  summary(@CurrentAuth() ctx: AuthContext) { return this.svc.summary(ctx); }
  @Get('titles/:id') @RequirePermissions('finance.view')
  get(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.get(ctx, id); }
  @Post('titles') @RequirePermissions('finance.manage')
  create(@CurrentAuth() ctx: AuthContext, @Body() dto: TitleDto) { return this.svc.create(ctx, dto); }
  @Post('titles/:id/approve') @HttpCode(200) @RequirePermissions('finance.approve')
  approve(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.approve(ctx, id); }
  @Post('titles/:id/cancel') @HttpCode(200) @RequirePermissions('finance.manage')
  cancel(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) { return this.svc.cancel(ctx, id, dto.reason); }
  @Post('titles/:id/settle') @HttpCode(200) @RequirePermissions('finance.manage')
  settle(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SettleDto) { return this.svc.settle(ctx, id, dto); }
  @Post('settlements/:id/reverse') @HttpCode(200) @RequirePermissions('finance.manage')
  reverse(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) { return this.svc.reverse(ctx, id, dto.reason); }

  // origens
  @Post('from-xml/:docId') @RequirePermissions('finance.manage')
  fromXml(@CurrentAuth() ctx: AuthContext, @Param('docId', ParseUUIDPipe) id: string, @Body() dto: FromXmlDto) { return this.svc.fromXml(ctx, id, dto); }
  @Post('from-order/:orderId') @RequirePermissions('finance.manage')
  fromOrder(@CurrentAuth() ctx: AuthContext, @Param('orderId', ParseUUIDPipe) id: string, @Body() dto: FromOrderDto) { return this.svc.fromOrder(ctx, id, dto); }
  @Post('commission-payout') @RequirePermissions('finance.manage', 'commissions.manage')
  payout(@CurrentAuth() ctx: AuthContext, @Body() dto: PayoutDto) { return this.svc.commissionPayout(ctx, dto); }

  // demonstrativos
  @Get('cashflow') @RequirePermissions('finance.view')
  cashflow(@CurrentAuth() ctx: AuthContext, @Query() q: RangeQuery) { return this.stm.cashflow(ctx, q); }
  @Get('dre') @RequirePermissions('finance.view')
  dre(@CurrentAuth() ctx: AuthContext, @Query() q: RangeQuery) { return this.stm.dre(ctx, q); }

  // conciliação bancária
  @Post('accounts/:id/statement') @RequirePermissions('finance.reconcile')
  importStatement(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: StatementDto) { return this.bank.importStatement(ctx, id, dto); }
  @Get('accounts/:id/statement') @RequirePermissions('finance.reconcile')
  lines(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: LinesQuery) { return this.bank.lines(ctx, id, q.matched); }
  @Post('statement-lines/:id/match') @HttpCode(200) @RequirePermissions('finance.reconcile')
  match(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MatchDto) { return this.bank.match(ctx, id, dto.settlementId); }
  @Post('statement-lines/:id/unmatch') @HttpCode(200) @RequirePermissions('finance.reconcile')
  unmatch(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.bank.unmatch(ctx, id); }

  // conciliação de marketplaces
  @Post('marketplace/:connectionId/reports') @RequirePermissions('finance.reconcile')
  importReport(@CurrentAuth() ctx: AuthContext, @Param('connectionId', ParseUUIDPipe) id: string, @Body() dto: MktImportDto) { return this.mkt.importReport(ctx, id, dto); }
  @Get('marketplace/:connectionId/settlements') @RequirePermissions('finance.reconcile')
  settlements(@CurrentAuth() ctx: AuthContext, @Param('connectionId', ParseUUIDPipe) id: string, @Query() q: MktListQuery) { return this.mkt.list(ctx, id, q.status); }
  @Post('marketplace/settlements/:id/reconcile') @HttpCode(200) @RequirePermissions('finance.reconcile', 'finance.manage')
  reconcile(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MktReconcileDto) { return this.mkt.reconcile(ctx, id, dto); }
}
