import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min } from 'class-validator';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/auth';
import { LogisticsService } from './logistics.service';

class PackagingDto {
  @IsString() @Length(2, 80) name: string;
  @IsInt() @Min(1) @Max(2000) lengthMm: number;
  @IsInt() @Min(1) @Max(2000) widthMm: number;
  @IsInt() @Min(1) @Max(2000) heightMm: number;
  @IsInt() @Min(1) @Max(100_000_000) maxWeightG: number;
  @IsOptional() @IsInt() @Min(0) tareG?: number;
}
class ShipmentDto {
  @IsUUID() salesOrderId: string;
  @IsIn(['CORREIOS', 'OUTRA']) carrier: 'CORREIOS' | 'OUTRA';
  @IsOptional() @IsString() @MaxLength(60) service?: string;
  @IsOptional() @IsString() @MaxLength(40) trackingCode?: string;
  @IsOptional() @IsUUID() packagingId?: string;
  @IsOptional() @IsInt() @Min(1) @Max(100_000_000) weightG?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1e7) cost?: number;
}
class EventDto {
  @IsIn(['PENDING', 'POSTED', 'IN_TRANSIT', 'DELIVERED', 'PROBLEM', 'CANCELLED']) status: 'PENDING' | 'POSTED' | 'IN_TRANSIT' | 'DELIVERED' | 'PROBLEM' | 'CANCELLED';
  @IsString() @Length(2, 300) description: string;
  @IsOptional() @IsDateString() occurredAt?: string;
  @IsOptional() @IsString() @MaxLength(120) location?: string;
  @IsOptional() @IsString() @MaxLength(40) trackingCode?: string;
}
class ListQuery { @IsOptional() @IsIn(['PENDING', 'POSTED', 'IN_TRANSIT', 'DELIVERED', 'PROBLEM', 'CANCELLED']) status?: string; }

@Controller('logistics')
export class LogisticsController {
  constructor(private readonly svc: LogisticsService) {}

  @Get('capabilities') @RequirePermissions('logistics.view')
  capabilities() { return this.svc.capabilities(); }

  @Get('packagings') @RequirePermissions('logistics.view')
  packagings(@CurrentAuth() ctx: AuthContext) { return this.svc.packagings(ctx); }
  @Post('packagings') @RequirePermissions('logistics.manage')
  createPackaging(@CurrentAuth() ctx: AuthContext, @Body() dto: PackagingDto) { return this.svc.createPackaging(ctx, dto); }

  @Get('queue') @RequirePermissions('logistics.view')
  queue(@CurrentAuth() ctx: AuthContext) { return this.svc.queue(ctx); }

  @Get('shipments') @RequirePermissions('logistics.view')
  list(@CurrentAuth() ctx: AuthContext, @Query() q: ListQuery) { return this.svc.list(ctx, q.status); }
  @Get('shipments/:id') @RequirePermissions('logistics.view')
  get(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.get(ctx, id); }
  @Post('shipments') @RequirePermissions('logistics.manage')
  create(@CurrentAuth() ctx: AuthContext, @Body() dto: ShipmentDto) { return this.svc.create(ctx, dto); }
  @Post('shipments/:id/events') @HttpCode(200) @RequirePermissions('logistics.manage')
  addEvent(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: EventDto) { return this.svc.addEvent(ctx, id, dto); }
}
