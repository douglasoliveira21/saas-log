import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { FiscalDocChoice, CommissionRuleKind, CommissionStatus, OrderStatus, SalesChannel } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEmail, IsEnum, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/auth';
import { IsBrPhone } from '../common/phone';
import { CommissionsService } from '../commissions/commissions.service';
import { SalesService } from './sales.service';

const money = { maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false } as const;

class OrderItemDto {
  @IsUUID() productId: string;
  @IsInt() @Min(1) @Max(1_000_000) quantity: number;
  @IsOptional() @IsNumber(money) @Min(0) unitPrice?: number;
  @IsOptional() @IsNumber(money) @Min(0) @Max(100) discountPct?: number;
}
class OrderDto {
  @IsUUID() customerId: string;
  @IsUUID() warehouseId: string;
  @IsOptional() @IsUUID() salespersonId?: string;
  @IsOptional() @IsEnum(SalesChannel) channel?: SalesChannel;
  @IsOptional() @IsEnum(FiscalDocChoice) fiscalDocType?: FiscalDocChoice;
  @IsOptional() @IsNumber(money) @Min(0) shipping?: number;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => OrderItemDto) items: OrderItemDto[];
}
class ListQuery {
  @IsOptional() @IsEnum(OrderStatus) status?: OrderStatus;
  @IsOptional() @IsString() @MaxLength(80) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}
class ReasonDto { @IsString() @IsNotEmpty() @MaxLength(300) reason: string; }
class AdvanceDto { @IsEnum(OrderStatus) to: OrderStatus; }
class ReturnItemDto {
  @IsUUID() orderItemId: string;
  @IsInt() @Min(1) quantity: number;
}
class ReturnDto {
  @IsString() @IsNotEmpty() @MaxLength(300) reason: string;
  @IsOptional() @IsBoolean() restock?: boolean;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => ReturnItemDto) items: ReturnItemDto[];
}

class SalespersonDto {
  @IsString() @Length(2, 120) name: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsBrPhone() @MaxLength(30) phone?: string;
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @IsString() @Length(3, 20) employment?: string;
  @IsOptional() @IsUUID() supervisorId?: string;
}
class SalespersonUpdateDto {
  @IsOptional() @IsString() @Length(2, 120) name?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsBrPhone() @MaxLength(30) phone?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}
class RuleDto {
  @IsString() @Length(2, 120) name: string;
  @IsEnum(CommissionRuleKind) kind: CommissionRuleKind;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(100) percent?: number;
  @IsOptional() @IsNumber(money) @Min(0) fixedAmount?: number;
  @IsOptional() @IsInt() @Min(0) @Max(1000) priority?: number;
  @IsOptional() @IsUUID() salespersonId?: string;
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsUUID() productId?: string;
  @IsOptional() @IsUUID() customerId?: string;
  @IsOptional() @IsEnum(SalesChannel) channel?: SalesChannel;
  @IsOptional() @IsDateString() validFrom?: string;
  @IsOptional() @IsDateString() validTo?: string;
}
class CommissionQuery {
  @IsOptional() @IsUUID() salespersonId?: string;
  @IsOptional() @IsEnum(CommissionStatus) status?: CommissionStatus;
  @IsOptional() @IsUUID() orderId?: string;
}
class PayDto { @IsUUID() salespersonId: string; }
class ActiveDto { @IsBoolean() active: boolean; }

@Controller()
export class SalesController {
  constructor(
    private readonly sales: SalesService,
    private readonly commissions: CommissionsService,
  ) {}

  @Get('sales/orders') @RequirePermissions('sales.view')
  list(@CurrentAuth() ctx: AuthContext, @Query() q: ListQuery) { return this.sales.list(ctx, q); }

  @Get('sales/orders/:id') @RequirePermissions('sales.view')
  get(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.sales.get(ctx, id); }

  @Get('sales/cutoff') @RequirePermissions('sales.view')
  cutoff(@CurrentAuth() ctx: AuthContext) { return this.sales.cutoffInfo(ctx); }

  @Get('sales/orders/:id/fiscal-preview') @RequirePermissions('sales.view')
  fiscalPreview(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.sales.fiscalPreview(ctx, id); }

  @Post('sales/orders') @RequirePermissions('sales.create')
  create(@CurrentAuth() ctx: AuthContext, @Body() dto: OrderDto) { return this.sales.create(ctx, dto); }

  @Put('sales/orders/:id') @RequirePermissions('sales.create')
  update(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: OrderDto) { return this.sales.update(ctx, id, dto); }

  @Post('sales/orders/:id/submit') @HttpCode(200) @RequirePermissions('sales.create')
  submit(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.sales.submit(ctx, id); }

  @Post('sales/orders/:id/approve') @HttpCode(200) @RequirePermissions('sales.approve')
  approve(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.sales.approve(ctx, id); }

  @Post('sales/orders/:id/reject') @HttpCode(200) @RequirePermissions('sales.approve')
  reject(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) { return this.sales.reject(ctx, id, dto.reason); }

  @Post('sales/orders/:id/advance') @HttpCode(200) @RequirePermissions('sales.fulfill')
  advance(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdvanceDto) { return this.sales.advance(ctx, id, dto.to); }

  @Post('sales/orders/:id/cancel') @HttpCode(200) @RequirePermissions('sales.create')
  cancel(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) { return this.sales.cancel(ctx, id, dto.reason); }

  @Post('sales/orders/:id/returns') @RequirePermissions('sales.return')
  createReturn(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReturnDto) { return this.sales.createReturn(ctx, id, dto); }

  // vendedores, regras e comissões
  @Get('salespeople') @RequirePermissions('commissions.view')
  salespeople(@CurrentAuth() ctx: AuthContext) { return this.commissions.listSalespeople(ctx); }

  @Post('salespeople') @RequirePermissions('commissions.manage')
  createSalesperson(@CurrentAuth() ctx: AuthContext, @Body() dto: SalespersonDto) { return this.commissions.createSalesperson(ctx, dto); }

  @Put('salespeople/:id') @RequirePermissions('commissions.manage')
  updateSalesperson(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SalespersonUpdateDto) { return this.commissions.updateSalesperson(ctx, id, dto); }

  @Get('commission-rules') @RequirePermissions('commissions.manage')
  rules(@CurrentAuth() ctx: AuthContext) { return this.commissions.listRules(ctx); }

  @Post('commission-rules') @RequirePermissions('commissions.manage')
  createRule(@CurrentAuth() ctx: AuthContext, @Body() dto: RuleDto) {
    return this.commissions.createRule(ctx, { ...dto, validFrom: dto.validFrom ? new Date(dto.validFrom) : undefined, validTo: dto.validTo ? new Date(dto.validTo) : undefined });
  }

  @Put('commission-rules/:id/active') @RequirePermissions('commissions.manage')
  setActive(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ActiveDto) { return this.commissions.setRuleActive(ctx, id, dto.active); }

  @Get('commissions') @RequirePermissions('commissions.view')
  commissionsList(@CurrentAuth() ctx: AuthContext, @Query() q: CommissionQuery) { return this.commissions.list(ctx, q); }

  @Post('commissions/pay') @HttpCode(200) @RequirePermissions('commissions.manage')
  pay(@CurrentAuth() ctx: AuthContext, @Body() dto: PayDto) { return this.commissions.pay(ctx, dto.salespersonId); }
}
