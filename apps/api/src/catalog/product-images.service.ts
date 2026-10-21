import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuthContext, CurrentAuth, Public, RequirePermissions } from '../common/auth';
import { getConfig } from '../config/app.config';
import { PrismaService } from '../prisma/prisma.service';
import { readImageInfo, type ImageType } from './image';

export const MAX_IMAGES = 12;
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const TYPES = ['image/png', 'image/jpeg', 'image/webp'];

// ───────────── URL pública assinada (para o marketplace baixar a foto) ─────────────

const key = () => createHmac('sha256', getConfig().jwtSecret).update('media-url-v1').digest();
const sign = (id: string, exp: number) => createHmac('sha256', key()).update(`${id}.${exp}`).digest('base64url');

/** URL temporária e sem login para UMA foto. Vale até `ttlSeconds` (padrão 24 h, máximo 7 dias). */
export function signedMediaUrl(imageId: string, ttlSeconds = 86_400): string {
  const exp = Math.floor(Date.now() / 1000) + Math.min(Math.max(ttlSeconds, 60), 7 * 86_400);
  return `${getConfig().webOrigin.replace(/\/$/, '')}/api/media/${imageId}?e=${exp}&s=${sign(imageId, exp)}`;
}
export function verifyMediaSignature(id: string, exp: number, sig: string): boolean {
  if (!Number.isInteger(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(id, exp));
  return a.length === b.length && timingSafeEqual(a, b);
}

class AddImageDto {
  @IsIn(TYPES) contentType: string;
  @IsString() @MaxLength(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8) contentBase64: string;
  @IsOptional() @IsString() @MaxLength(150) alt?: string;
}
class OrderDto { @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_IMAGES) @IsUUID('all', { each: true }) ids: string[]; }
class AltDto { @IsOptional() @IsString() @MaxLength(150) alt?: string | null; }
class MediaQuery { @Type(() => Number) @IsInt() @Min(1) e: number; @IsString() @MaxLength(100) s: string; }

@Injectable()
export class ProductImagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Valida o arquivo de verdade (bytes, não só o tipo declarado). Compartilhado com a importação do canal. */
  static validate(buf: Buffer, declaredType?: string) {
    if (buf.length < 100) throw new BadRequestException('Arquivo muito pequeno para ser uma imagem.');
    if (buf.length > MAX_IMAGE_BYTES) throw new BadRequestException('A imagem excede 3 MB. Reduza o tamanho e tente de novo.');
    const info = readImageInfo(buf);
    if (!info) throw new BadRequestException('Formato não reconhecido. Use PNG, JPG ou WebP (SVG não é aceito).');
    if (declaredType && info.type !== declaredType) throw new BadRequestException('O conteúdo do arquivo não corresponde ao tipo informado.');
    if (info.width < 1 || info.height < 1 || info.width > 8000 || info.height > 8000) throw new BadRequestException('Dimensões inválidas (máximo 8000 px por lado).');
    return info as { type: ImageType; width: number; height: number };
  }

  list(ctx: AuthContext, productId: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      await this.mustOwn(tx, ctx, productId);
      const rows = await tx.productImage.findMany({ where: { tenantId: ctx.tenantId!, productId }, orderBy: { position: 'asc' }, select: { id: true, position: true, contentType: true, width: true, height: true, bytes: true, alt: true, sourceUrl: true } });
      return rows.map((r) => ({ ...r, main: r.position === 0 }));
    });
  }

  private async mustOwn(tx: Parameters<Parameters<PrismaService['withContext']>[1]>[0], ctx: AuthContext, productId: string) {
    if (!(await tx.product.findFirst({ where: { id: productId, tenantId: ctx.tenantId! }, select: { id: true } }))) throw new NotFoundException('Produto não encontrado.');
  }

  /** Acrescenta ao final (a primeira foto vira a principal). Trava o produto para que dois envios simultâneos não estourem o limite. */
  async add(ctx: AuthContext, productId: string, input: { contentType?: string; buffer: Buffer; alt?: string; sourceUrl?: string }) {
    const info = ProductImagesService.validate(input.buffer, input.contentType);
    return this.prisma.withContext(ctx, async (tx) => {
      await this.mustOwn(tx, ctx, productId);
      await tx.$queryRaw`SELECT id FROM products WHERE id = ${productId}::uuid AND tenant_id = ${ctx.tenantId}::uuid FOR UPDATE`;
      const n = await tx.productImage.count({ where: { tenantId: ctx.tenantId!, productId } });
      if (n >= MAX_IMAGES) throw new ConflictException(`Limite de ${MAX_IMAGES} fotos por produto atingido.`);
      const row = await tx.productImage.create({
        data: { tenantId: ctx.tenantId!, productId, position: n, contentType: info.type, content: new Uint8Array(input.buffer), width: info.width, height: info.height, bytes: input.buffer.length, alt: input.alt?.trim() || null, sourceUrl: input.sourceUrl ?? null },
        select: { id: true, position: true },
      });
      await this.audit.record(tx, ctx, { action: 'product.image_added', entity: 'product', entityId: productId, metadata: { imageId: row.id, bytes: input.buffer.length, width: info.width, height: info.height } });
      return { id: row.id, position: row.position, width: info.width, height: info.height };
    });
  }

  /** Define a ordem completa (a primeira é a principal). Exige exatamente as fotos do produto. */
  reorder(ctx: AuthContext, productId: string, ids: string[]) {
    return this.prisma.withContext(ctx, async (tx) => {
      await this.mustOwn(tx, ctx, productId);
      await tx.$queryRaw`SELECT id FROM products WHERE id = ${productId}::uuid AND tenant_id = ${ctx.tenantId}::uuid FOR UPDATE`;
      const current = await tx.productImage.findMany({ where: { tenantId: ctx.tenantId!, productId }, select: { id: true } });
      if (new Set(ids).size !== ids.length || ids.length !== current.length || !current.every((c) => ids.includes(c.id))) throw new BadRequestException('A lista deve conter exatamente as fotos do produto, sem repetir.');
      for (const [i, id] of ids.entries()) await tx.productImage.update({ where: { id }, data: { position: i } });
      await this.audit.record(tx, ctx, { action: 'product.images_reordered', entity: 'product', entityId: productId, metadata: { main: ids[0] } });
      return { ok: true };
    });
  }

  setAlt(ctx: AuthContext, productId: string, imageId: string, alt?: string | null) {
    return this.prisma.withContext(ctx, async (tx) => {
      const r = await tx.productImage.updateMany({ where: { id: imageId, productId, tenantId: ctx.tenantId! }, data: { alt: alt?.trim() || null } });
      if (!r.count) throw new NotFoundException('Foto não encontrada.');
      return { ok: true };
    });
  }

  remove(ctx: AuthContext, productId: string, imageId: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      await tx.$queryRaw`SELECT id FROM products WHERE id = ${productId}::uuid AND tenant_id = ${ctx.tenantId}::uuid FOR UPDATE`;
      const r = await tx.productImage.deleteMany({ where: { id: imageId, productId, tenantId: ctx.tenantId! } });
      if (!r.count) throw new NotFoundException('Foto não encontrada.');
      const rest = await tx.productImage.findMany({ where: { tenantId: ctx.tenantId!, productId }, orderBy: { position: 'asc' }, select: { id: true } });
      for (const [i, x] of rest.entries()) await tx.productImage.update({ where: { id: x.id }, data: { position: i } }); // fecha o buraco: a próxima vira principal
      await this.audit.record(tx, ctx, { action: 'product.image_removed', entity: 'product', entityId: productId, metadata: { imageId } });
      return { ok: true };
    });
  }

  async file(ctx: AuthContext, productId: string, imageId: string) {
    const r = await this.prisma.withContext(ctx, (tx) => tx.productImage.findFirst({ where: { id: imageId, productId, tenantId: ctx.tenantId! }, select: { content: true, contentType: true } }));
    if (!r) throw new NotFoundException('Foto não encontrada.');
    return { content: Buffer.from(r.content), contentType: r.contentType };
  }

  /** Para a publicação: URLs temporárias de todas as fotos, na ordem. */
  async publicUrls(ctx: Pick<AuthContext, 'tenantId' | 'userId'>, productId: string, ttlSeconds?: number): Promise<{ id: string; url: string; width: number; height: number }[]> {
    const rows = await this.prisma.withContext(ctx, (tx) => tx.productImage.findMany({ where: { tenantId: ctx.tenantId!, productId }, orderBy: { position: 'asc' }, select: { id: true, width: true, height: true } }));
    return rows.map((r) => ({ id: r.id, url: signedMediaUrl(r.id, ttlSeconds), width: r.width, height: r.height }));
  }

  /** Leitura pública (sem tenant) de uma foto; só chamada depois de validar a assinatura. */
  async publicFile(id: string) {
    const rows = await this.prisma.$queryRaw<{ content_type: string; content: Buffer }[]>`SELECT * FROM media_image(${id}::uuid)`;
    if (!rows.length) throw new NotFoundException();
    return { content: Buffer.from(rows[0].content), contentType: rows[0].content_type };
  }
}

