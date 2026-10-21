import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { MovementType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsEnum, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/auth';
import { InventoryService } from './inventory.service';
import { StockService } from './stock.service';

const MAXQ = 1_000_000;

class MoveDto {
  @IsUUID() productId: string;
  @IsUUID() warehouseId: string;
  @IsEnum(MovementType) type: MovementType;
  @IsInt() @Min(-MAXQ) @Max(MAXQ) quantity: number;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
  @IsOptional() @IsString() @MaxLength(100) reference?: string;
  @IsOptional() @IsString() @MaxLength(100) idempotencyKey?: string;
}
class SetOnHandDto {
  @IsUUID() productId: string;
  @IsUUID() warehouseId: string;
  @IsInt() @Min(0) @Max(MAXQ) newOnHand: number;
  @IsString() @IsNotEmpty() @MaxLength(300) reason: string;
  @IsOptional() @IsString() @MaxLength(100) idempotencyKey?: string;
}
class TransferDto {
  @IsUUID() productId: string;
  @IsUUID() fromWarehouseId: string;
  @IsUUID() toWarehouseId: string;
  @IsInt() @Min(1) @Max(MAXQ) quantity: number;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
  @IsOptional() @IsString() @MaxLength(100) idempotencyKey?: string;
}
class ReverseDto {
  @IsString() @IsNotEmpty() @MaxLength(300) reason: string;
}
class BlockDto {
  @IsUUID() productId: string;
  @IsUUID() warehouseId: string;
  @IsInt() @Min(-MAXQ) @Max(MAXQ) quantity: number;
  @IsString() @IsNotEmpty() @MaxLength(300) reason: string;
}
class ReserveDto {
  @IsUUID() productId: string;
  @IsUUID() warehouseId: string;
  @IsInt() @Min(1) @Max(MAXQ) quantity: number;
  @IsOptional() @IsString() @MaxLength(100) reference?: string;
  @IsString() @IsNotEmpty() @MaxLength(100) idempotencyKey: string;
}
class OverviewQuery {
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsIn(['below_min', 'out']) status?: 'below_min' | 'out';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}
class MovementsQuery {
  @IsOptional() @IsUUID() productId?: string;
  @IsOptional() @IsUUID() warehouseId?: string;
  @IsOptional() @IsUUID() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}
class CreateCountDto {
  @IsUUID() warehouseId: string;
  @IsString() @IsNotEmpty() @MaxLength(120) name: string;
  @IsOptional() @IsArray() @ArrayMaxSize(5000) @IsUUID('all', { each: true }) productIds?: string[];
}
class CountEntry {
  @IsOptional() @IsUUID() productId?: string;
  @IsOptional() @IsString() @MaxLength(60) code?: string;
  @IsInt() @Min(0) @Max(MAXQ) countedQty: number;
}
class CountEntriesDto {
  @IsArray() @ArrayMaxSize(1000) @ValidateNested({ each: true }) @Type(() => CountEntry) entries: CountEntry[];
}

@Controller()
export class StockController {
  constructor(
    private readonly stock: StockService,
    private readonly inv: InventoryService,
  ) {}

  @Get('stock/overview') @RequirePermissions('stock.view')
  overview(@CurrentAuth() ctx: AuthContext, @Query() q: OverviewQuery) { return this.stock.overview(ctx, q); }

  @Get('stock/metrics') @RequirePermissions('stock.view')
  metrics(@CurrentAuth() ctx: AuthContext) { return this.stock.metrics(ctx); }

  @Get('stock/balances/:productId') @RequirePermissions('stock.view')
  balances(@CurrentAuth() ctx: AuthContext, @Param('productId', ParseUUIDPipe) id: string) { return this.stock.balances(ctx, id); }

  @Get('stock/movements') @RequirePermissions('stock.view')
  movements(@CurrentAuth() ctx: AuthContext, @Query() q: MovementsQuery) { return this.stock.movements(ctx, q); }

  @Post('stock/movements') @RequirePermissions('stock.move')
  move(@CurrentAuth() ctx: AuthContext, @Body() dto: MoveDto) { return this.stock.move(ctx, dto); }

  @Post('stock/set-on-hand') @RequirePermissions('stock.adjust')
  setOnHand(@CurrentAuth() ctx: AuthContext, @Body() dto: SetOnHandDto) { return this.stock.setOnHand(ctx, dto); }

  @Post('stock/transfers') @RequirePermissions('stock.move')
  transfer(@CurrentAuth() ctx: AuthContext, @Body() dto: TransferDto) { return this.stock.transfer(ctx, dto); }

  @Post('stock/movements/:id/reverse') @RequirePermissions('stock.adjust')
  reverse(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReverseDto) { return this.stock.reverse(ctx, id, dto.reason); }

  @Post('stock/blocks') @RequirePermissions('stock.adjust')
  block(@CurrentAuth() ctx: AuthContext, @Body() dto: BlockDto) { return this.stock.block(ctx, dto); }

  @Post('stock/reservations') @RequirePermissions('stock.move')
  reserve(@CurrentAuth() ctx: AuthContext, @Body() dto: ReserveDto) { return this.stock.reserve(ctx, dto); }

  @Post('stock/reservations/:id/release') @RequirePermissions('stock.move')
  release(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.stock.release(ctx, id); }

  @Post('stock/reservations/:id/consume') @RequirePermissions('stock.move')
  consume(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.stock.consume(ctx, id); }

  // Inventário
  @Get('inventory/counts') @RequirePermissions('stock.view')
  counts(@CurrentAuth() ctx: AuthContext) { return this.inv.list(ctx); }

  @Post('inventory/counts') @RequirePermissions('inventory.count')
  createCount(@CurrentAuth() ctx: AuthContext, @Body() dto: CreateCountDto) { return this.inv.create(ctx, dto); }

  @Get('inventory/counts/:id') @RequirePermissions('stock.view')
  count(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.inv.detail(ctx, id); }

  @Put('inventory/counts/:id/items') @RequirePermissions('inventory.count')
  enter(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CountEntriesDto) { return this.inv.enterCounts(ctx, id, dto.entries); }

  @Post('inventory/counts/:id/submit') @RequirePermissions('inventory.count')
  submit(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.inv.submit(ctx, id); }

  @Post('inventory/counts/:id/approve') @RequirePermissions('stock.approve')
  approve(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.inv.approve(ctx, id); }

  @Post('inventory/counts/:id/reject') @RequirePermissions('stock.approve')
  reject(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.inv.reject(ctx, id); }
}
