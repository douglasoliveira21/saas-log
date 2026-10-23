import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, HttpException, HttpStatus, Injectable, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IsNotEmpty, IsString, IsUUID, Length, MaxLength } from 'class-validator';
import { AuditService } from '../../audit/audit.service';
import { AuthContext, CurrentAuth, RequirePermissions } from '../../common/auth';
import { isValidCnpj, isValidCpf, onlyDigits } from '../../common/cnpj';
import { PrismaService } from '../../prisma/prisma.service';
import { localToday } from '../../sales/cutoff';
import { buildChave } from '../chave';
import { FiscalEnvironment, ProviderCtx } from '../fiscal-provider';
import { ProviderContextService } from '../fiscal-provider.router';
import { IbgeService } from '../sefaz/ibge';
import { signXml, verifySignature } from '../sefaz/signature';
import { Mtls, soapCall, SoapFlavor, TlsSetupError } from '../sefaz/soap';
import {
  buildMdfeXml, cancelDetail, closeDetail, consSitMDFe, MDFE_AUTHORIZED, MDFE_EVENT_OK, MDFE_NS, mdfeEvent, mdfeProc, mdfeResultOf, MdfeInput, parseMdfeAuthorization, parseMdfeEvent,
  parseMdfeSituation, syncBody, TP_ROD,
} from './mdfe-xml';
import { mdfeService } from './mdfe-registry';
import { validateMdfeFull, validateMdfe } from './xsd';

type Tx = Prisma.TransactionClient;
interface Issue { severity: 'BLOCKING' | 'INFO'; code: string; message: string }
type Payload = Omit<MdfeInput, 'chave' | 'issuedAt' | 'environment' | 'procVersion'> & { routeNumber: number; orderNumbers: number[]; weightKg: number };

const FLAVOR: SoapFlavor = { portal: MDFE_NS, element: 'mdfeDadosMsg', header: '<mdfeCabecMsg xmlns="{NS}"><cUF>31</cUF><versaoDados>3.00</versaoDados></mdfeCabecMsg>' };
const PLATE = /^[A-Za-z]{3}-?\d[A-Za-z0-9]\d{2}$/;
const mtls = (ctx: ProviderCtx): Mtls => ({ keyPem: ctx.certificate!.keyPem, certPem: ctx.certificate!.certPem });
const nowBrt = () => new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).replace(' ', 'T') + '-03:00';

class IdDto { @IsUUID() routeId: string }
class ReasonDto { @IsString() @IsNotEmpty() @Length(15, 255) reason: string }

/**
 * MDF-e (modal rodoviário, carga própria) de uma viagem: prepara a partir da rota (veículo, motorista, NF-e autorizadas dos pedidos), transmite
 * pelo serviço síncrono da SEFAZ Virtual do RS (SVRS) com o certificado A1 do estabelecimento, consulta, encerra e cancela.
 * NUNCA foi executado contra a SEFAZ real. Só emissão direta (certificado A1 do estabelecimento).
 */
