import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { PurchaseStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsEnum, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/auth';
import { PurchasingService } from './purchasing.service';

class ItemDto {
  @IsUUID() productId: string;
  @IsInt() @Min(1) @Max(1_000_000) quantity: number;
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) unitCost: number;
}
class PurchaseDto {
  @IsUUID() supplierId: string;
  @IsUUID() warehouseId: string;
  @IsOptional() @IsDateString() expectedDate?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) freight?: number;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => ItemDto) items: ItemDto[];
}
class ListQuery {
  @IsOptional() @IsEnum(PurchaseStatus) status?: PurchaseStatus;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}
class ReasonDto { @IsString() @IsNotEmpty() @MaxLength(300) reason: string; }
class ReceiptItemDto {
  @IsUUID() productId: string;
  @IsInt() @Min(1) @Max(1_000_000) quantity: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) unitCost?: number;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}
class ReceiptDto {
  @IsOptional() @IsString() @MaxLength(300) note?: string;
  @IsOptional() @IsString() @MaxLength(100) idempotencyKey?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => ReceiptItemDto) items: ReceiptItemDto[];
}

@Controller('purchases')
export class PurchasingController {
  constructor(private readonly svc: PurchasingService) {}

  @Get() @RequirePermissions('purchases.view')
  list(@CurrentAuth() ctx: AuthContext, @Query() q: ListQuery) { return this.svc.list(ctx, q); }

  @Get('suggestions') @RequirePermissions('purchases.view')
  suggestions(@CurrentAuth() ctx: AuthContext) { return this.svc.suggestions(ctx); }

  @Get(':id') @RequirePermissions('purchases.view')
  get(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.get(ctx, id); }

  @Post() @RequirePermissions('purchases.create')
  create(@CurrentAuth() ctx: AuthContext, @Body() dto: PurchaseDto) { return this.svc.create(ctx, dto); }

  @Put(':id') @RequirePermissions('purchases.create')
  update(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PurchaseDto) { return this.svc.update(ctx, id, dto); }

  @Post(':id/submit') @HttpCode(200) @RequirePermissions('purchases.create')
  submit(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.submit(ctx, id); }

  @Post(':id/approve') @HttpCode(200) @RequirePermissions('purchases.approve')
  approve(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.approve(ctx, id); }

  @Post(':id/reject') @HttpCode(200) @RequirePermissions('purchases.approve')
  reject(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) { return this.svc.reject(ctx, id, dto.reason); }

  @Post(':id/cancel') @HttpCode(200) @RequirePermissions('purchases.create')
  cancel(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) { return this.svc.cancel(ctx, id, dto.reason); }

  @Post(':id/close') @HttpCode(200) @RequirePermissions('purchases.receive')
  close(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) { return this.svc.closeShort(ctx, id, dto.reason); }

  @Post(':id/receipts') @RequirePermissions('purchases.receive')
  receive(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReceiptDto) { return this.svc.receive(ctx, id, dto); }

  @Post('receipts/:receiptId/reverse') @HttpCode(200) @RequirePermissions('purchases.receive')
  reverse(@CurrentAuth() ctx: AuthContext, @Param('receiptId', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) { return this.svc.reverseReceipt(ctx, id, dto.reason); }
}
