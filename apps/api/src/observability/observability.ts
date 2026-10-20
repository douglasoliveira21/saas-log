import { ArgumentsHost, Catch, Controller, ExceptionFilter, Get, HttpException, HttpStatus, Logger, NotFoundException, Res, Req, ServiceUnavailableException } from '@nestjs/common';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { Public } from '../common/auth';
import { PrismaService } from '../prisma/prisma.service';

// ───────────── métricas em memória (por processo) ─────────────
const BUCKETS = [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const counters = new Map<string, number>();
const hist = new Map<string, { buckets: number[]; sum: number; count: number }>();
const startedAt = Date.now();

export function resetMetrics() { counters.clear(); hist.clear(); }

function inc(key: string, by = 1) { counters.set(key, (counters.get(key) ?? 0) + by); }
function observe(key: string, seconds: number) {
  const h = hist.get(key) ?? { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
  BUCKETS.forEach((b, i) => { if (seconds <= b) h.buckets[i]++; });
  h.sum += seconds; h.count++;
  hist.set(key, h);
}

/** Rota normalizada (sem IDs nem query string): evita cardinalidade explosiva e vazamento de dados em métricas/logs. */
export function routeLabel(path: string): string {
  return path.split('?')[0]
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\/\d+(?=\/|$)/g, '/:n')
    .replace(/(\/webhooks\/):id\/:id/, '$1:tenant/:connection');
}

const log = new Logger('http');
const asJson = (o: Record<string, unknown>) => JSON.stringify(o);

/** Correlation id (aceita o do proxy, se válido), medição e log estruturado sem corpo, query, cookies nem cabeçalhos. */
export function requestObserver(req: Request, res: Response, next: NextFunction) {
  const incoming = req.headers['x-request-id'];
  const id = typeof incoming === 'string' && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  (req as Request & { requestId?: string }).requestId = id;
  res.setHeader('x-request-id', id);
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
    const route = routeLabel(req.originalUrl);
    const status = res.statusCode;
    inc(`http_requests_total{method="${req.method}",status="${Math.floor(status / 100)}xx"}`);
    observe('http_request_duration_seconds', seconds);
    if (status >= 500) inc('http_errors_total');
    if (process.env.NODE_ENV === 'test' || route === '/api/health' || route === '/api/metrics') return;
    const auth = (req as Request & { auth?: { tenantId: string | null; userId: string } }).auth;
    const line = asJson({ ts: new Date().toISOString(), level: status >= 500 ? 'error' : 'info', reqId: id, method: req.method, route, status, ms: Math.round(seconds * 1000), tenantId: auth?.tenantId ?? undefined, userId: auth?.userId ?? undefined });
    process.stdout.write(line + '\n');
  });
  next();
}

/** Erros inesperados: log com correlation id; o cliente recebe mensagem genérica (sem stack, SQL ou caminhos). */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request & { requestId?: string }>();
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      const payload = typeof body === 'string' ? { statusCode: exception.getStatus(), message: body } : body;
      return res.status(exception.getStatus()).json({ ...(payload as object), requestId: req.requestId });
    }
    const err = exception as Error;
    inc('unhandled_exceptions_total');
    if (process.env.NODE_ENV !== 'test') process.stdout.write(asJson({ ts: new Date().toISOString(), level: 'error', reqId: req.requestId, route: routeLabel(req.originalUrl), error: err?.name, message: String(err?.message ?? '').slice(0, 300) }) + '\n');
    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ statusCode: 500, message: 'Erro interno. Informe o código da requisição ao suporte.', requestId: req.requestId });
  }
}

function tokenOk(header: string | undefined, expected: string): boolean {
  const given = Buffer.from((header ?? '').replace(/^Bearer /, ''));
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}

@Controller()
export class ObservabilityController {
  constructor(private readonly prisma: PrismaService) {}

  /** Pronto para receber tráfego: banco acessível e fila sem atraso grave. */
  @Public() @Get('health/ready')
  async ready() {
    const t0 = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({ status: 'down', checks: { database: 'fail' } });
    }
    const queue = await this.queue();
    const lagMs = queue.oldestReady ? Math.max(0, Date.now() - queue.oldestReady.getTime()) : 0;
    return { status: lagMs > 10 * 60_000 ? 'degraded' : 'ok', checks: { database: 'ok', dbMs: Date.now() - t0, queueLagSeconds: Math.round(lagMs / 1000), deadJobs: queue.dead } };
  }

  private async queue() {
    const rows = await this.prisma.$queryRaw<{ status: string; jobs: bigint; oldest_ready: Date | null }[]>`SELECT * FROM queue_stats()`;
    const pending = rows.filter((r) => r.status === 'QUEUED');
    const oldest = pending.map((r) => r.oldest_ready).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
    return { rows, oldestReady: oldest, dead: Number(rows.find((r) => r.status === 'DEAD')?.jobs ?? 0) };
  }

  /** Formato Prometheus. Desligado (404) sem METRICS_TOKEN; com token, exige `Authorization: Bearer`. */
  @Public() @Get('metrics')
  async metrics(@Req() req: Request, @Res() res: Response) {
    const token = process.env.METRICS_TOKEN;
    if (!token) throw new NotFoundException();
    if (!tokenOk(req.headers.authorization, token)) throw new HttpException('Não autorizado.', HttpStatus.UNAUTHORIZED);
    const out: string[] = ['# TYPE process_uptime_seconds gauge', `process_uptime_seconds ${Math.round((Date.now() - startedAt) / 1000)}`];
    for (const [k, v] of counters) out.push(`${k.includes('{') ? k : k} ${v}`);
    const h = hist.get('http_request_duration_seconds');
    if (h) {
      out.push('# TYPE http_request_duration_seconds histogram');
      BUCKETS.forEach((b, i) => out.push(`http_request_duration_seconds_bucket{le="${b}"} ${h.buckets[i]}`));
      out.push(`http_request_duration_seconds_bucket{le="+Inf"} ${h.count}`, `http_request_duration_seconds_sum ${h.sum}`, `http_request_duration_seconds_count ${h.count}`);
    }
    const q = await this.queue();
    out.push('# TYPE background_jobs gauge', ...q.rows.map((r) => `background_jobs{status="${r.status}"} ${Number(r.jobs)}`));
    res.type('text/plain; version=0.0.4').send(out.join('\n') + '\n');
  }
}