@Injectable()
export class MdfeService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly pctx: ProviderContextService, private readonly ibge: IbgeService) {}

  // ───────────── consulta ─────────────

  list(ctx: AuthContext) {
    return this.prisma.withContext(ctx, async (tx) => {
      const rows = await tx.mdfeDocument.findMany({ where: { tenantId: ctx.tenantId! }, orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, routeId: true, status: true, environment: true, number: true, series: true, accessKey: true, protocol: true, statusCode: true, statusMessage: true, issues: true, payload: true, createdAt: true, vehicle: { select: { plate: true } } } });
      return rows.map(({ payload, ...r }) => ({ ...r, routeNumber: (payload as { routeNumber?: number }).routeNumber ?? null, weightKg: (payload as { weightKg?: number }).weightKg ?? null }));
    });
  }

  get(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const d = await tx.mdfeDocument.findFirst({ where: { id, tenantId: ctx.tenantId! }, include: { vehicle: { select: { plate: true, description: true } } } });
      if (!d) throw new NotFoundException('MDF-e não encontrado.');
      const { signedXml, authorizedXml, ...rest } = d;
      return { ...rest, hasXml: !!authorizedXml, signed: !!signedXml };
    });
  }

  async xml(ctx: AuthContext, id: string) {
    const d = await this.prisma.withContext(ctx, (tx) => tx.mdfeDocument.findFirst({ where: { id, tenantId: ctx.tenantId! }, select: { authorizedXml: true, accessKey: true } }));
    if (!d?.authorizedXml) throw new NotFoundException('XML autorizado não disponível.');
    return { content: Buffer.from(d.authorizedXml, 'utf8'), name: `mdfe-${d.accessKey}.xml` };
  }

  /** Viagens com veículo e NF-e que ainda não têm MDF-e ativo. */
  eligibleRoutes(ctx: AuthContext) {
    return this.prisma.withContext(ctx, async (tx) => {
      const routes = await tx.deliveryRoute.findMany({ where: { tenantId: ctx.tenantId!, status: { in: ['PLANNED', 'IN_PROGRESS', 'COMPLETED'] } }, orderBy: { routeDate: 'desc' }, take: 60, include: { vehicle: { select: { plate: true } }, driver: { select: { name: true } }, _count: { select: { stops: true } } } });
      const used = await tx.mdfeDocument.findMany({ where: { tenantId: ctx.tenantId!, routeId: { in: routes.map((r) => r.id) }, status: { notIn: ['CANCELLED', 'REJECTED'] } }, select: { routeId: true } });
      const taken = new Set(used.map((u) => u.routeId));
      return routes.filter((r) => !taken.has(r.id)).map((r) => ({ id: r.id, number: r.number, routeDate: r.routeDate.toISOString().slice(0, 10), status: r.status, vehicle: r.vehicle?.plate ?? null, driver: r.driver.name, stops: r._count.stops }));
    });
  }

  // ───────────── preparação ─────────────

  /** Monta (ou refaz, se ainda rascunho) o MDF-e da viagem e aponta o que impede a transmissão. */
  async prepare(ctx: AuthContext, routeId: string) {
    await this.warmCities(ctx, routeId);
    return this.prisma.withContext(ctx, async (tx) => {
      const existing = await tx.mdfeDocument.findFirst({ where: { tenantId: ctx.tenantId!, routeId, status: { notIn: ['CANCELLED', 'REJECTED'] } } });
      if (existing && existing.status !== 'DRAFT') throw new ConflictException(`Esta viagem já tem um MDF-e (${existing.status === 'AUTHORIZED' ? 'autorizado' : existing.status === 'CLOSED' ? 'encerrado' : 'em andamento'}).`);
      const r = await this.compute(tx, ctx, routeId);
      const data = { vehicleId: r.vehicleId, establishmentId: r.establishmentId, environment: r.environment, payload: r.payload as unknown as Prisma.InputJsonValue, issues: r.issues as unknown as Prisma.InputJsonValue };
      const doc = existing
        ? await tx.mdfeDocument.update({ where: { id: existing.id }, data })
        : await tx.mdfeDocument.create({ data: { tenantId: ctx.tenantId!, routeId, createdById: ctx.userId, ...data } });
      await this.audit.record(tx, ctx, { action: 'mdfe.prepared', entity: 'mdfe', entityId: doc.id, metadata: { routeId, blocking: r.issues.filter((i) => i.severity === 'BLOCKING').length } });
      return { id: doc.id, status: doc.status, issues: r.issues, ready: !r.issues.some((i) => i.severity === 'BLOCKING') };
    });
  }

  private async warmCities(ctx: AuthContext, routeId: string) {
    const ufs = await this.prisma.withContext(ctx, async (tx) => {
      const stops = await tx.deliveryStop.findMany({ where: { tenantId: ctx.tenantId!, routeId, status: { not: 'CANCELLED' } }, select: { state: true } });
      const o = await tx.deliveryStop.findFirst({ where: { tenantId: ctx.tenantId!, routeId }, select: { order: { select: { warehouse: { select: { establishment: { select: { state: true } } } } } } } });
      return [...stops.map((s) => s.state), o?.order.warehouse.establishment.state];
    });
    for (const uf of new Set(ufs.filter(Boolean) as string[])) await this.ibge.warm(uf.toUpperCase());
  }

  /** Reúne os dados da viagem e as pendências. Não grava nada. */
  private async compute(tx: Tx, ctx: AuthContext, routeId: string) {
    const route = await tx.deliveryRoute.findFirst({ where: { id: routeId, tenantId: ctx.tenantId! }, include: { vehicle: true, driver: true, stops: { where: { status: { not: 'CANCELLED' } }, orderBy: { sequence: 'asc' } } } });
    if (!route) throw new NotFoundException('Viagem não encontrada.');
    if (route.status === 'CANCELLED') throw new ConflictException('Viagem cancelada.');
    const issues: Issue[] = [];
    const block = (code: string, message: string) => issues.push({ severity: 'BLOCKING', code, message });
    if (!route.stops.length) throw new ConflictException('A viagem não tem paradas.');
    const orders = await tx.salesOrder.findMany({ where: { tenantId: ctx.tenantId!, id: { in: route.stops.map((s) => s.salesOrderId) } }, include: { warehouse: { select: { establishmentId: true } } } });
    const estIds = [...new Set(orders.map((o) => o.warehouse.establishmentId))];
    if (estIds.length !== 1) throw new ConflictException('Os pedidos da viagem saem de estabelecimentos diferentes: o MDF-e é de um só emitente.');
    const est = await tx.establishment.findFirstOrThrow({ where: { id: estIds[0], tenantId: ctx.tenantId! }, include: { company: true } });
    const cfg = await tx.fiscalConfiguration.findFirst({ where: { tenantId: ctx.tenantId!, establishmentId: est.id } });
    const environment = ((cfg?.environment as FiscalEnvironment) ?? 'HOMOLOGACAO');

    // emitente
    const cnpj = onlyDigits(est.cnpj ?? '');
    if (!cnpj || !isValidCnpj(cnpj)) block('EMITTER_CNPJ', 'O estabelecimento emitente não tem CNPJ válido.');
    if (!est.stateRegistration) block('EMITTER_IE', 'O estabelecimento emitente não tem inscrição estadual.');
    if (!est.street || !est.city || !est.state || !est.zipCode || !est.district) block('EMITTER_ADDRESS', 'Endereço do estabelecimento incompleto (logradouro, bairro, município, UF e CEP).');
    const cMunEst = est.city && est.state ? this.ibge.lookup(est.city, est.state) : null;
    if (!cMunEst) block('EMITTER_CITY', 'Código IBGE do município do estabelecimento não encontrado.');

    // veículo e motorista
    const v = route.vehicle;
    if (!v) block('VEHICLE', 'A viagem não tem veículo definido (Rotas e entregas → Veículo).');
    else {
      if (!PLATE.test(v.plate)) block('VEHICLE_PLATE', `Placa ${v.plate} fora do padrão.`);
      if (!v.tareKg) block('VEHICLE_TARE', `Informe a tara (kg) do veículo ${v.plate} em Frota e carga.`);
      if (!v.plateUf) block('VEHICLE_UF', `Informe a UF de emplacamento do veículo ${v.plate} em Frota e carga.`);
    }
    const cpf = onlyDigits(route.driver.cpf ?? '');
    if (!cpf || !isValidCpf(cpf)) block('DRIVER_CPF', `Informe o CPF do motorista ${route.driver.name} (Rotas e entregas → Motoristas).`);

    // notas e municípios de descarga
    const docs = await tx.fiscalDocument.findMany({ where: { tenantId: ctx.tenantId!, salesOrderId: { in: orders.map((o) => o.id) }, direction: 'EXIT', status: 'AUTHORIZED', purpose: 'NORMAL' }, select: { salesOrderId: true, model: true, accessKey: true, totalInvoice: true } });
    const nfe = docs.filter((d) => d.model === '55' && d.accessKey);
    const byOrder = new Map<string, string[]>();
    for (const d of nfe) byOrder.set(d.salesOrderId!, [...(byOrder.get(d.salesOrderId!) ?? []), d.accessKey!]);
    const unload = new Map<string, { cMun: string; city: string; nfeKeys: string[] }>();
    const states: string[] = [];
    for (const s of route.stops) {
      const o = orders.find((x) => x.id === s.salesOrderId)!;
      const keys = byOrder.get(s.salesOrderId);
      if (!keys?.length) block('NFE_MISSING', `Pedido ${o.number} sem NF-e autorizada (modelo 55)${docs.some((d) => d.salesOrderId === s.salesOrderId && d.model === '65') ? ': NFC-e não entra no MDF-e' : ''}. O transporte exige o documento fiscal.`);
      const cMun = s.city && s.state ? this.ibge.lookup(s.city, s.state) : null;
      if (!cMun) { block('STOP_CITY', `Município da parada do pedido ${o.number} sem código IBGE (${s.city ?? 'sem cidade'}/${s.state ?? '—'}).`); continue; }
      const g = unload.get(cMun) ?? { cMun, city: s.city!, nfeKeys: [] };
      g.nfeKeys.push(...(keys ?? [])); unload.set(cMun, g);
      if (s.state) states.push(s.state.toUpperCase());
    }
    const nfeKeys = [...unload.values()].flatMap((u) => u.nfeKeys);
    if (!nfeKeys.length) block('NO_NFE', 'Nenhuma NF-e autorizada nos pedidos da viagem.');

    // peso e valor
    const w = await tx.$queryRaw<{ g: string | null }[]>`
      SELECT sum(i.quantity * COALESCE(p.gross_weight_g, p.net_weight_g, 0))::bigint AS g FROM delivery_stops s JOIN sales_order_items i ON i.order_id = s.sales_order_id JOIN products p ON p.id = i.product_id
      WHERE s.tenant_id = ${ctx.tenantId}::uuid AND s.route_id = ${routeId}::uuid AND s.status <> 'CANCELLED'`;
    const weightKg = Math.round(Number(w[0]?.g ?? 0)) / 1000;
    if (weightKg <= 0) block('WEIGHT', 'Peso total da carga zerado: cadastre o peso dos produtos.');
    const value = nfe.reduce((sum, d) => sum + Math.round(Number(d.totalInvoice ?? 0) * 100), 0) / 100;

    // certificado e provedor
    const pc = await this.pctx.resolve(tx, ctx.tenantId!, est.id, '55', environment);
    if (pc.providerName !== 'SEFAZ_DIRECT') block('PROVIDER', 'O MDF-e exige a emissão direta na SEFAZ configurada para o estabelecimento (certificado A1).');
    else if (!pc.certificate) block('CERTIFICATE', 'Certificado digital A1 não cadastrado ou ilegível para o estabelecimento.');

    const ufIni = (est.state ?? '').toUpperCase();
    const ufFim = states[states.length - 1] ?? ufIni;
    const mid = [...new Set(states)].filter((u) => u !== ufIni && u !== ufFim);
    const payload: Payload = {
      routeNumber: route.number, orderNumbers: orders.map((o) => o.number).sort((a, b) => a - b), weightKg,
      emitter: { cnpj, ie: est.stateRegistration ?? '', name: est.company.legalName, tradeName: est.company.tradeName, street: est.street ?? '', number: est.number ?? 'SN', complement: est.complement, district: est.district ?? '', cMun: cMunEst ?? '', city: est.city ?? '', uf: ufIni, zip: onlyDigits(est.zipCode ?? ''), phone: est.company.contactPhone, email: est.company.contactEmail },
      load: { cMun: cMunEst ?? '', city: est.city ?? '' }, ufIni, ufFim, route: mid,
      vehicle: { plate: v?.plate ?? '', renavam: v?.renavam, tareKg: v?.tareKg ?? 0, capKg: v?.capacityKg, uf: v?.plateUf ?? '', tpRod: TP_ROD[v?.kind ?? 'OTHER'] ?? '06', tpCar: v?.bodyCode ?? '00' },
      driver: { name: route.driver.name, cpf },
      unload: [...unload.values()], totals: { nfeCount: nfeKeys.length, value, weightKg }, additionalInfo: `Viagem ${route.number}`,
    };
    // ensaio completo (XML + assinatura + XSD) com número de teste, sem enviar nada
    if (!issues.some((i) => i.severity === 'BLOCKING') && pc.certificate) {
      try {
        const test = this.sign(this.build(payload, environment, buildChave({ uf: ufIni, issuedAt: new Date(), cnpj, model: '58', series: 1, number: 1 }), new Date()), pc);
        const check = await validateMdfeFull(test);
        if (!check.valid) block('XSD', `O XML do MDF-e não passa no leiaute: ${check.errors[0]?.message}`);
      } catch (e) { block('BUILD', `Não foi possível montar o MDF-e: ${(e as Error).message}`); }
    }
    return { issues, payload, vehicleId: v?.id ?? null, establishmentId: est.id, environment, pc, estUf: ufIni };
  }

  private build(p: Payload, environment: FiscalEnvironment, chave: string, issuedAt: Date): string {
    const { routeNumber: _r, orderNumbers: _o, weightKg: _w, ...input } = p;
    void _r; void _o; void _w;
    return buildMdfeXml({ ...input, environment, chave, issuedAt, procVersion: 'DistribuiHub 1.0' });
  }
  private sign(xml: string, pc: ProviderCtx): string { return signXml(xml, { keyPem: pc.certificate!.keyPem, certPem: pc.certificate!.certPem, tagToSign: 'infMDFe', after: 'infMDFe' }); }

  // ───────────── transmissão ─────────────

  async transmit(ctx: AuthContext, id: string) {
    const routeId = await this.prisma.withContext(ctx, async (tx) => (await tx.mdfeDocument.findFirst({ where: { id, tenantId: ctx.tenantId! }, select: { routeId: true } }))?.routeId);
    if (!routeId) throw new NotFoundException('MDF-e não encontrado.');
    await this.warmCities(ctx, routeId);
    // 1) reserva número e chave, grava o XML assinado e marca TRANSMITTING (transação curta)
    const prep = await this.prisma.withContext(ctx, async (tx) => {
      await tx.$queryRaw`SELECT id FROM mdfe_documents WHERE id = ${id}::uuid AND tenant_id = ${ctx.tenantId}::uuid FOR UPDATE`;
      const d = await tx.mdfeDocument.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId! } });
      if (d.status === 'PENDING_CONSULT') throw new ConflictException('A resposta da transmissão anterior é desconhecida: use "Consultar situação" antes de qualquer reenvio.');
      if (d.status === 'TRANSMITTING') throw new ConflictException('Transmissão em andamento.');
      if (d.status !== 'DRAFT') throw new ConflictException(`MDF-e "${d.status}" não pode ser transmitido.`);
      const r = await this.compute(tx, ctx, d.routeId);
      await tx.mdfeDocument.update({ where: { id }, data: { payload: r.payload as unknown as Prisma.InputJsonValue, issues: r.issues as unknown as Prisma.InputJsonValue, vehicleId: r.vehicleId, environment: r.environment } });
      const blocking = r.issues.filter((i) => i.severity === 'BLOCKING');
      if (blocking.length) throw new ConflictException({ message: 'O MDF-e não está apto para transmissão.', issues: r.issues });
      let { number, accessKey, series } = d; let issuedAt = d.issuedAt;
      if (!number || !accessKey) {
        const rows = await tx.$queryRaw<{ last: number }[]>`
          INSERT INTO fiscal_series (tenant_id, establishment_id, model, series, environment, last) VALUES (${ctx.tenantId}::uuid, ${r.establishmentId}::uuid, '58', 1, ${r.environment}, 1)
          ON CONFLICT (tenant_id, establishment_id, model, series, environment) DO UPDATE SET last = fiscal_series.last + 1 RETURNING last`;
        number = rows[0].last; series = 1; issuedAt = new Date();
        accessKey = buildChave({ uf: r.estUf, issuedAt, cnpj: r.payload.emitter.cnpj, model: '58', series, number });
      }
      const signed = this.sign(this.build(r.payload, r.environment, accessKey, issuedAt!), r.pc);
      await tx.mdfeDocument.update({ where: { id }, data: { status: 'TRANSMITTING', number, series, accessKey, issuedAt, signedXml: signed } });
      await this.audit.record(tx, ctx, { action: 'mdfe.transmit_started', entity: 'mdfe', entityId: id, metadata: { number, series, accessKey, environment: r.environment } });
      return { pc: r.pc, signed, accessKey, environment: r.environment };
    });
    // 2) chama a SEFAZ sem transação aberta
    let outcome: { kind: 'AUTHORIZED'; protocol: string; code: string; proc: string } | { kind: 'REJECTED'; code: string; reason: string } | { kind: 'TIMEOUT' } | { kind: 'NOT_SENT'; reason: string };
    try {
      const url = mdfeService(prep.pc.uf ?? '', prep.environment, 'recepcao').url;
      const reply = await soapCall(url, { operation: 'MDFeRecepcaoSinc', method: 'mdfeRecepcao' }, syncBody(prep.signed), mtls(prep.pc), 30_000, FLAVOR);
      const a = parseMdfeAuthorization(mdfeResultOf(reply.text));
      const prot = a.prot;
      if (prot && MDFE_AUTHORIZED.includes(prot.cStat)) outcome = { kind: 'AUTHORIZED', protocol: prot.protocol ?? '', code: prot.cStat, proc: mdfeProc(prep.signed, prot.raw) };
      else if (prot || (a.cStat && !['103', '104', '105'].includes(a.cStat))) outcome = { kind: 'REJECTED', code: prot?.cStat ?? a.cStat, reason: prot?.xMotivo ?? a.xMotivo };
      else outcome = { kind: 'TIMEOUT' };
    } catch (e) {
      const sent = (e as { sent?: boolean }).sent === true;
      outcome = e instanceof TlsSetupError ? { kind: 'NOT_SENT', reason: e.message } : sent ? { kind: 'TIMEOUT' } : { kind: 'NOT_SENT', reason: `Sem conexão com a SEFAZ: ${(e as Error).message}` };
    }
    // 3) grava o resultado (o erro, se houver, só é lançado depois do commit: lançar dentro da transação desfaria a gravação)
    const saved = await this.prisma.withContext(ctx, async (tx) => {
      await tx.$queryRaw`SELECT id FROM mdfe_documents WHERE id = ${id}::uuid AND tenant_id = ${ctx.tenantId}::uuid FOR UPDATE`;
      if (outcome.kind === 'AUTHORIZED') {
        await tx.mdfeDocument.update({ where: { id }, data: { status: 'AUTHORIZED', protocol: outcome.protocol, statusCode: outcome.code, statusMessage: 'Autorizado o uso do MDF-e', authorizedXml: outcome.proc } });
        await this.audit.record(tx, ctx, { action: 'mdfe.authorized', entity: 'mdfe', entityId: id, metadata: { protocol: outcome.protocol } });
        return { ok: { id, status: 'AUTHORIZED' as const, protocol: outcome.protocol } };
      }
      if (outcome.kind === 'REJECTED') {
        await tx.mdfeDocument.update({ where: { id }, data: { status: 'REJECTED', statusCode: outcome.code, statusMessage: outcome.reason } });
        await this.audit.record(tx, ctx, { action: 'mdfe.rejected', entity: 'mdfe', entityId: id, metadata: { code: outcome.code, reason: outcome.reason } });
        return { error: new ConflictException(`MDF-e rejeitado (${outcome.code}): ${outcome.reason}`) };
      }
      if (outcome.kind === 'TIMEOUT') {
        await tx.mdfeDocument.update({ where: { id }, data: { status: 'PENDING_CONSULT', statusMessage: 'Resposta desconhecida: consulte antes de reenviar.' } });
        return { error: new ConflictException('A SEFAZ não respondeu a tempo. NÃO reenvie: use "Consultar situação" para saber se o MDF-e foi autorizado.') };
      }
      await tx.mdfeDocument.update({ where: { id }, data: { status: 'DRAFT', statusMessage: outcome.reason } });
      return { error: new HttpException({ message: outcome.reason, code: 'NOT_SENT' }, HttpStatus.FAILED_DEPENDENCY) };
    });
    if ('error' in saved) throw saved.error;
    return saved.ok;
  }

  // ───────────── consulta, encerramento e cancelamento ─────────────

  private async loadForCall(ctx: AuthContext, id: string, ok: (status: string) => boolean, why: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const d = await tx.mdfeDocument.findFirst({ where: { id, tenantId: ctx.tenantId! } });
      if (!d) throw new NotFoundException('MDF-e não encontrado.');
      if (!ok(d.status)) throw new ConflictException(why);
      if (!d.accessKey) throw new ConflictException('MDF-e sem chave de acesso.');
      const pc = await this.pctx.resolve(tx, ctx.tenantId!, d.establishmentId, '55', d.environment as FiscalEnvironment);
      if (pc.providerName !== 'SEFAZ_DIRECT' || !pc.certificate) throw new HttpException({ message: 'Certificado A1 / emissão direta não disponível para este estabelecimento.', code: 'NOT_CONFIGURED' }, HttpStatus.FAILED_DEPENDENCY);
      return { d, pc };
    });
  }

  async consult(ctx: AuthContext, id: string) {
    const { d, pc } = await this.loadForCall(ctx, id, (s) => ['PENDING_CONSULT', 'TRANSMITTING', 'AUTHORIZED', 'CLOSED', 'CANCELLED'].includes(s), 'Não há o que consultar neste MDF-e.');
    const env = d.environment as FiscalEnvironment;
    let r: ReturnType<typeof parseMdfeSituation>;
    try {
      const reply = await soapCall(mdfeService(pc.uf ?? '', env, 'consulta').url, { operation: 'MDFeConsulta', method: 'mdfeConsultaMDF' }, consSitMDFe(d.accessKey!, env), mtls(pc), 30_000, FLAVOR);
      r = parseMdfeSituation(mdfeResultOf(reply.text));
    } catch (e) { throw new HttpException({ message: `Sem resposta da SEFAZ: ${(e as Error).message}`, code: 'UNAVAILABLE' }, HttpStatus.BAD_GATEWAY); }
    return this.prisma.withContext(ctx, async (tx) => {
      await tx.$queryRaw`SELECT id FROM mdfe_documents WHERE id = ${id}::uuid AND tenant_id = ${ctx.tenantId}::uuid FOR UPDATE`;
      const cur = await tx.mdfeDocument.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId! } });
      let status = cur.status; const data: Prisma.MdfeDocumentUpdateInput = { statusCode: r.cStat, statusMessage: r.xMotivo };
      if (MDFE_AUTHORIZED.includes(r.cStat) && r.prot) {
        status = cur.status === 'PENDING_CONSULT' || cur.status === 'TRANSMITTING' ? 'AUTHORIZED' : cur.status;
        data.protocol = r.prot.protocol;
        if (cur.signedXml && !cur.authorizedXml) data.authorizedXml = mdfeProc(cur.signedXml, r.prot.raw);
      } else if (r.cancelled) status = 'CANCELLED';
      else if (r.closed) status = 'CLOSED';
      else if (['217', '236'].includes(r.cStat) && ['PENDING_CONSULT', 'TRANSMITTING'].includes(cur.status)) status = 'DRAFT'; // não consta: pode reenviar com a mesma numeração
      await tx.mdfeDocument.update({ where: { id }, data: { ...data, status } });
      await this.audit.record(tx, ctx, { action: 'mdfe.consulted', entity: 'mdfe', entityId: id, metadata: { cStat: r.cStat, status } });
      return { id, status, statusCode: r.cStat, message: r.xMotivo };
    });
  }

  private async sendEvent(pc: ProviderCtx, env: FiscalEnvironment, tp: '110111' | '110112', chave: string, det: string, cnpj: string) {
    const body = signXml(mdfeEvent({ tp, chave, env, cnpj, at: nowBrt(), det }), { keyPem: pc.certificate!.keyPem, certPem: pc.certificate!.certPem, tagToSign: 'infEvento', after: 'infEvento' });
    const check = await validateMdfe('eventoMDFe_v3.00.xsd', body);
    if (!check.valid) throw new ConflictException(`Evento fora do leiaute (não enviado): ${check.errors[0]?.message}`);
    const reply = await soapCall(mdfeService(pc.uf ?? '', env, 'evento').url, { operation: 'MDFeRecepcaoEvento', method: 'mdfeRecepcaoEvento' }, body, mtls(pc), 30_000, FLAVOR);
    const r = parseMdfeEvent(mdfeResultOf(reply.text));
    if (!r.event && !r.cStat) throw new HttpException({ message: 'Resposta inesperada do serviço de eventos. Consulte a situação antes de tentar de novo.', code: 'UNAVAILABLE' }, HttpStatus.BAD_GATEWAY);
    return r;
  }

  /** Encerramento (110112): informa o fim da viagem. Obrigatório depois da entrega; vale o município onde a carga foi descarregada por último. */
  async close(ctx: AuthContext, id: string) {
    const { d, pc } = await this.loadForCall(ctx, id, (s) => s === 'AUTHORIZED', 'Só um MDF-e autorizado pode ser encerrado.');
    const payload = d.payload as unknown as Payload;
    const last = payload.unload[payload.unload.length - 1];
    if (!last) throw new ConflictException('MDF-e sem município de descarga.');
    const r = await this.sendEvent(pc, d.environment as FiscalEnvironment, '110112', d.accessKey!, closeDetail(d.protocol ?? '', localToday(), last.cMun.slice(0, 2), last.cMun), payload.emitter.cnpj);
    const done = await this.prisma.withContext(ctx, async (tx) => {
      const ok = !!r.event && MDFE_EVENT_OK.includes(r.event.cStat);
      if (ok) await tx.mdfeDocument.update({ where: { id }, data: { status: 'CLOSED', closeProtocol: r.event!.protocol, statusCode: r.event!.cStat, statusMessage: r.event!.xMotivo } });
      await this.audit.record(tx, ctx, { action: ok ? 'mdfe.closed' : 'mdfe.close_failed', entity: 'mdfe', entityId: id, metadata: { cStat: r.event?.cStat ?? r.cStat } });
      return ok;
    });
    if (!done) throw new ConflictException(`Encerramento recusado (${r.event?.cStat ?? r.cStat}): ${r.event?.xMotivo ?? r.xMotivo}`);
    return { id, status: 'CLOSED' as const, protocol: r.event!.protocol };
  }

  /** Cancelamento (110111), com justificativa de 15 a 255 caracteres. Prazo e regras são da SEFAZ (em geral 24 h após a autorização). */
  async cancel(ctx: AuthContext, id: string, reason: string) {
    const { d, pc } = await this.loadForCall(ctx, id, (s) => s === 'AUTHORIZED', 'Só um MDF-e autorizado (e ainda não encerrado) pode ser cancelado.');
    const payload = d.payload as unknown as Payload;
    const r = await this.sendEvent(pc, d.environment as FiscalEnvironment, '110111', d.accessKey!, cancelDetail(d.protocol ?? '', reason), payload.emitter.cnpj);
    const done = await this.prisma.withContext(ctx, async (tx) => {
      const ok = !!r.event && MDFE_EVENT_OK.includes(r.event.cStat);
      if (ok) await tx.mdfeDocument.update({ where: { id }, data: { status: 'CANCELLED', cancelProtocol: r.event!.protocol, statusCode: r.event!.cStat, statusMessage: reason.trim() } });
      await this.audit.record(tx, ctx, { action: ok ? 'mdfe.cancelled' : 'mdfe.cancel_failed', entity: 'mdfe', entityId: id, metadata: { cStat: r.event?.cStat ?? r.cStat, reason } });
      return ok;
    });
    if (!done) throw new ConflictException(`Cancelamento recusado (${r.event?.cStat ?? r.cStat}): ${r.event?.xMotivo ?? r.xMotivo}`);
    return { id, status: 'CANCELLED' as const };
  }
}

