import { BadRequestException, Controller, Get, Injectable, NotFoundException, Param, ServiceUnavailableException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { RequirePermissions } from '../common/auth';
import { isValidCnpj } from '../common/cnpj';
import { CepInfo, CnpjInfo, mapBrasilApiCep, mapBrasilApiCnpj, mapViaCep, onlyDigits } from './lookup';

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE = 500;
const TIMEOUT_MS = 8000;

/**
 * Consulta a dados públicos (CNPJ e CEP) por APIs de terceiros, SEMPRE pelo servidor: o navegador não fala com elas
 * (sem CORS, sem expor o IP do usuário, com cache e limite de taxa). Só dados públicos trafegam: o número consultado.
 * Se o serviço externo cair, o cadastro continua possível manualmente.
 */
@Injectable()
export class LookupService {
  private readonly cache = new Map<string, { at: number; value: unknown }>();
  private readonly base = () => ({
    brasilapi: (process.env.LOOKUP_BRASILAPI_BASE ?? 'https://brasilapi.com.br').replace(/\/$/, ''),
    viacep: (process.env.LOOKUP_VIACEP_BASE ?? 'https://viacep.com.br').replace(/\/$/, ''),
  });

  private cached<T>(key: string): T | undefined {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;
    this.cache.delete(key);
    return undefined;
  }
  private remember(key: string, value: unknown) {
    if (this.cache.size >= MAX_CACHE) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(key, { at: Date.now(), value });
  }

  /** GET com timeout. Retorna null para 404; lança para indisponibilidade (timeout, 5xx, 429, rede). */
  private async getJson(url: string): Promise<Record<string, unknown> | null> {
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json', 'user-agent': 'distribuihub-erp' } });
    } catch {
      throw new ServiceUnavailableException('O serviço de consulta não respondeu. Preencha manualmente ou tente de novo em instantes.');
    }
    if (res.status === 404 || res.status === 400) return null;
    if (!res.ok) throw new ServiceUnavailableException('O serviço de consulta está indisponível no momento. Preencha manualmente ou tente de novo em instantes.');
    try {
      return (await res.json()) as Record<string, unknown>;
    } catch {
      throw new ServiceUnavailableException('Resposta inválida do serviço de consulta.');
    }
  }

  async cnpj(input: string): Promise<CnpjInfo> {
    const digits = onlyDigits(input);
    if (!isValidCnpj(digits)) throw new BadRequestException('CNPJ inválido (confira os dígitos).');
    const hit = this.cached<CnpjInfo>(`cnpj:${digits}`);
    if (hit) return hit;
    const raw = await this.getJson(`${this.base().brasilapi}/api/cnpj/v1/${digits}`);
    if (!raw) throw new NotFoundException('CNPJ não encontrado na base pública da Receita Federal.');
    const info = mapBrasilApiCnpj(raw);
    if (!info.legalName) throw new ServiceUnavailableException('Resposta incompleta do serviço de consulta.');
    this.remember(`cnpj:${digits}`, info);
    return info;
  }

  async cep(input: string): Promise<CepInfo> {
    const digits = onlyDigits(input);
    if (digits.length !== 8) throw new BadRequestException('CEP inválido: informe 8 dígitos.');
    const hit = this.cached<CepInfo>(`cep:${digits}`);
    if (hit) return hit;
    let found: CepInfo | null = null;
    let unavailable = false;
    try {
      const r = await this.getJson(`${this.base().brasilapi}/api/cep/v2/${digits}`);
      if (r) found = mapBrasilApiCep(r);
    } catch { unavailable = true; }
    if (!found) { // segunda fonte: ViaCEP (também cobre quando a primeira não conhece o CEP)
      try {
        const r = await this.getJson(`${this.base().viacep}/ws/${digits}/json/`);
        if (r) found = mapViaCep(r);
        unavailable = false;
      } catch { /* mantém o estado anterior */ unavailable = unavailable || true; }
    }
    if (!found) {
      if (unavailable) throw new ServiceUnavailableException('O serviço de consulta de CEP está indisponível. Preencha o endereço manualmente.');
      throw new NotFoundException('CEP não encontrado.');
    }
    this.remember(`cep:${digits}`, found);
    return found;
  }
}

@Controller('lookup')
export class LookupController {
  constructor(private readonly svc: LookupService) {}

  @Get('cnpj/:cnpj') @RequirePermissions('company.view') @Throttle({ default: { limit: 20, ttl: 60_000 } })
  cnpj(@Param('cnpj') cnpj: string) { return this.svc.cnpj(cnpj); }

  @Get('cep/:cep') @RequirePermissions('company.view') @Throttle({ default: { limit: 40, ttl: 60_000 } })
  cep(@Param('cep') cep: string) { return this.svc.cep(cep); }
}
