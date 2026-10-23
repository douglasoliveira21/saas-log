import { BadRequestException, Body, ConflictException, ForbiddenException, Controller, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { CustomerKind, Prisma } from '@prisma/client';
import { IsBoolean, IsEmail, IsEnum, IsIn, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, Validate } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/auth';
import { onlyDigits } from '../common/cnpj';
import { IsBrPhone } from '../common/phone';
import { normalizeContact } from '../common/phone';
import { CpfCnpjConstraint } from '../catalog/catalog.dto';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { purchaseProfiles } from './purchase-profile';
import { ensureSalesperson } from '../sales/ensure-salesperson';

class CustomerFields {
  @IsOptional() @IsIn(['RETAIL', 'WHOLESALE']) priceTable?: 'RETAIL' | 'WHOLESALE';
  /** Carteira: vendedor responsável. Só quem enxerga todas as vendas pode escolher outro vendedor. */
  @IsOptional() @IsUUID() salespersonId?: string;
  @IsOptional() @IsString() @MaxLength(30) stateRegistration?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsBrPhone() @MaxLength(30) phone?: string;
  @IsOptional() @Matches(/^\d{5}-?\d{3}$/, { message: 'CEP inválido.' }) zipCode?: string;
  @IsOptional() @IsString() @MaxLength(200) street?: string;
  @IsOptional() @IsString() @MaxLength(20) number?: string;
  @IsOptional() @IsString() @MaxLength(100) district?: string;
  @IsOptional() @IsString() @MaxLength(100) city?: string;
  @IsOptional() @Matches(/^[A-Za-z]{2}$/, { message: 'UF inválida.' }) state?: string;
}
export class CreateCustomerDto extends CustomerFields {
  @IsEnum(CustomerKind) kind: CustomerKind;
  @IsString() @Length(2, 200) name: string;
  @IsOptional() @Validate(CpfCnpjConstraint) document?: string;
}
export class UpdateCustomerDto extends CustomerFields {
  @IsOptional() @IsString() @Length(2, 200) name?: string;
  @IsOptional() @Validate(CpfCnpjConstraint) document?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  list(ctx: AuthContext, search?: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const rows = await tx.customer.findMany({
        where: { tenantId: ctx.tenantId!, ...(search ? { OR: [{ name: { contains: search, mode: 'insensitive' } }, { document: { contains: onlyDigits(search) || '∅' } }] } : {}) },
        orderBy: { name: 'asc' }, take: 200,
      });
      const days = (await this.settings.load(tx, ctx))['customers.inactiveAfterDays'];
      const profiles = await purchaseProfiles(tx, ctx.tenantId!, rows.map((r) => r.id), days);
      return rows.map((r) => ({ ...r, purchase: profiles.get(r.id)! }));
    });
  }

  /** Perfil de compra: primeira compra, ativo ou inativo (se comprar agora, "voltou"). */
  async profile(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      if (!(await tx.customer.findFirst({ where: { id, tenantId: ctx.tenantId! }, select: { id: true } }))) throw new NotFoundException('Cliente não encontrado.');
      const days = (await this.settings.load(tx, ctx))['customers.inactiveAfterDays'];
      return (await purchaseProfiles(tx, ctx.tenantId!, [id], days)).get(id)!;
    });
  }

  /** Carteira de um cliente novo/alterado: vendedor de quem cadastra (se for vendedor) ou o escolhido por quem enxerga todas as vendas. */
  private async portfolioOwner(tx: Prisma.TransactionClient, ctx: AuthContext, wanted: string | undefined, current?: string | null): Promise<string | null | undefined> {
    const all = ctx.permissions.has('sales.view_all');
    if (wanted !== undefined) {
      if (!all) throw new ForbiddenException('Somente quem enxerga todas as vendas pode escolher o vendedor da carteira.');
      if (!(await tx.salesperson.findFirst({ where: { id: wanted, tenantId: ctx.tenantId!, active: true } }))) throw new BadRequestException('Vendedor inválido ou inativo.');
      return wanted;
    }
    if (current !== undefined) return undefined; // edição sem mexer na carteira
    if (all) return null; // quem enxerga todas as vendas cadastra sem dono, a menos que escolha um vendedor
    const mine = await ensureSalesperson(tx, ctx, this.audit);
    return mine?.id ?? null; // cliente novo cadastrado por um vendedor entra na carteira dele
  }

  create(ctx: AuthContext, dto: CreateCustomerDto) {
    return this.prisma.withContext(ctx, async (tx) => {
      const salespersonId = await this.portfolioOwner(tx, ctx, dto.salespersonId);
      const row = await tx.customer
        .create({ data: { ...normalizeContact(dto), salespersonId, document: dto.document ? onlyDigits(dto.document) : undefined, state: dto.state?.toUpperCase(), tenantId: ctx.tenantId! } })
        .catch(dup);
      await this.audit.record(tx, ctx, { action: 'customer.created', entity: 'customer', entityId: row.id, metadata: { name: row.name, kind: row.kind } });
      return row;
    });
  }

  update(ctx: AuthContext, id: string, dto: UpdateCustomerDto) {
    return this.prisma.withContext(ctx, async (tx) => {
      const cur = await tx.customer.findFirst({ where: { id, tenantId: ctx.tenantId! } });
      if (!cur) throw new NotFoundException('Cliente não encontrado.');
      const salespersonId = await this.portfolioOwner(tx, ctx, dto.salespersonId, cur.salespersonId);
      const row = await tx.customer.update({ where: { id }, data: { ...normalizeContact(dto), ...(salespersonId !== undefined ? { salespersonId } : {}), document: dto.document ? onlyDigits(dto.document) : undefined, state: dto.state?.toUpperCase() } }).catch(dup);
      await this.audit.record(tx, ctx, { action: 'customer.updated', entity: 'customer', entityId: id, metadata: { fields: Object.keys(dto) } });
      return row;
    });
  }
}

function dup(e: unknown): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('Já existe um cliente com este documento.');
  throw e;
}

@Controller('customers')
export class CustomersController {
  constructor(private readonly svc: CustomersService) {}

  @Get() @RequirePermissions('customers.view')
  list(@CurrentAuth() ctx: AuthContext, @Query('search') search?: string) { return this.svc.list(ctx, search); }

  @Get(':id/purchase-profile') @RequirePermissions('customers.view')
  profile(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.profile(ctx, id); }

  @Post() @RequirePermissions('customers.manage')
  create(@CurrentAuth() ctx: AuthContext, @Body() dto: CreateCustomerDto) { return this.svc.create(ctx, dto); }

  @Patch(':id') @RequirePermissions('customers.manage')
  update(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCustomerDto) { return this.svc.update(ctx, id, dto); }
}
