import { BadGatewayException, ConflictException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthContext } from '../common/auth';
import { PrismaService } from '../prisma/prisma.service';

/**
 * WhatsApp pela Evolution API (EVOLUTION_API_URL + EVOLUTION_API_KEY, chave global do servidor). Cada empresa tem a sua instância
 * ("dh-<id da empresa>"), pareada lendo um QR code. Endpoints da Evolution v2 conferidos só em guias de terceiros: ajuste na primeira conexão real.
 * O sistema NÃO guarda o número do cliente além do cadastro e só envia avisos que a empresa ligou, para clientes que não pediram para sair.
 */
export type WaState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED';
export type SendResult = { ok: true } | { ok: false; reason: string; retryable: boolean };

/** Número para a Evolution: só dígitos, com 55 na frente (aceita 10/11 dígitos com DDD, ou já com 55). */
export function waNumber(phone: string | null | undefined): string | null {
  const d = (phone ?? '').replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) return `55${d}`;
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) return d;
  return null;
}

@Injectable()
export class WhatsappService {
  private readonly log = new Logger(WhatsappService.name);
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  configured(): boolean { return !!process.env.EVOLUTION_API_URL && !!process.env.EVOLUTION_API_KEY; }
  private instanceOf(tenantId: string) { return `dh-${tenantId}`; }

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    if (!this.configured()) throw new ServiceUnavailableException('WhatsApp não configurado no servidor (EVOLUTION_API_URL e EVOLUTION_API_KEY).');
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 20_000);
    try {
      const res = await fetch(`${process.env.EVOLUTION_API_URL!.replace(/\/$/, '')}${path}`, {
        method, signal: ctl.signal, headers: { 'content-type': 'application/json', apikey: process.env.EVOLUTION_API_KEY! }, body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 300) }; }
      return { status: res.status, json };
    } catch (e) {
      throw new BadGatewayException(`Sem resposta do servidor de WhatsApp: ${(e as Error).name === 'AbortError' ? 'demorou demais' : (e as Error).message}`);
    } finally { clearTimeout(timer); }
  }

  private fromState(s: unknown): WaState { return s === 'open' ? 'CONNECTED' : s === 'connecting' ? 'CONNECTING' : 'DISCONNECTED'; }

  /** Situação gravada, atualizada na Evolution quando há instância. */
  async status(ctx: AuthContext) {
    const row = await this.prisma.withContext(ctx, (tx) => tx.whatsappConnection.findUnique({ where: { tenantId: ctx.tenantId! } }));
    if (!this.configured()) return { configured: false, status: 'DISCONNECTED' as WaState, phone: null, lastError: null };
    if (!row) return { configured: true, status: 'DISCONNECTED' as WaState, phone: null, lastError: null };
    let state: WaState = row.status as WaState; let lastError: string | null = row.lastError;
    try {
      const r = await this.call('GET', `/instance/connectionState/${encodeURIComponent(row.instanceName)}`);
      if (r.status === 404) state = 'DISCONNECTED';
      else if (r.status < 300) { state = this.fromState(r.json?.instance?.state ?? r.json?.state); lastError = null; }
      else lastError = `Evolution respondeu ${r.status}`;
    } catch (e) { lastError = (e as Error).message; }
    let phone = row.phone;
    if (state === 'CONNECTED' && !phone) phone = await this.ownerPhone(row.instanceName);
    if (state !== row.status || lastError !== row.lastError || phone !== row.phone) {
      await this.prisma.withContext(ctx, (tx) => tx.whatsappConnection.update({ where: { tenantId: ctx.tenantId! }, data: { status: state, lastError, phone: state === 'CONNECTED' ? phone : null, connectedAt: state === 'CONNECTED' && row.status !== 'CONNECTED' ? new Date() : row.connectedAt } }));
    }
    return { configured: true, status: state, phone: state === 'CONNECTED' ? phone : null, lastError };
  }

  private async ownerPhone(instance: string): Promise<string | null> {
    try {
      const r = await this.call('GET', `/instance/fetchInstances?instanceName=${encodeURIComponent(instance)}`);
      const one = Array.isArray(r.json) ? r.json[0] : r.json;
      const jid: string | undefined = one?.ownerJid ?? one?.instance?.owner ?? one?.owner;
      return jid ? jid.split('@')[0].replace(/\D/g, '') || null : null;
    } catch { return null; }
  }

  /** Cria a instância (se preciso) e devolve o QR code para ler no celular (WhatsApp → Aparelhos conectados). */
  async connect(ctx: AuthContext) {
    if (!this.configured()) throw new ServiceUnavailableException('WhatsApp não configurado no servidor (EVOLUTION_API_URL e EVOLUTION_API_KEY).');
    const name = this.instanceOf(ctx.tenantId!);
    const current = await this.status(ctx);
    if (current.status === 'CONNECTED') throw new ConflictException('O WhatsApp já está conectado. Desconecte antes de ler um novo QR code.');
    const created = await this.call('POST', '/instance/create', { instanceName: name, qrcode: true, integration: 'WHATSAPP-BAILEYS' });
    if (created.status >= 400 && !/already|in use|exist/i.test(JSON.stringify(created.json ?? ''))) throw new BadGatewayException(`Não foi possível criar a instância no servidor de WhatsApp (${created.status}).`);
    const qr = await this.call('GET', `/instance/connect/${encodeURIComponent(name)}`);
    const base64: string | undefined = qr.json?.base64 ?? created.json?.qrcode?.base64;
    if (qr.status >= 400 || !base64) throw new BadGatewayException('O servidor de WhatsApp não devolveu o QR code. Tente de novo em instantes.');
    await this.prisma.withContext(ctx, async (tx) => {
      await tx.whatsappConnection.upsert({ where: { tenantId: ctx.tenantId! }, create: { tenantId: ctx.tenantId!, instanceName: name, status: 'CONNECTING' }, update: { status: 'CONNECTING', lastError: null } });
      await this.audit.record(tx, ctx, { action: 'whatsapp.connect_started', entity: 'whatsapp_connection' });
    });
    return { status: 'CONNECTING' as WaState, qr: base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`, pairingCode: qr.json?.pairingCode ?? null };
  }

  async disconnect(ctx: AuthContext) {
    const row = await this.prisma.withContext(ctx, (tx) => tx.whatsappConnection.findUnique({ where: { tenantId: ctx.tenantId! } }));
    if (!row) return { status: 'DISCONNECTED' as WaState };
    if (this.configured()) {
      const r = await this.call('DELETE', `/instance/logout/${encodeURIComponent(row.instanceName)}`);
      if (r.status >= 400 && r.status !== 404 && !/not connected|close/i.test(JSON.stringify(r.json ?? ''))) throw new BadGatewayException(`O servidor de WhatsApp recusou desconectar (${r.status}).`);
    }
    await this.prisma.withContext(ctx, async (tx) => {
      await tx.whatsappConnection.update({ where: { tenantId: ctx.tenantId! }, data: { status: 'DISCONNECTED', phone: null, connectedAt: null } });
      await this.audit.record(tx, ctx, { action: 'whatsapp.disconnected', entity: 'whatsapp_connection' });
    });
    return { status: 'DISCONNECTED' as WaState };
  }

  /** Envio de texto. Nunca lança: o chamador grava o resultado no histórico. */
  async sendText(tenantId: string, phone: string | null, text: string): Promise<SendResult> {
    const number = waNumber(phone);
    if (!number) return { ok: false, reason: 'Telefone do cliente inválido para WhatsApp.', retryable: false };
    if (!this.configured()) return { ok: false, reason: 'WhatsApp não configurado no servidor.', retryable: false };
    const row = await this.prisma.withContext({ tenantId }, (tx) => tx.whatsappConnection.findUnique({ where: { tenantId } }));
    if (!row || row.status !== 'CONNECTED') return { ok: false, reason: 'WhatsApp da empresa não está conectado.', retryable: false };
    try {
      const r = await this.call('POST', `/message/sendText/${encodeURIComponent(row.instanceName)}`, { number, text });
      if (r.status < 300) return { ok: true };
      if (r.status === 401 || r.status === 403 || r.status === 404) {
        await this.prisma.withContext({ tenantId }, (tx) => tx.whatsappConnection.update({ where: { tenantId }, data: { status: 'DISCONNECTED', lastError: `Evolution respondeu ${r.status}` } }));
        return { ok: false, reason: `WhatsApp desconectado (${r.status}). Leia o QR code de novo.`, retryable: false };
      }
      return { ok: false, reason: `Evolution respondeu ${r.status}: ${JSON.stringify(r.json ?? '').slice(0, 160)}`, retryable: r.status >= 500 || r.status === 429 };
    } catch (e) {
      this.log.warn(`falha ao enviar WhatsApp tenant=${tenantId}: ${(e as Error).message}`);
      return { ok: false, reason: (e as Error).message, retryable: true };
    }
  }
}