@Controller('fiscal/mdfe')
export class MdfeController {
  constructor(private readonly svc: MdfeService) {}

  @Get() @RequirePermissions('fiscal.view')
  list(@CurrentAuth() ctx: AuthContext) { return this.svc.list(ctx); }

  @Get('routes') @RequirePermissions('fiscal.view')
  routes(@CurrentAuth() ctx: AuthContext) { return this.svc.eligibleRoutes(ctx); }

  @Post('prepare') @HttpCode(200) @RequirePermissions('fiscal.emit')
  prepare(@CurrentAuth() ctx: AuthContext, @Body() dto: IdDto) { return this.svc.prepare(ctx, dto.routeId); }

  @Get(':id') @RequirePermissions('fiscal.view')
  get(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.get(ctx, id); }

  @Get(':id/xml') @RequirePermissions('fiscal.view')
  async xml(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { const f = await this.svc.xml(ctx, id); return { name: f.name, xml: f.content.toString('utf8') }; }

  @Post(':id/transmit') @HttpCode(200) @RequirePermissions('fiscal.emit')
  transmit(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.transmit(ctx, id); }

  @Post(':id/consult') @HttpCode(200) @RequirePermissions('fiscal.emit')
  consult(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.consult(ctx, id); }

  @Post(':id/close') @HttpCode(200) @RequirePermissions('fiscal.emit')
  close(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.close(ctx, id); }

  @Post(':id/cancel') @HttpCode(200) @RequirePermissions('fiscal.emit')
  cancel(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) { return this.svc.cancel(ctx, id, dto.reason); }
}
void MaxLength; void BadRequestException; void verifySignature;
