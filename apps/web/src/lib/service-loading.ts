const pending = new Map<symbol, { message: string; fiscal: boolean }>();
const listeners = new Set<() => void>();

export function subscribeToServiceLoading(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getServiceLoadingMessage() {
  const operations = [...pending.values()];
  return operations.find((operation) => operation.fiscal)?.message ?? operations[0]?.message ?? null;
}

export function startServiceLoading(message = 'Processando solicitação…', fiscal = false) {
  if (typeof window === 'undefined') return;

  const id = Symbol();
  const show = () => {
    pending.set(id, { message, fiscal });
    listeners.forEach((listener) => listener());
  };
  const timer = fiscal ? undefined : window.setTimeout(show, 250);
  if (fiscal) show();

  return () => {
    window.clearTimeout(timer);
    if (pending.delete(id)) listeners.forEach((listener) => listener());
  };
}
