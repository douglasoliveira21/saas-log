import { Injectable } from '@nestjs/common';

/**
 * Código IBGE do município (cMun/cMunFG da NF-e) a partir de cidade + UF, pela API oficial de localidades do IBGE
 * (servicodados.ibge.gov.br). A lista de cada UF é buscada FORA de transação e guardada em memória por 24 h; a consulta usada dentro da
 * transação (`lookup`) é só leitura do cache. Nome ambíguo ou desconhecido ⇒ null (a nota fica pendente, nada é presumido).
 */
const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

@Injectable()
export class IbgeService {
  private cache = new Map<string, { at: number; names: Map<string, string | null> }>();
  private base = () => (process.env.IBGE_API_BASE ?? 'https://servicodados.ibge.gov.br').replace(/\/$/, '');

  /** Busca (e guarda) os municípios de uma UF. Falha de rede não derruba nada: o código fica indisponível e a validação avisa. */
  async warm(uf: string | null | undefined): Promise<void> {
    const key = (uf ?? '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(key)) return;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 24 * 3_600_000) return;
    try {
      const res = await fetch(`${this.base()}/api/v1/localidades/estados/${key}/municipios`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return;
      const rows = (await res.json()) as { id: number; nome: string }[];
      const names = new Map<string, string | null>();
      for (const r of rows) { const n = norm(r.nome); names.set(n, names.has(n) ? null : String(r.id)); } // duplicado ⇒ ambíguo
      this.cache.set(key, { at: Date.now(), names });
    } catch { /* sem cache: lookup devolve null */ }
  }

  lookup(city: string | null | undefined, uf: string | null | undefined): string | null {
    if (!city || !uf) return null;
    return this.cache.get(uf.toUpperCase())?.names.get(norm(city)) ?? null;
  }
}
