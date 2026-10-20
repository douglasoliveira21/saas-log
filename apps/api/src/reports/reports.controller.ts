import { Controller, Get, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Response } from 'express';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/auth';
import { ReportsService } from './reports.service';

class FilterQuery {
  @IsOptional() @IsString() @MaxLength(40) from?: string;
  @IsOptional() @IsString() @MaxLength(40) to?: string;
  @IsOptional() @IsString() @MaxLength(40) status?: string;
  @IsOptional() @IsString() @MaxLength(40) granularity?: string;
  @IsOptional() @IsString() @MaxLength(40) accountId?: string;
  @IsOptional() @IsString() @MaxLength(40) warehouseId?: string;
}
class ExportQuery extends FilterQuery { @IsIn(['csv', 'xlsx']) format: 'csv' | 'xlsx'; }

@Controller('reports')
export class ReportsController {
  constructor(private readonly svc: ReportsService) {}

  @Get() @RequirePermissions('reports.view')
  list(@CurrentAuth() ctx: AuthContext) { return this.svc.list(ctx); }

  @Get('exports') @RequirePermissions('reports.export')
  exports(@CurrentAuth() ctx: AuthContext) { return this.svc.exports(ctx); }

  @Get('exports/:id/download') @RequirePermissions('reports.export')
  async download(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    return send(res, await this.svc.download(ctx, id));
  }

  @Get(':key') @RequirePermissions('reports.view')
  preview(@CurrentAuth() ctx: AuthContext, @Param('key') key: string, @Query() q: FilterQuery) { return this.svc.preview(ctx, key, { ...q }); }

  @Post(':key/export') @RequirePermissions('reports.view', 'reports.export')
  async export(@CurrentAuth() ctx: AuthContext, @Param('key') key: string, @Query() q: ExportQuery, @Res() res: Response) {
    const { format, ...filters } = q;
    const out = await this.svc.export(ctx, key, { ...filters }, format);
    if (out.mode === 'async') return res.status(202).json({ exportId: out.exportId, message: 'Relatório grande: será gerado em segundo plano. Baixe em Exportações quando estiver pronto.' });
    return send(res.status(200), out);
  }
}

function send(res: Response, f: { fileName: string; contentType: string; content: Buffer }) {
  res.setHeader('Content-Type', f.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${f.fileName}"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.send(f.content);
}