@Controller()
export class ProductImagesController {
  constructor(private readonly svc: ProductImagesService) {}

  @Get('products/:id/images') @RequirePermissions('products.view')
  list(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.list(ctx, id); }

  @Post('products/:id/images') @RequirePermissions('products.manage')
  add(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddImageDto) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(dto.contentBase64)) throw new BadRequestException('Arquivo inválido.');
    return this.svc.add(ctx, id, { contentType: dto.contentType, buffer: Buffer.from(dto.contentBase64, 'base64'), alt: dto.alt });
  }

  @Put('products/:id/images/order') @RequirePermissions('products.manage')
  reorder(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: OrderDto) { return this.svc.reorder(ctx, id, dto.ids); }

  @Patch('products/:id/images/:imageId') @RequirePermissions('products.manage')
  alt(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('imageId', ParseUUIDPipe) imageId: string, @Body() dto: AltDto) { return this.svc.setAlt(ctx, id, imageId, dto.alt); }

  @Delete('products/:id/images/:imageId') @RequirePermissions('products.manage')
  remove(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('imageId', ParseUUIDPipe) imageId: string) { return this.svc.remove(ctx, id, imageId); }

  @Get('products/:id/images/:imageId/file') @RequirePermissions('products.view')
  async file(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('imageId', ParseUUIDPipe) imageId: string, @Res() res: Response) {
    const f = await this.svc.file(ctx, id, imageId);
    send(res, f, 'private, max-age=300');
  }
}

/** Entrega pública temporária (o marketplace baixa a foto). Sem assinatura válida e não expirada: 404, sem dizer o motivo. */
@Controller('media')
export class MediaController {
  constructor(private readonly svc: ProductImagesService) {}

  @Public() @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string, @Query() q: MediaQuery, @Res() res: Response) {
    if (!verifyMediaSignature(id, q.e, q.s)) throw new NotFoundException();
    send(res, await this.svc.publicFile(id), 'public, max-age=3600');
  }
}

function send(res: Response, f: { content: Buffer; contentType: string }, cache: string) {
  res.setHeader('Content-Type', f.contentType);
  res.setHeader('Cache-Control', cache);
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(f.content);
}
