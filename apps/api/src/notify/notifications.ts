import { BadRequestException, Body, Controller, Get, HttpCode, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnModuleDestroy, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/auth';
import { getConfig } from '../config/app.config';
import { PrismaService } from '../prisma/prisma.service';
import { localToday } from '../sales/cutoff';
import { esc, Mailer } from './mailer';
import { waNumber, WhatsappService } from './whatsapp';

type Tx = Prisma.TransactionClient;
export const NOTIFY_TYPES = ['INVOICE_DUE', 'ORDER_STATUS', 'COLLECTION'] as const;
export type NotifyType = (typeof NOTIFY_TYPES)[number];
const DAY = 86_400_000;

export const ORDER_STATUS_LABEL: Record<string, string> = { CONFIRMED: 'confirmado', PICKING: 'em separação', PACKED: 'embalado', SHIPPED: 'enviado', DELIVERED: 'entregue', CLOSED: 'concluído', CANCELLED: 'cancelado' };

/** Textos padrão (a empresa pode trocar). Variáveis válidas por tipo logo abaixo. */
export const DEFAULT_TEMPLATES: Record<NotifyType, { subject: string; body: string; vars: string[] }> = {
  INVOICE_DUE: {
    subject: 'Lembrete: vencimento em {vencimento}',
    body: 'Olá, {cliente}! Lembrete da {empresa}: {titulos} vence em {vencimento}. Valor: {valor}. Se já pagou, desconsidere esta mensagem. Para deixar de receber estes avisos, fale com a {empresa}.',
    vars: ['cliente', 'empresa', 'titulos', 'vencimento', 'valor', 'qtd'],
  },
  ORDER_STATUS: {
    subject: 'Pedido {pedido}: {status}',
    body: 'Olá, {cliente}! Seu pedido {pedido} na {empresa} está {status}. Para deixar de receber estes avisos, fale com a {empresa}.',
    vars: ['cliente', 'empresa', 'pedido', 'status'],
  },
  COLLECTION: {
    subject: 'Pendência em aberto com a {empresa}',
    body: 'Olá, {cliente}. Identificamos {qtd} título(s) vencido(s) com a {empresa}, somando {valor} (o mais antigo venceu em {vencimento}). Se já pagou, desconsidere; em caso de dúvida, responda esta mensagem. Para deixar de receber estes avisos, fale com a {empresa}.',
    vars: ['cliente', 'empresa', 'valor', 'vencimento', 'qtd'],
  },
};

export const render = (tpl: string, vars: Record<string, string | number>) => tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
const brl = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dateBr = (d: Date) => `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
const utcDay = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);

class RuleDto {
  @IsOptional() @IsBoolean() emailEnabled?: boolean;
  @IsOptional() @IsBoolean() whatsappEnabled?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(30) daysBefore?: number;
  @IsOptional() @IsInt() @Min(1) @Max(90) minOverdueDays?: number;
  @IsOptional() @IsInt() @Min(1) @Max(90) repeatEveryDays?: number;
  @IsOptional() @IsArray() @IsIn(Object.keys(ORDER_STATUS_LABEL), { each: true }) orderStatuses?: string[];
  @IsOptional() @IsString() @MaxLength(150) subject?: string;
  @IsOptional() @IsString() @MaxLength(1000) body?: string;
}
class TestDto {
  @IsIn(['EMAIL', 'WHATSAPP']) channel: 'EMAIL' | 'WHATSAPP';
  @IsString() @MaxLength(200) to: string;
}
class OptOutDto { @IsBoolean() optOut: boolean }
class LogQuery { @IsOptional() @IsString() status?: string; @IsOptional() @IsString() type?: string }
void IsEmail;

/**
 * Avisos automáticos ao cliente por e-mail e WhatsApp: vencimento, status do pedido e cobrança. Tudo começa DESLIGADO, só vai para clientes
 * com contato cadastrado que não pediram para sair, nunca duplica (dedupeKey) e todo envio fica no histórico (enviado, falhou, por quê).
 */
@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name);
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly mailer: Mailer, private readonly wa: WhatsappService) {}

  // ───────────── configuração ─────────────

  async rules(ctx: AuthContext) {
    const rows = await this.prisma.withContext(ctx, (tx) => tx.notificationRule.findMany({ where: { tenantId: ctx.tenantId! } }));
    return NOTIFY_TYPES.map((type) => {
      const r = rows.find((x) => x.type === type);
      const d = DEFAULT_TEMPLATES[type];
      return {
        type, emailEnabled: r?.emailEnabled ?? false, whatsappEnabled: r?.whatsappEnabled ?? false, daysBefore: r?.daysBefore ?? 2, minOverdueDays: r?.minOverdueDays ?? 1, repeatEveryDays: r?.repeatEveryDays ?? 7,
        orderStatuses: (r?.orderStatuses as string[] | undefined) ?? ['CONFIRMED', 'SHIPPED', 'DELIVERED'],
        subject: r?.subject ?? null, body: r?.body ?? null, defaultSubject: d.subject, defaultBody: d.body, variables: d.vars,
      };
    });
  }

  async saveRule(ctx: AuthContext, type: string, dto: RuleDto) {
    if (!(NOTIFY_TYPES as readonly string[]).includes(type)) throw new NotFoundException('Tipo de aviso desconhecido.');
    const allowed = DEFAULT_TEMPLATES[type as NotifyType].vars;
    for (const text of [dto.subject, dto.body]) {
      for (const m of text?.matchAll(/\{(\w+)\}/g) ?? []) if (!allowed.includes(m[1])) throw new BadRequestException(`Variável {${m[1]}} não existe neste aviso. Use: ${allowed.map((v) => `{${v}}`).join(', ')}.`);
    }
    return this.prisma.withContext(ctx, async (tx) => {
      const data = {
        ...(dto.emailEnabled !== undefined ? { emailEnabled: dto.emailEnabled } : {}), ...(dto.whatsappEnabled !== undefined ? { whatsappEnabled: dto.whatsappEnabled } : {}),
        ...(dto.daysBefore !== undefined ? { daysBefore: dto.daysBefore } : {}), ...(dto.minOverdueDays !== undefined ? { minOverdueDays: dto.minOverdueDays } : {}), ...(dto.repeatEveryDays !== undefined ? { repeatEveryDays: dto.repeatEveryDays } : {}),
        ...(dto.orderStatuses ? { orderStatuses: dto.orderStatuses } : {}),
        ...(dto.subject !== undefined ? { subject: dto.subject.trim() || null } : {}), ...(dto.body !== undefined ? { body: dto.body.trim() || null } : {}),
      };
      await tx.notificationRule.upsert({ where: { tenantId_type: { tenantId: ctx.tenantId!, type } }, create: { tenantId: ctx.tenantId!, type, ...data }, update: data });
      await this.audit.record(tx, ctx, { action: 'notification.rule_saved', entity: 'notification_rule', metadata: { type, ...data } });
      return { ok: true };
    });
  }

  logs(ctx: AuthContext, q: LogQuery) {
    return this.prisma.withContext(ctx, async (tx) => {
      const rows = await tx.notificationLog.findMany({ where: { tenantId: ctx.tenantId!, ...(q.status ? { status: q.status } : {}), ...(q.type ? { type: q.type } : {}) }, orderBy: { createdAt: 'desc' }, take: 200 });
      const counts = await tx.notificationLog.groupBy({ by: ['status'], where: { tenantId: ctx.tenantId! }, _count: { _all: true } });
      return { counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])), items: rows.map((r) => ({ id: r.id, type: r.type, channel: r.channel, recipient: r.recipient, subject: r.subject, status: r.status, error: r.error, attempts: r.attempts, createdAt: r.createdAt, sentAt: r.sentAt })) };
    });
  }

  setOptOut(ctx: AuthContext, customerId: string, optOut: boolean) {
    return this.prisma.withContext(ctx, async (tx) => {
      const r = await tx.customer.updateMany({ where: { id: customerId, tenantId: ctx.tenantId! }, data: { notifyOptOut: optOut } });
      if (r.count !== 1) throw new NotFoundException('Cliente não encontrado.');
      await this.audit.record(tx, ctx, { action: optOut ? 'customer.notify_opt_out' : 'customer.notify_opt_in', entity: 'customer', entityId: customerId });
      if (optOut) await tx.notificationLog.updateMany({ where: { tenantId: ctx.tenantId!, customerId, status: 'QUEUED' }, data: { status: 'SKIPPED', error: 'Cliente pediu para não receber avisos.' } });
      return { ok: true };
    });
  }

  // ───────────── geração dos avisos ─────────────

  private async ruleOf(tx: Tx, tenantId: string, type: NotifyType) {
    const r = await tx.notificationRule.findUnique({ where: { tenantId_type: { tenantId, type } } });
    return r && (r.emailEnabled || r.whatsappEnabled) ? r : null;
  }

  /** Cria as linhas da fila (uma por canal ligado e com contato). Não envia nada. */
  private async enqueue(tx: Tx, tenantId: string, rule: NonNullable<Awaited<ReturnType<NotificationsService['ruleOf']>>>, cust: { id: string; name: string; email: string | null; phone: string | null }, vars: Record<string, string | number>, ref: { type: string; id: string }, dedupe: string): Promise<number> {
    const d = DEFAULT_TEMPLATES[rule.type as NotifyType];
    const subject = render(rule.subject ?? d.subject, vars); const body = render(rule.body ?? d.body, vars);
    const data: Prisma.NotificationLogCreateManyInput[] = [];
    if (rule.emailEnabled && cust.email) data.push({ tenantId, type: rule.type, channel: 'EMAIL', recipient: cust.email, subject, body, customerId: cust.id, refType: ref.type, refId: ref.id, dedupeKey: dedupe });
    if (rule.whatsappEnabled && waNumber(cust.phone)) data.push({ tenantId, type: rule.type, channel: 'WHATSAPP', recipient: waNumber(cust.phone)!, subject: null, body, customerId: cust.id, refType: ref.type, refId: ref.id, dedupeKey: dedupe });
    if (!data.length) return 0;
    return (await tx.notificationLog.createMany({ data, skipDuplicates: true })).count;
  }

  /** Chamado na mesma transação da mudança de status do pedido (só grava a fila). */
  async onOrderStatus(tx: Tx, tenantId: string, orderId: string, status: string) {
    const rule = await this.ruleOf(tx, tenantId, 'ORDER_STATUS');
    if (!rule || !(rule.orderStatuses as string[]).includes(status)) return;
    const o = await tx.salesOrder.findFirst({ where: { id: orderId, tenantId }, select: { number: true, channel: true, customer: { select: { id: true, name: true, email: true, phone: true, notifyOptOut: true } } } });
    if (!o || o.channel === 'MARKETPLACE' || o.customer.notifyOptOut) return; // pedido de marketplace: quem avisa é o marketplace
    const t = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } });
    await this.enqueue(tx, tenantId, rule, o.customer, { cliente: o.customer.name, empresa: t.name, pedido: `#${o.number}`, status: ORDER_STATUS_LABEL[status] ?? status.toLowerCase() }, { type: 'ORDER', id: orderId }, `order:${orderId}:${status}`);
  }

  /** Varredura diária de vencimentos e cobrança de uma empresa. Pode rodar quantas vezes quiser: a chave de deduplicação impede repetição. */
  async scanTenant(tenantId: string, now = new Date()): Promise<{ due: number; collection: number }> {
    return this.prisma.withContext({ tenantId }, async (tx) => {
      const today = localToday(now);
      const t = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } });
      const out = { due: 0, collection: 0 };
      const open: Prisma.FinancialTitleWhereInput = { tenantId, direction: 'RECEIVABLE', status: { in: ['OPEN', 'PARTIAL'] }, customerId: { not: null } };

      const dueRule = await this.ruleOf(tx, tenantId, 'INVOICE_DUE');
      if (dueRule) {
        const target = new Date(utcDay(today).getTime() + dueRule.daysBefore * DAY);
        const titles = await tx.financialTitle.findMany({ where: { ...open, dueDate: { gte: target, lt: new Date(target.getTime() + DAY) } }, select: { customerId: true, amount: true, paidPrincipal: true, documentRef: true, installmentNo: true, installmentTotal: true } });
        const byCustomer = new Map<string, typeof titles>();
        for (const x of titles) byCustomer.set(x.customerId!, [...(byCustomer.get(x.customerId!) ?? []), x]);
        const customers = await tx.customer.findMany({ where: { tenantId, id: { in: [...byCustomer.keys()] }, notifyOptOut: false }, select: { id: true, name: true, email: true, phone: true } });
        for (const c of customers) {
          const list = byCustomer.get(c.id)!;
          const cents = list.reduce((s, x) => s + Math.round((Number(x.amount) - Number(x.paidPrincipal)) * 100), 0);
          if (cents <= 0) continue;
          const names = list.length === 1 ? `a parcela ${list[0].installmentNo}/${list[0].installmentTotal} do pedido ${list[0].documentRef ?? ''}`.trim() : `${list.length} títulos`;
          out.due += await this.enqueue(tx, tenantId, dueRule, c, { cliente: c.name, empresa: t.name, titulos: names, vencimento: dateBr(target), valor: brl(cents), qtd: list.length }, { type: 'CUSTOMER', id: c.id }, `due:${c.id}:${today}:${dueRule.daysBefore}`);
        }
      }

      const collRule = await this.ruleOf(tx, tenantId, 'COLLECTION');
      if (collRule) {
        const limit = new Date(utcDay(today).getTime() - collRule.minOverdueDays * DAY + DAY); // vencido há pelo menos N dias
        const titles = await tx.financialTitle.findMany({ where: { ...open, dueDate: { lt: limit } }, select: { customerId: true, amount: true, paidPrincipal: true, dueDate: true } });
        const byCustomer = new Map<string, typeof titles>();
        for (const x of titles) byCustomer.set(x.customerId!, [...(byCustomer.get(x.customerId!) ?? []), x]);
        const customers = await tx.customer.findMany({ where: { tenantId, id: { in: [...byCustomer.keys()] }, notifyOptOut: false }, select: { id: true, name: true, email: true, phone: true } });
        const bucket = Math.floor(utcDay(today).getTime() / DAY / collRule.repeatEveryDays);
        for (const c of customers) {
          const list = byCustomer.get(c.id)!;
          const cents = list.reduce((s, x) => s + Math.round((Number(x.amount) - Number(x.paidPrincipal)) * 100), 0);
          if (cents <= 0) continue;
          const oldest = list.reduce((m, x) => (x.dueDate < m ? x.dueDate : m), list[0].dueDate);
          out.collection += await this.enqueue(tx, tenantId, collRule, c, { cliente: c.name, empresa: t.name, valor: brl(cents), vencimento: dateBr(oldest), qtd: list.length }, { type: 'CUSTOMER', id: c.id }, `coll:${c.id}:${bucket}`);
        }
      }
      return out;
    });
  }

  // ───────────── envio ─────────────

  /** Envia a fila da empresa. Falha temporária tenta de novo (até 3 vezes); falha definitiva grava o motivo. */
  async dispatchTenant(tenantId: string, limit = 50): Promise<{ sent: number; failed: number }> {
    const rows = await this.prisma.withContext({ tenantId }, (tx) => tx.notificationLog.findMany({ where: { tenantId, status: 'QUEUED' }, orderBy: { createdAt: 'asc' }, take: limit }));
    if (!rows.length) return { sent: 0, failed: 0 };
    const t = await this.prisma.withContext({ tenantId }, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } }));
    let sent = 0; let failed = 0;
    for (const r of rows) {
      // ainda vale? (regra desligada ou cliente saiu depois de entrar na fila)
      const cust = r.customerId ? await this.prisma.withContext({ tenantId }, (tx) => tx.customer.findFirst({ where: { id: r.customerId!, tenantId }, select: { notifyOptOut: true } })) : null;
      const rule = await this.prisma.withContext({ tenantId }, (tx) => tx.notificationRule.findUnique({ where: { tenantId_type: { tenantId, type: r.type } } }));
      const on = r.channel === 'EMAIL' ? rule?.emailEnabled : rule?.whatsappEnabled;
      if (cust?.notifyOptOut || !on) { await this.mark(tenantId, r.id, 'SKIPPED', r.attempts, cust?.notifyOptOut ? 'Cliente pediu para não receber avisos.' : 'Aviso desligado nas configurações.'); continue; }
      const res = r.channel === 'EMAIL'
        ? await this.mailer.send({ to: r.recipient, subject: r.subject ?? 'Aviso', text: r.body, html: `<div style="font-family:system-ui,sans-serif;max-width:520px"><p>${esc(r.body)}</p><p style="color:#666;font-size:12px">${esc(t.name)}</p></div>`, fromName: t.name })
        : await this.wa.sendText(tenantId, r.recipient, r.body);
      if (res.ok) { sent++; await this.mark(tenantId, r.id, 'SENT', r.attempts + 1, null); continue; }
      failed++;
      const final = !res.retryable || r.attempts + 1 >= 3;
      await this.mark(tenantId, r.id, final ? 'FAILED' : 'QUEUED', r.attempts + 1, res.reason);
    }
    return { sent, failed };
  }

  private mark(tenantId: string, id: string, status: string, attempts: number, error: string | null) {
    return this.prisma.withContext({ tenantId }, (tx) => tx.notificationLog.updateMany({ where: { id, tenantId }, data: { status, attempts, error, ...(status === 'SENT' ? { sentAt: new Date() } : {}) } }));
  }

  /** Botão "Enviar agora": varre e envia só desta empresa. */
  async runNow(ctx: AuthContext) {
    const scan = await this.scanTenant(ctx.tenantId!);
    const sent = await this.dispatchTenant(ctx.tenantId!);
    return { generated: scan.due + scan.collection, ...sent };
  }

  /** Mensagem de teste direta (não passa pela fila nem pelo cadastro de clientes). */
  async sendTest(ctx: AuthContext, dto: TestDto) {
    const company = (await this.prisma.withContext(ctx, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId! }, select: { name: true } }))).name;
    const text = `Teste de aviso da ${company} (${getConfig().appName}). Se você recebeu esta mensagem, o canal está funcionando.`;
    const r = dto.channel === 'EMAIL' ? await this.mailer.send({ to: dto.to.trim(), subject: `Teste de aviso — ${company}`, text, fromName: company }) : await this.wa.sendText(ctx.tenantId!, dto.to, text);
    if (!r.ok) throw new BadRequestException(r.reason);
    return { ok: true };
  }
}

