import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/auth';
import {
  CreateCategoryDto, CreateProductDto, CreateSupplierDto, ImportDto, LinkSupplierDto, ProductQuery, UpdateProductDto, UpdateSupplierDto,
} from './catalog.dto';
import { CatalogService } from './catalog.service';

@Controller()
export class CatalogController {
  constructor(private readonly svc: CatalogService) {}

  @Get('categories') @RequirePermissions('products.view')
  categories(@CurrentAuth() ctx: AuthContext) { return this.svc.listCategories(ctx); }

  @Post('categories') @RequirePermissions('products.manage')
  createCategory(@CurrentAuth() ctx: AuthContext, @Body() dto: CreateCategoryDto) { return this.svc.createCategory(ctx, dto); }

  @Get('products') @RequirePermissions('products.view')
  products(@CurrentAuth() ctx: AuthContext, @Query() q: ProductQuery) { return this.svc.listProducts(ctx, q); }

  @Post('products/import') @HttpCode(200) @RequirePermissions('products.manage')
  importCsv(@CurrentAuth() ctx: AuthContext, @Body() dto: ImportDto) { return this.svc.importCsv(ctx, dto); }

  @Get('products/:id') @RequirePermissions('products.view')
  product(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.getProduct(ctx, id); }

  @Post('products') @RequirePermissions('products.manage')
  createProduct(@CurrentAuth() ctx: AuthContext, @Body() dto: CreateProductDto) { return this.svc.createProduct(ctx, dto); }

  @Patch('products/:id') @RequirePermissions('products.manage')
  updateProduct(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProductDto) { return this.svc.updateProduct(ctx, id, dto); }

  @Post('products/:id/suppliers') @HttpCode(200) @RequirePermissions('products.manage')
  link(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: LinkSupplierDto) { return this.svc.linkSupplier(ctx, id, dto); }

  @Delete('products/:id/suppliers/:supplierId') @RequirePermissions('products.manage')
  unlink(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('supplierId', ParseUUIDPipe) sid: string) { return this.svc.unlinkSupplier(ctx, id, sid); }

  @Get('suppliers') @RequirePermissions('suppliers.view')
  suppliers(@CurrentAuth() ctx: AuthContext, @Query('search') search?: string) { return this.svc.listSuppliers(ctx, search); }

  @Post('suppliers') @RequirePermissions('suppliers.manage')
  createSupplier(@CurrentAuth() ctx: AuthContext, @Body() dto: CreateSupplierDto) { return this.svc.createSupplier(ctx, dto); }

  @Patch('suppliers/:id') @RequirePermissions('suppliers.manage')
  updateSupplier(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSupplierDto) { return this.svc.updateSupplier(ctx, id, dto); }
}
