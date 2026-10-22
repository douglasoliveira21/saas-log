// Horário de corte das vendas fora de marketplace: o pedido confirmado antes do corte sai no mesmo dia útil; depois do corte (ou em
// fim de semana, se só dias úteis), na próxima data de saída. Fuso fixo America/Sao_Paulo (UTC-3, sem horário de verão desde 2019).
// Feriados NÃO são considerados (não há calendário de feriados no sistema).

const TZ = 'America/Sao_Paulo';
const DAY = 86_400_000;

export const CUTOFF_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

interface Local { date: string; minutes: number }

function localOf(d: Date): Local {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const isWeekend = (iso: string) => [0, 6].includes(new Date(`${iso}T12:00:00Z`).getUTCDay());

export interface Dispatch {
  /** Data local (AAAA-MM-DD) em que o pedido confirmado agora deve sair. */
  dispatchDate: string;
  /** Verdadeiro quando a saída fica depois do dia da venda (passou do corte ou caiu em fim de semana). */
  deferred: boolean;
  /** Data local da venda. */
  today: string;
}

/** `cutoff` no formato HH:MM. Antes do horário (estritamente) sai no mesmo dia; a partir dele, no próximo. */
export function computeDispatch(now: Date, cutoff: string, businessDaysOnly: boolean): Dispatch {
  if (!CUTOFF_RE.test(cutoff)) throw new Error('Horário de corte inválido.');
  const [h, m] = cutoff.split(':').map(Number);
  const l = localOf(now);
  let date = l.minutes >= h * 60 + m ? addDays(l.date, 1) : l.date;
  if (businessDaysOnly) while (isWeekend(date)) date = addDays(date, 1);
  return { dispatchDate: date, deferred: date > l.date, today: l.date };
}

/** Data local de hoje (AAAA-MM-DD), para comparar com datas de saída. */
export const localToday = (now = new Date()) => localOf(now).date;
export const asDateColumn = (iso: string) => new Date(`${iso}T00:00:00Z`);