/** Varredura periódica em segundo plano (desligada em testes e com WORKER_ENABLED=false). Só envia entre 8h e 20h (Brasília). */
@Injectable()
export class NotificationWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(NotificationWorker.name);
  private timer?: NodeJS.Timeout; private running = false;
  private watchdog?: NodeJS.Timeout; private watching = false;
  constructor(private readonly prisma: PrismaService, private readonly svc: NotificationsService, private readonly wa: WhatsappService) {}

  onApplicationBootstrap() {
    if (process.env.NODE_ENV === 'test' || !getConfig().workerEnabled) return;
    this.timer = setInterval(() => void this.tick().catch((e) => this.log.error(e)), 5 * 60_000);
    // vigia da sessão do WhatsApp: a cada 2 minutos, a qualquer hora
    this.watchdog = setInterval(() => void this.watch().catch((e) => this.log.error(e)), 2 * 60_000);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); if (this.watchdog) clearInterval(this.watchdog); }

  async watch() {
    if (this.watching) return;
    this.watching = true;
    try {
      const rows = await this.prisma.$queryRaw<{ tenant_id: string }[]>`SELECT tenant_id FROM list_whatsapp_tenants()`;
      for (const { tenant_id } of rows) await this.wa.keepAlive(tenant_id).catch((e) => this.log.error(`vigia tenant ${tenant_id}: ${(e as Error).message}`));
    } finally { this.watching = false; }
  }

  static inWindow(now = new Date()): boolean {
    const h = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'America/Sao_Paulo' }).format(now));
    return h >= 8 && h < 20;
  }

  async tick(now = new Date()) {
    if (this.running || !NotificationWorker.inWindow(now)) return;
    this.running = true;
    try {
      const rows = await this.prisma.$queryRaw<{ tenant_id: string }[]>`SELECT tenant_id FROM list_notification_tenants()`;
      for (const { tenant_id } of rows) {
        try { await this.svc.scanTenant(tenant_id, now); await this.svc.dispatchTenant(tenant_id); } catch (e) { this.log.error(`tenant ${tenant_id}: ${(e as Error).message}`); }
      }
    } finally { this.running = false; }
  }
}

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly svc: NotificationsService, private readonly wa: WhatsappService, private readonly mailer: Mailer) {}

  @Get('rules') @RequirePermissions('notifications.manage')
  async rules(@CurrentAuth() ctx: AuthContext) { return { emailAvailable: this.mailer.configured(), whatsappAvailable: this.wa.configured(), rules: await this.svc.rules(ctx) }; }

  @Put('rules/:type') @RequirePermissions('notifications.manage')
  save(@CurrentAuth() ctx: AuthContext, @Param('type') type: string, @Body() dto: RuleDto) { return this.svc.saveRule(ctx, type, dto); }

  @Get('logs') @RequirePermissions('notifications.manage')
  logs(@CurrentAuth() ctx: AuthContext, @Query() q: LogQuery) { return this.svc.logs(ctx, q); }

  @Post('run') @HttpCode(200) @RequirePermissions('notifications.manage')
  run(@CurrentAuth() ctx: AuthContext) { return this.svc.runNow(ctx); }

  @Post('test') @HttpCode(200) @RequirePermissions('notifications.manage')
  test(@CurrentAuth() ctx: AuthContext, @Body() dto: TestDto) { return this.svc.sendTest(ctx, dto); }

  @Put('customers/:id/opt-out') @RequirePermissions('customers.manage')
  optOut(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: OptOutDto) { return this.svc.setOptOut(ctx, id, dto.optOut); }

  @Get('whatsapp') @RequirePermissions('notifications.manage')
  waStatus(@CurrentAuth() ctx: AuthContext) { return this.wa.status(ctx); }

  @Post('whatsapp/connect') @HttpCode(200) @RequirePermissions('notifications.manage')
  waConnect(@CurrentAuth() ctx: AuthContext) { return this.wa.connect(ctx); }

  @Post('whatsapp/disconnect') @HttpCode(200) @RequirePermissions('notifications.manage')
  waDisconnect(@CurrentAuth() ctx: AuthContext) { return this.wa.disconnect(ctx); }
}
