import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res, Delete } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, ValidateNested, IsBoolean, IsEmail } from 'class-validator';
import type { Response } from 'express';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/auth';
import { DeliveryService } from './delivery.service';

class DriverDto {
  @IsString() @Length(2, 120) name: string;
  @IsEmail({}, { message: 'E-mail inválido.' }) email: string;
  @IsString() @Length(8, 200) password: string;
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
  @IsOptional() @IsString() @MaxLength(60) vehicle?: string;
  @IsOptional() @IsString() @MaxLength(10) plate?: string;
}
class DriverUpdateDto {
  @IsOptional() @IsString() @Length(2, 120) name?: string;
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
  @IsOptional() @IsString() @MaxLength(60) vehicle?: string;
  @IsOptional() @IsString() @MaxLength(10) plate?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}
class RouteDto {
  @IsDateString({ strict: true }) routeDate: string;
  @IsUUID() driverId: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsUUID('all', { each: true }) orderIds: string[];
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @IsOptional() @IsBoolean() autoSort?: boolean;
}
class RouteListQuery {
  @IsOptional() @IsIn(['PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']) status?: string;
  @IsOptional() @IsDateString({ strict: true }) date?: string;
}
class ReorderDto { @IsArray() @ArrayMaxSize(100) @IsUUID('all', { each: true }) stopIds: string[]; }
class AddStopDto { @IsUUID() orderId: string; }
class CancelDto { @IsString() @IsNotEmpty() @MaxLength(300) reason: string; }
class PhotoDto { @IsString() @MaxLength(6_000_000) contentBase64: string; }
class GeoDto {
  @IsOptional() @IsNumber() @Min(-90) @Max(90) lat?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) lng?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100000) accuracyM?: number;
}
class DeliverDto extends GeoDto {
  @IsOptional() @ValidateNested() @Type(() => PhotoDto) photo?: PhotoDto;
  @IsString() @Length(2, 120) receiverName: string;
  @IsOptional() @IsString() @MaxLength(30) receiverDocument?: string;
  @IsOptional() @IsString() @MaxLength(300) notes?: string;
}
class FailDto extends GeoDto {
  @IsString() @Length(3, 300) reason: string;
  @IsOptional() @ValidateNested() @Type(() => PhotoDto) photo?: PhotoDto;
}
class ProofQuery { @IsOptional() @IsIn(['DELIVERY', 'FAILURE']) kind?: 'DELIVERY' | 'FAILURE'; }

@Controller('delivery')
export class DeliveryController {
  constructor(private readonly svc: DeliveryService) {}

  // ── despachante ──
  @Get('drivers') @RequirePermissions('routes.view')
  drivers(@CurrentAuth() ctx: AuthContext) { return this.svc.listDrivers(ctx); }
  @Post('drivers') @RequirePermissions('routes.manage')
  createDriver(@CurrentAuth() ctx: AuthContext, @Body() dto: DriverDto) { return this.svc.createDriver(ctx, dto); }
  @Put('drivers/:id') @RequirePermissions('routes.manage')
  updateDriver(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DriverUpdateDto) { return this.svc.updateDriver(ctx, id, dto); }

  @Get('eligible-orders') @RequirePermissions('routes.view')
  eligible(@CurrentAuth() ctx: AuthContext) { return this.svc.eligibleOrders(ctx); }

  @Get('routes') @RequirePermissions('routes.view')
  routes(@CurrentAuth() ctx: AuthContext, @Query() q: RouteListQuery) { return this.svc.listRoutes(ctx, q); }
  @Get('routes/:id') @RequirePermissions('routes.view')
  route(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.getRoute(ctx, id); }
  @Post('routes') @RequirePermissions('routes.manage')
  createRoute(@CurrentAuth() ctx: AuthContext, @Body() dto: RouteDto) { return this.svc.createRoute(ctx, dto); }
  @Put('routes/:id/order') @RequirePermissions('routes.manage')
  reorder(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReorderDto) { return this.svc.reorder(ctx, id, dto.stopIds); }
  @Post('routes/:id/auto-sort') @HttpCode(200) @RequirePermissions('routes.manage')
  autoSort(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.autoSort(ctx, id); }
  @Post('routes/:id/stops') @RequirePermissions('routes.manage')
  addStop(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddStopDto) { return this.svc.addStop(ctx, id, dto.orderId); }
  @Delete('routes/:id/stops/:stopId') @RequirePermissions('routes.manage')
  removeStop(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('stopId', ParseUUIDPipe) stopId: string) { return this.svc.removeStop(ctx, id, stopId); }
  @Post('routes/:id/start') @HttpCode(200) @RequirePermissions('routes.manage')
  start(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.start(ctx, id); }
  @Post('routes/:id/cancel') @HttpCode(200) @RequirePermissions('routes.manage')
  cancel(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelDto) { return this.svc.cancel(ctx, id, dto.reason); }

  @Get('stops/:id/proof') @RequirePermissions('routes.view') @Header('X-Content-Type-Options', 'nosniff') @Header('Cache-Control', 'private, max-age=300')
  async proof(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: ProofQuery, @Res() res: Response) {
    const p = await this.svc.proof(ctx, id, q.kind ?? 'DELIVERY', false);
    res.setHeader('Content-Type', p.contentType); res.setHeader('Content-Security-Policy', "default-src 'none'"); res.send(p.content);
  }

  // ── motorista ──
  @Get('my/routes') @RequirePermissions('delivery.perform')
  myRoutes(@CurrentAuth() ctx: AuthContext) { return this.svc.myRoutes(ctx); }
  @Get('my/routes/:id') @RequirePermissions('delivery.perform')
  myRoute(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.myRoute(ctx, id); }
  @Post('my/stops/:id/deliver') @HttpCode(200) @RequirePermissions('delivery.perform')
  deliver(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DeliverDto) { return this.svc.deliver(ctx, id, dto); }
  @Post('my/stops/:id/fail') @HttpCode(200) @RequirePermissions('delivery.perform')
  fail(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: FailDto) { return this.svc.fail(ctx, id, dto); }
  @Get('my/stops/:id/proof') @RequirePermissions('delivery.perform') @Header('X-Content-Type-Options', 'nosniff') @Header('Cache-Control', 'private, max-age=300')
  async myProof(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: ProofQuery, @Res() res: Response) {
    const p = await this.svc.proof(ctx, id, q.kind ?? 'DELIVERY', true);
    res.setHeader('Content-Type', p.contentType); res.setHeader('Content-Security-Policy', "default-src 'none'"); res.send(p.content);
  }
}
