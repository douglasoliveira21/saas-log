import { Controller, Get, Injectable, NotFoundException, Param, ParseUUIDPipe } from '@nestjs/common';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/auth';
import { isValidGtin } from '../fiscal/chave';
import { PrismaService } from '../prisma/prisma.service';

export interface QualityItem { key: string; label: string; ok: boolean; level: 'required' | 'recommended'; hint: string }

interface ProductLike {
  name: string; title: string | null; brand: string | null; model: string | null; barcode: string | null; description: string | null; categoryId: string | null;
  suggestedPrice: unknown; grossWeightG: number | null; netWeightG: number | null; heightMm: number | null; widthMm: number | null; lengthMm: number | null; attributes: unknown;
}

const plain = (s: string | null | undefined) => (s ?? '').trim();

/**
 * Checklist de "cadastro pronto para anunciar". São exigências COMUNS aos grandes marketplaces (título limitado, foto mínima,
 * GTIN, marca, medidas para frete…). Cada canal pode exigir mais (categoria e atributos obrigatórios variam): o que falta de
 * específico aparece na pré-visualização do anúncio de cada conexão.
 */
export function evaluateQuality(p: ProductLike, images: { width: number; height: number }[]): { score: number; ready: boolean; items: QualityItem[] } {
  const title = plain(p.title) || plain(p.name);
  const attrs = Array.isArray(p.attributes) ? (p.attributes as { name?: string; value?: string }[]).filter((a) => plain(a.name) && plain(a.value)) : [];
  const main = images[0];
  const weight = p.grossWeightG ?? p.netWeightG;
  const dims = !!(p.heightMm && p.widthMm && p.lengthMm);
  const items: QualityItem[] = [
    { key: 'title', label: 'Título de 10 a 60 caracteres', ok: title.length >= 10 && title.length <= 60, level: 'required', hint: title.length > 60 ? `O título tem ${title.length} caracteres; marketplaces como o Mercado Livre aceitam até 60.` : 'Use marca + produto + característica principal (ex.: "Parafuso Sextavado M8 x 40 Aço Zincado").' },
    { key: 'photo', label: 'Ao menos 1 foto', ok: images.length >= 1, level: 'required', hint: 'Sem foto o anúncio não é aceito.' },
    { key: 'photo_size', label: 'Foto principal com 500 × 500 px ou mais', ok: !!main && main.width >= 500 && main.height >= 500, level: 'required', hint: main ? `A principal tem ${main.width} × ${main.height} px; prefira 1000 px ou mais, fundo branco.` : 'Envie a foto principal.' },
    { key: 'photos_more', label: '3 ou mais fotos (ângulos diferentes)', ok: images.length >= 3, level: 'recommended', hint: 'Mais fotos aumentam a conversão e são exigidas por alguns canais.' },
    { key: 'brand', label: 'Marca informada', ok: !!plain(p.brand), level: 'required', hint: 'A marca é atributo obrigatório na maioria das categorias.' },
    { key: 'gtin', label: 'Código de barras (GTIN/EAN) válido', ok: !!p.barcode && isValidGtin(p.barcode), level: 'recommended', hint: p.barcode ? 'O dígito verificador não confere: revise o código.' : 'Marketplaces pedem o GTIN do produto; sem ele o anúncio pode perder visibilidade.' },
    { key: 'model', label: 'Modelo informado', ok: !!plain(p.model), level: 'recommended', hint: 'Ajuda na busca e é atributo comum em categorias técnicas.' },
    { key: 'description', label: 'Descrição com 100 caracteres ou mais', ok: plain(p.description).length >= 100, level: 'recommended', hint: 'Descreva uso, medidas, conteúdo da embalagem e diferenciais, em texto simples.' },
    { key: 'attributes', label: 'Ficha técnica com 3 ou mais atributos', ok: attrs.length >= 3, level: 'recommended', hint: 'Cor, material, voltagem, tamanho… Os canais usam isso nos filtros de busca.' },
    { key: 'category', label: 'Categoria interna definida', ok: !!p.categoryId, level: 'required', hint: 'A categoria interna é ligada à categoria do canal (Marketplaces → Categorias).' },
    { key: 'price', label: 'Preço de venda definido', ok: Number(p.suggestedPrice) > 0, level: 'required', hint: 'O preço aprovado por canal é definido em Preços e margens.' },
    { key: 'shipping', label: 'Peso e medidas da embalagem', ok: !!weight && dims, level: 'required', hint: 'Necessários para calcular o frete (peso em gramas; altura, largura e comprimento em mm).' },
  ];
  const w = (i: QualityItem) => (i.level === 'required' ? 2 : 1);
  const total = items.reduce((s, i) => s + w(i), 0);
  const got = items.filter((i) => i.ok).reduce((s, i) => s + w(i), 0);
  return { score: Math.round((got / total) * 100), ready: items.filter((i) => i.level === 'required').every((i) => i.ok), items };
}

@Injectable()
export class ProductQualityService {
  constructor(private readonly prisma: PrismaService) {}

  async get(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const p = await tx.product.findFirst({ where: { id, tenantId: ctx.tenantId! } });
      if (!p) throw new NotFoundException('Produto não encontrado.');
      const images = await tx.productImage.findMany({ where: { tenantId: ctx.tenantId!, productId: id }, orderBy: { position: 'asc' }, select: { width: true, height: true } });
      return evaluateQuality(p, images);
    });
  }
}

@Controller()
export class ProductQualityController {
  constructor(private readonly svc: ProductQualityService) {}
  @Get('products/:id/quality') @RequirePermissions('products.view')
  quality(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.get(ctx, id); }
}
