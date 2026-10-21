import { BadRequestException, Body, Controller, Delete, Get, Injectable, NotFoundException, Put, Res } from '@nestjs/common';
import { IsIn, IsString, MaxLength } from 'class-validator';
import type { Response } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/auth';
import { PrismaService } from '../prisma/prisma.service';

export const MAX_LOGO_BYTES = 1_048_576;
const TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** Confere os primeiros bytes: o tipo declarado precisa ser o real (nada de SVG/HTML renomeado). Retorna dimensões quando é PNG. */
export function sniffImage(buf: Buffer): { type: (typeof TYPES)[number]; width?: number; height?: number } | null {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { type: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { type: 'image/jpeg' };
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { type: 'image/webp' };
  return null;
}

class LogoDto {
  @IsIn(TYPES as unknown as string[]) contentType: string;
  /** Imagem em base64 (sem o prefixo data:). */
  @IsString() @MaxLength(Math.ceil((MAX_LOGO_BYTES * 4) / 3) + 8) contentBase64: string;
}

@Injectable()
export class BrandingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(ctx: AuthContext) {
    const row = await this.prisma.withContext(ctx, (tx) => tx.tenantBranding.findUnique({ where: { tenantId: ctx.tenantId! } }));
    if (!row) throw new NotFoundException('Nenhum logotipo cadastrado.');
    return { content: Buffer.from(row.logo), contentType: row.contentType, version: row.updatedAt.getTime() };
  }

  async put(ctx: AuthContext, dto: LogoDto) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(dto.contentBase64)) throw new BadRequestException('Arquivo inválido.');
    const buf = Buffer.from(dto.contentBase64, 'base64');
    if (buf.length < 100) throw new BadRequestException('Arquivo muito pequeno para ser uma imagem.');
    if (buf.length > MAX_LOGO_BYTES) throw new BadRequestException('A imagem excede 1 MB. Reduza o tamanho e tente de novo.');
    const real = sniffImage(buf);
    if (!real) throw new BadRequestException('Formato não reconhecido. Use PNG, JPG ou WebP (SVG não é aceito).');
    if (real.type !== dto.contentType) throw new BadRequestException('O conteúdo do arquivo não corresponde ao tipo informado.');
    if (real.width && real.height && (real.width > 4000 || real.height > 4000)) throw new BadRequestException('Dimensões acima de 4000 px. Reduza a imagem.');
    return this.prisma.withContext(ctx, async (tx) => {
      const row = await tx.tenantBranding.upsert({
        where: { tenantId: ctx.tenantId! },
        create: { tenantId: ctx.tenantId!, logo: new Uint8Array(buf), contentType: real.type, updatedById: ctx.userId },
        update: { logo: new Uint8Array(buf), contentType: real.type, updatedById: ctx.userId },
      });
      await this.audit.record(tx, ctx, { action: 'branding.logo_updated', entity: 'tenant', entityId: ctx.tenantId!, metadata: { bytes: buf.length, type: real.type } });
      return { version: row.updatedAt.getTime() };
    });
  }

  async remove(ctx: AuthContext) {
    return this.prisma.withContext(ctx, async (tx) => {
      const n = await tx.tenantBranding.deleteMany({ where: { tenantId: ctx.tenantId! } });
      if (n.count === 0) throw new NotFoundException('Nenhum logotipo cadastrado.');
      await this.audit.record(tx, ctx, { action: 'branding.logo_removed', entity: 'tenant', entityId: ctx.tenantId! });
      return { removed: true };
    });
  }
}

@Controller('branding')
export class BrandingController {
  constructor(private readonly svc: BrandingService) {}

  /** Qualquer membro com acesso à empresa vê o logotipo (ele aparece no menu). Resposta é só a imagem, sem execução de conteúdo. */
  @Get('logo') @RequirePermissions('company.view')
  async logo(@CurrentAuth() ctx: AuthContext, @Res() res: Response) {
    const l = await this.svc.get(ctx);
    res.setHeader('Content-Type', l.contentType);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('ETag', `"${l.version}"`);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(l.content);
  }

  @Put('logo') @RequirePermissions('company.manage')
  put(@CurrentAuth() ctx: AuthContext, @Body() dto: LogoDto) { return this.svc.put(ctx, dto); }

  @Delete('logo') @RequirePermissions('company.manage')
  remove(@CurrentAuth() ctx: AuthContext) { return this.svc.remove(ctx); }
}
