import {
  BadRequestException,
  Body,
  Controller,
  ConflictException,
  ForbiddenException,
  Get,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { MembershipStatus } from '@prisma/client';
import { ArrayUnique, IsArray, IsEmail, IsEnum, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';
import { PERMISSIONS, isPermissionCode } from '../access/permissions';
import { AuditService } from '../audit/audit.service';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/auth';
import { hashPassword, validatePasswordPolicy } from '../common/password';
import { PrismaService } from '../prisma/prisma.service';

export class CreateUserDto {
  @IsString() @Length(2, 120) name: string;
  @IsEmail({}, { message: 'E-mail inválido.' }) email: string;
  @IsString() @MaxLength(200) password: string; // senha provisória (convite por e-mail: Fase 8)
  @IsUUID() roleId: string;
}

export class UpdateMemberDto {
  @IsOptional() @IsUUID() roleId?: string;
  @IsOptional() @IsEnum(MembershipStatus) status?: MembershipStatus;
}

export class CreateRoleDto {
  @IsString() @Length(2, 80) name: string;
  @IsArray() @ArrayUnique() @IsString({ each: true }) permissions: string[];
}

export class SetRolePermissionsDto {
  @IsArray() @ArrayUnique() @IsString({ each: true }) permissions: string[];
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listMembers(ctx: AuthContext) {
    const rows = await this.prisma.withContext(ctx, (tx) =>
      tx.membership.findMany({
        where: { tenantId: ctx.tenantId! },
        include: { role: true },
        orderBy: { createdAt: 'asc' },
      }),
    );
    const users = await this.prisma.user.findMany({
      where: { id: { in: rows.map((r) => r.userId) } },
      select: { id: true, name: true, email: true, lastLoginAt: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows.map((m) => ({
      id: m.id,
      status: m.status,
      role: { id: m.role.id, key: m.role.key, name: m.role.name },
      user: byId.get(m.userId),
    }));
  }

  async createMember(ctx: AuthContext, dto: CreateUserDto) {
    const email = dto.email.trim().toLowerCase();
    let existing = await this.prisma.user.findUnique({ where: { email } });
    if (!existing) {
      const policy = validatePasswordPolicy(dto.password);
      if (policy) throw new BadRequestException(policy);
    }
    const passwordHash = existing ? null : await hashPassword(dto.password);

    return this.prisma.withContext(ctx, async (tx) => {
      const role = await this.assignableRole(tx, ctx, dto.roleId);
      await this.enforceUserLimit(tx, ctx);
      existing ??= await tx.user.create({ data: { email, name: dto.name.trim(), passwordHash: passwordHash! } });
      const already = await tx.membership.findFirst({ where: { tenantId: ctx.tenantId!, userId: existing.id } });
      if (already) throw new ConflictException('Este usuário já faz parte da empresa.');
      const m = await tx.membership.create({ data: { tenantId: ctx.tenantId!, userId: existing.id, roleId: role.id } });
      await this.audit.record(tx, ctx, {
        action: 'user.added',
        entity: 'membership',
        entityId: m.id,
        metadata: { email, role: role.key },
      });
      return { id: m.id, userId: existing.id };
    });
  }

  async updateMember(ctx: AuthContext, id: string, dto: UpdateMemberDto) {
    return this.prisma.withContext(ctx, async (tx) => {
      const m = await tx.membership.findFirst({ where: { id, tenantId: ctx.tenantId! }, include: { role: true } });
      if (!m) throw new NotFoundException('Usuário não encontrado.');
      // Impede deixar a empresa sem proprietário ativo.
      const losesOwner =
        m.role.key === 'owner' &&
        m.status === 'ACTIVE' &&
        ((dto.roleId && dto.roleId !== m.roleId) || (dto.status && dto.status !== 'ACTIVE'));
      if (losesOwner) {
        const owners = await tx.membership.count({
          where: { tenantId: ctx.tenantId!, status: 'ACTIVE', role: { key: 'owner' } },
        });
        if (owners <= 1) throw new BadRequestException('A empresa precisa ter ao menos um proprietário ativo.');
      }
      if (dto.roleId) await this.assignableRole(tx, ctx, dto.roleId);
      if (m.role.key === 'owner' && ctx.roleKey !== 'owner') {
        throw new ForbiddenException('Somente um proprietário pode alterar outro proprietário.');
      }
      const updated = await tx.membership.update({ where: { id }, data: { roleId: dto.roleId, status: dto.status } });
      await this.audit.record(tx, ctx, {
        action: 'user.updated',
        entity: 'membership',
        entityId: id,
        metadata: { roleId: dto.roleId, status: dto.status },
      });
      return { id: updated.id };
    });
  }

  listRoles(ctx: AuthContext) {
    return this.prisma.withContext(ctx, async (tx) => {
      const roles = await tx.role.findMany({
        where: { tenantId: ctx.tenantId! },
        include: { permissions: { select: { permission: true } } },
        orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      });
      return roles.map((r) => ({
        id: r.id,
        key: r.key,
        name: r.name,
        isSystem: r.isSystem,
        permissions: r.permissions.map((p) => p.permission).sort(),
      }));
    });
  }

  catalog() {
    return Object.entries(PERMISSIONS).map(([code, description]) => ({ code, description }));
  }

  async createRole(ctx: AuthContext, dto: CreateRoleDto) {
    this.assertValidPermissions(ctx, dto.permissions);
    return this.prisma.withContext(ctx, async (tx) => {
      const key = `custom_${Date.now().toString(36)}`;
      const role = await tx.role.create({ data: { tenantId: ctx.tenantId!, key, name: dto.name.trim() } });
      await tx.rolePermission.createMany({
        data: dto.permissions.map((permission) => ({ roleId: role.id, tenantId: ctx.tenantId!, permission })),
      });
      await this.audit.record(tx, ctx, { action: 'role.created', entity: 'role', entityId: role.id, metadata: { permissions: dto.permissions } });
      return { id: role.id, key };
    });
  }

  async setRolePermissions(ctx: AuthContext, id: string, dto: SetRolePermissionsDto) {
    this.assertValidPermissions(ctx, dto.permissions);
    return this.prisma.withContext(ctx, async (tx) => {
      const role = await tx.role.findFirst({ where: { id, tenantId: ctx.tenantId! } });
      if (!role) throw new NotFoundException('Papel não encontrado.');
      if (role.isSystem) throw new ForbiddenException('Papéis de sistema não podem ser alterados.');
      await tx.rolePermission.deleteMany({ where: { roleId: id, tenantId: ctx.tenantId! } });
      await tx.rolePermission.createMany({
        data: dto.permissions.map((permission) => ({ roleId: id, tenantId: ctx.tenantId!, permission })),
      });
      await this.audit.record(tx, ctx, { action: 'role.permissions_changed', entity: 'role', entityId: id, metadata: { permissions: dto.permissions } });
      return { id };
    });
  }

  /** Anti-escalação: só é possível atribuir/conceder o que o próprio ator já possui. */
  private assertValidPermissions(ctx: AuthContext, perms: string[]) {
    for (const p of perms) {
      if (!isPermissionCode(p)) throw new BadRequestException(`Permissão desconhecida: ${p}`);
      if (!ctx.permissions.has(p)) throw new ForbiddenException('Você não pode conceder permissões que não possui.');
    }
  }

  async assignableRole(tx: Parameters<Parameters<PrismaService['withContext']>[1]>[0], ctx: AuthContext, roleId: string) {
    const role = await tx.role.findFirst({
      where: { id: roleId, tenantId: ctx.tenantId! },
      include: { permissions: true },
    });
    if (!role) throw new BadRequestException('Papel inválido.');
    if (role.permissions.some((p) => !ctx.permissions.has(p.permission))) {
      throw new ForbiddenException('Você não pode atribuir um papel com mais permissões que o seu.');
    }
    return role;
  }

  async enforceUserLimit(tx: Parameters<Parameters<PrismaService['withContext']>[1]>[0], ctx: AuthContext) {
    return this.enforceUserLimitFor(tx, ctx.tenantId!);
  }

  async enforceUserLimitFor(tx: Parameters<Parameters<PrismaService['withContext']>[1]>[0], tenantId: string) {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, include: { plan: true } });
    const limit = (tenant.plan?.limits as { users?: number } | undefined)?.users;
    if (limit !== undefined) {
      const n = await tx.membership.count({ where: { tenantId, status: 'ACTIVE' } });
      if (n >= limit) throw new HttpException(`Limite do plano atingido (${limit} usuários).`, HttpStatus.PAYMENT_REQUIRED);
    }
  }
}

@Controller()
export class UsersController {
  constructor(private readonly svc: UsersService) {}

  @Get('users') @RequirePermissions('users.view')
  list(@CurrentAuth() ctx: AuthContext) { return this.svc.listMembers(ctx); }

  @Post('users') @RequirePermissions('users.manage')
  create(@CurrentAuth() ctx: AuthContext, @Body() dto: CreateUserDto) { return this.svc.createMember(ctx, dto); }

  @Patch('users/:id') @RequirePermissions('users.manage')
  update(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateMemberDto) {
    return this.svc.updateMember(ctx, id, dto);
  }

  @Get('roles') @RequirePermissions('users.view')
  roles(@CurrentAuth() ctx: AuthContext) { return this.svc.listRoles(ctx); }

  @Get('permissions') @RequirePermissions('users.view')
  catalog() { return this.svc.catalog(); }

  @Post('roles') @RequirePermissions('roles.manage')
  createRole(@CurrentAuth() ctx: AuthContext, @Body() dto: CreateRoleDto) { return this.svc.createRole(ctx, dto); }

  @Put('roles/:id/permissions') @RequirePermissions('roles.manage')
  setPerms(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetRolePermissionsDto) {
    return this.svc.setRolePermissions(ctx, id, dto);
  }
}
