import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsString, IsUUID, Length } from 'class-validator';
import { AcceptInviteDto } from '../auth/auth.dto';
import { AuditService } from '../audit/audit.service';
import { AuthContext, CurrentAuth, Public, RequirePermissions } from '../common/auth';
import { getConfig } from '../config/app.config';
import { hashPassword, newOpaqueToken, sha256, validatePasswordPolicy, verifyPassword } from '../common/password';
import { actionMail, Mailer } from '../notify/mailer';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from './users.service';

const INVITE_TTL_MS = 7 * 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class InviteDto {
  @IsString() @Length(2, 120) name: string;
  @IsEmail({}, { message: 'E-mail inválido.' }) email: string;
  @IsUUID() roleId: string;
}

/** Convite de usuário por e-mail: o convidado define a própria senha; o link vale 7 dias e uma única vez. */
@Injectable()
export class InvitesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly users: UsersService, private readonly mailer: Mailer) {}

  list(ctx: AuthContext) {
    return this.prisma.withContext(ctx, async (tx) => {
      const rows = await tx.userInvite.findMany({ where: { tenantId: ctx.tenantId!, acceptedAt: null, revokedAt: null }, orderBy: { createdAt: 'desc' }, take: 100 });
      const roles = new Map((await tx.role.findMany({ where: { tenantId: ctx.tenantId! }, select: { id: true, name: true } })).map((r) => [r.id, r.name]));
      return rows.map((i) => ({ id: i.id, name: i.name, email: i.email, role: roles.get(i.roleId) ?? '—', expiresAt: i.expiresAt, expired: i.expiresAt < new Date(), createdAt: i.createdAt }));
    });
  }

  async create(ctx: AuthContext, dto: InviteDto) {
    const email = dto.email.trim().toLowerCase();
    const token = `${ctx.tenantId}.${newOpaqueToken()}`;
    const info = await this.prisma.withContext(ctx, async (tx) => {
      const role = await this.users.assignableRole(tx, ctx, dto.roleId);
      await this.users.enforceUserLimit(tx, ctx);
      const user = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
      if (user && (await tx.membership.findFirst({ where: { tenantId: ctx.tenantId!, userId: user.id } }))) throw new ConflictException('Este usuário já faz parte da empresa.');
      await tx.userInvite.updateMany({ where: { tenantId: ctx.tenantId!, email, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } }); // só um convite aberto por e-mail
      const inv = await tx.userInvite.create({ data: { tenantId: ctx.tenantId!, email, name: dto.name.trim(), roleId: role.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS), invitedById: ctx.userId } });
      const t = await tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId! }, select: { name: true } });
      await this.audit.record(tx, ctx, { action: 'user.invited', entity: 'user_invite', entityId: inv.id, metadata: { email, role: role.key } });
      return { id: inv.id, company: t.name, role: role.name };
    });
    const url = this.mailer.link(`/convite?token=${encodeURIComponent(token)}`);
    const app = getConfig().appName;
    const m = actionMail(app, `Olá, ${dto.name.trim()}.`, [`Você foi convidado(a) para usar o ${app} na empresa ${info.company}, com o papel “${info.role}”.`, 'O convite vale por 7 dias. Ao aceitar, você escolhe a sua senha.'], { label: 'Aceitar convite', url });
    const r = await this.mailer.send({ to: email, subject: `Convite para ${info.company} no ${app}`, ...m });
    // Se o e-mail falhar, o administrador recebe o link para repassar por outro meio.
    return r.ok ? { id: info.id, emailSent: true as const } : { id: info.id, emailSent: false as const, reason: r.reason, link: url };
  }

  revoke(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const r = await tx.userInvite.updateMany({ where: { id, tenantId: ctx.tenantId!, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
      if (r.count !== 1) throw new NotFoundException('Convite não encontrado ou já utilizado.');
      await this.audit.record(tx, ctx, { action: 'user.invite_revoked', entity: 'user_invite', entityId: id });
      return { ok: true };
    });
  }

  private tenantOf(token: string): string {
    const tid = token.split('.')[0];
    if (!UUID.test(tid)) throw new BadRequestException('Convite inválido ou expirado.');
    return tid;
  }

  async preview(token: string) {
    const tenantId = this.tenantOf(token);
    return this.prisma.withContext({ tenantId }, async (tx) => {
      const inv = await tx.userInvite.findUnique({ where: { tokenHash: sha256(token) } });
      if (!inv || inv.tenantId !== tenantId || inv.acceptedAt || inv.revokedAt || inv.expiresAt < new Date()) throw new BadRequestException('Convite inválido ou expirado. Peça um novo ao administrador.');
      const t = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } });
      const existing = await this.prisma.user.findUnique({ where: { email: inv.email }, select: { id: true } });
      return { email: inv.email, name: inv.name, company: t.name, existingUser: !!existing };
    });
  }

  async accept(dto: AcceptInviteDto) {
    const tenantId = this.tenantOf(dto.token);
    return this.prisma.withContext({ tenantId }, async (tx) => {
      const bad = () => new BadRequestException('Convite inválido ou expirado. Peça um novo ao administrador.');
      const inv = await tx.userInvite.findUnique({ where: { tokenHash: sha256(dto.token) } });
      if (!inv || inv.tenantId !== tenantId || inv.acceptedAt || inv.revokedAt || inv.expiresAt < new Date()) throw bad();
      const role = await tx.role.findFirst({ where: { id: inv.roleId, tenantId } });
      if (!role) throw new BadRequestException('O papel deste convite não existe mais. Peça um novo convite.');
      const claimed = await tx.userInvite.updateMany({ where: { id: inv.id, acceptedAt: null, revokedAt: null }, data: { acceptedAt: new Date() } });
      if (claimed.count !== 1) throw bad();
      let user = await tx.user.findUnique({ where: { email: inv.email } });
      if (user) {
        if (!(await verifyPassword(dto.password, user.passwordHash))) throw new BadRequestException('Este e-mail já tem conta: digite a senha atual dela para aceitar o convite.');
      } else {
        const policy = validatePasswordPolicy(dto.password);
        if (policy) throw new BadRequestException(policy);
        user = await tx.user.create({ data: { email: inv.email, name: (dto.name?.trim() || inv.name), passwordHash: await hashPassword(dto.password) } });
      }
      if (await tx.membership.findFirst({ where: { tenantId, userId: user.id } })) throw new ConflictException('Você já faz parte desta empresa.');
      await this.users.enforceUserLimitFor(tx, tenantId);
      const m = await tx.membership.create({ data: { tenantId, userId: user.id, roleId: role.id } });
      await this.audit.record(tx, { tenantId, userId: user.id }, { action: 'user.invite_accepted', entity: 'membership', entityId: m.id, metadata: { email: inv.email, role: role.key } });
      return { ok: true };
    });
  }
}

@Controller()
export class InvitesController {
  constructor(private readonly svc: InvitesService) {}

  @Get('users/invites') @RequirePermissions('users.manage')
  list(@CurrentAuth() ctx: AuthContext) { return this.svc.list(ctx); }

  @Post('users/invites') @HttpCode(200) @RequirePermissions('users.manage')
  create(@CurrentAuth() ctx: AuthContext, @Body() dto: InviteDto) { return this.svc.create(ctx, dto); }

  @Delete('users/invites/:id') @RequirePermissions('users.manage')
  revoke(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.revoke(ctx, id); }

  @Public() @Throttle({ default: { limit: 20, ttl: 60_000 } }) @Post('auth/invite/preview') @HttpCode(200)
  preview(@Body() dto: { token: string }) { return this.svc.preview(String(dto?.token ?? '')); }

  @Public() @Throttle({ default: { limit: 10, ttl: 60_000 } }) @Post('auth/invite/accept') @HttpCode(200)
  accept(@Body() dto: AcceptInviteDto) { return this.svc.accept(dto); }
}
