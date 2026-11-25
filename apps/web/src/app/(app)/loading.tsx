import { Skeleton } from '@/components/ui';

/** Mostrado na hora ao trocar de tela, enquanto o JavaScript da próxima página chega. */
export default function Loading() {
  return <div className="card" style={{ padding: 16 }}><Skeleton rows={6} /></div>;
}
