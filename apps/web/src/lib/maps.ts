/** Link do Google Maps com todas as paradas (até 10: limite do link). Parte da localização atual de quem abre. */
export function routeMapUrl(addresses: string[]): string | null {
  const list = addresses.filter((a) => a && a !== 'Endereço não informado').slice(0, 10);
  if (!list.length) return null;
  const q = new URLSearchParams({ api: '1', travelmode: 'driving', destination: list[list.length - 1] });
  if (list.length > 1) q.set('waypoints', list.slice(0, -1).join('|'));
  return `https://www.google.com/maps/dir/?${q.toString()}`;
}

/** Navegação até um único endereço. */
export const stopMapUrl = (address: string) => (address && address !== 'Endereço não informado' ? `https://www.google.com/maps/dir/?${new URLSearchParams({ api: '1', travelmode: 'driving', destination: address })}` : null);
