import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/auth';
import {
  CreateCompanyDto,
  CreateEstablishmentDto,
  CreateWarehouseDto,
  UpdateCompanyDto,
  UpdateEstablishmentDto,
  UpdateWarehouseDto,
} from './structure.dto';
import { StructureService } from './structure.service';

@Controller()
export class StructureController {
  constructor(private readonly svc: StructureService) {}

  @Get('structure') @RequirePermissions('company.view')
  tree(@CurrentAuth() ctx: AuthContext) { return this.svc.tree(ctx); }

  @Get('dashboard/overview')
  overview(@CurrentAuth() ctx: AuthContext) { return this.svc.overview(ctx); }

  @Post('companies') @RequirePermissions('company.manage')
  createCompany(@CurrentAuth() ctx: AuthContext, @Body() dto: CreateCompanyDto) { return this.svc.createCompany(ctx, dto); }

  @Patch('companies/:id') @RequirePermissions('company.manage')
  updateCompany(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCompanyDto) {
    return this.svc.updateCompany(ctx, id, dto);
  }

  @Delete('companies/:id') @RequirePermissions('company.manage')
  deleteCompany(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.deleteCompany(ctx, id); }

  @Delete('establishments/:id') @RequirePermissions('company.manage')
  deleteEstablishment(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.deleteEstablishment(ctx, id); }

  @Delete('warehouses/:id') @RequirePermissions('warehouse.manage')
  deleteWarehouse(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.deleteWarehouse(ctx, id); }

  @Post('establishments') @RequirePermissions('company.manage')
  createEstablishment(@CurrentAuth() ctx: AuthContext, @Body() dto: CreateEstablishmentDto) { return this.svc.createEstablishment(ctx, dto); }

  @Patch('establishments/:id') @RequirePermissions('company.manage')
  updateEstablishment(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateEstablishmentDto) {
    return this.svc.updateEstablishment(ctx, id, dto);
  }

  @Post('warehouses') @RequirePermissions('warehouse.manage')
  createWarehouse(@CurrentAuth() ctx: AuthContext, @Body() dto: CreateWarehouseDto) { return this.svc.createWarehouse(ctx, dto); }

  @Patch('warehouses/:id') @RequirePermissions('warehouse.manage')
  updateWarehouse(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateWarehouseDto) {
    return this.svc.updateWarehouse(ctx, id, dto);
  }
}
