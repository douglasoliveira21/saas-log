import { Injectable, Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { getConfig } from '../config/app.config';

export interface MailAttachment { filename: string; content: Buffer; contentType: string }
export interface MailMessage { to: string; subject: string; text: string; html?: string; fromName?: string; attachments?: MailAttachment[] }
export type MailResult = { ok: true } | { ok: false; reason: string; retryable: boolean };

/**
 * Envio de e-mail por SMTP (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_SECURE). Sem SMTP configurado nada é enviado:
 * quem chama recebe `ok: false` e mostra o motivo (o sistema nunca finge que enviou). Em NODE_ENV=test as mensagens vão para `Mailer.outbox`.
 */
@Injectable()
export class Mailer {
  static outbox: MailMessage[] = [];
  /** Teste: simula falha do servidor de e-mail. */
  static failNext: string | null = null;
  private readonly log = new Logger(Mailer.name);
  private transport: Transporter | null = null;

  configured(): boolean { return process.env.NODE_ENV === 'test' || !!process.env.SMTP_HOST; }

  async send(m: MailMessage): Promise<MailResult> {
    if (process.env.NODE_ENV === 'test') {
      if (Mailer.failNext) { const reason = Mailer.failNext; Mailer.failNext = null; return { ok: false, reason, retryable: true }; }
      Mailer.outbox.push(m); return { ok: true };
    }
    if (!process.env.SMTP_HOST) return { ok: false, reason: 'E-mail não configurado no servidor (SMTP_HOST).', retryable: false };
    try {
      this.transport ??= createTransport({
        host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT ?? 587), secure: process.env.SMTP_SECURE === 'true',
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? '' } : undefined,
      });
      const from = process.env.SMTP_FROM ?? process.env.SMTP_USER ?? 'nao-responda@localhost';
      await this.transport.sendMail({ from: m.fromName ? `"${m.fromName.replace(/"/g, '')}" <${from.replace(/^.*<|>.*$/g, '')}>` : from, to: m.to, subject: m.subject, text: m.text, html: m.html, attachments: m.attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })) });
      return { ok: true };
    } catch (e) {
      this.log.warn(`falha ao enviar e-mail: ${(e as Error).message}`);
      return { ok: false, reason: `Falha no servidor de e-mail: ${(e as Error).message}`.slice(0, 300), retryable: true };
    }
  }

  /** Link para uma tela do sistema (usa WEB_ORIGIN). */
  link(path: string): string { return `${getConfig().webOrigin.replace(/\/$/, '')}${path}`; }
}

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Corpo HTML simples com um botão; o texto puro acompanha sempre. */
export function actionMail(appName: string, greeting: string, lines: string[], action: { label: string; url: string }): { text: string; html: string } {
  const text = `${greeting}\n\n${lines.join('\n\n')}\n\n${action.label}: ${action.url}\n\n— ${appName}`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:520px"><p>${esc(greeting)}</p>${lines.map((l) => `<p>${esc(l)}</p>`).join('')}<p><a href="${esc(action.url)}" style="background:#1d4ed8;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">${esc(action.label)}</a></p><p style="color:#666;font-size:12px">Se o botão não abrir, copie o endereço: ${esc(action.url)}</p><p style="color:#666;font-size:12px">— ${esc(appName)}</p></div>`;
  return { text, html };
}

/** Corpo HTML dos avisos ao cliente: cabeçalho com o nome da empresa, o texto em parágrafos e, se houver, a lista de anexos. */
export function noticeMail(company: string, body: string, opts: { attachments?: string[]; action?: { label: string; url: string } } = {}): string {
  const paras = body.split(/\n{2,}|(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÂÊÔÃÕÇ])/).map((p) => p.trim()).filter(Boolean);
  const files = opts.attachments?.length ? `<p style="margin:16px 0 0;padding:10px 12px;background:#f4f6f8;border-radius:6px;font-size:13px">📎 Em anexo: ${opts.attachments.map(esc).join(', ')}</p>` : '';
  const btn = opts.action ? `<p style="margin:18px 0 0"><a href="${esc(opts.action.url)}" style="background:#076b60;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">${esc(opts.action.label)}</a></p>` : '';
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;color:#142436"><div style="padding:14px 18px;background:#076b60;color:#fff;border-radius:8px 8px 0 0;font-weight:600">${esc(company)}</div><div style="padding:18px;border:1px solid #e1ebef;border-top:0;border-radius:0 0 8px 8px">${paras.map((p) => `<p style="margin:0 0 10px;line-height:1.5">${esc(p)}</p>`).join('')}${files}${btn}</div><p style="color:#7a8a96;font-size:11px;text-align:center;margin-top:10px">Mensagem automática enviada por ${esc(company)}.</p></div>`;
}
