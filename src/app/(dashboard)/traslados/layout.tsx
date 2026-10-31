import { requireRole } from '@/lib/auth/guard';

// Guard de Traslados: dueño y cajeros (los que envían y reciben mercancía).
// El vendedor y el rol consulta vuelven a su pantalla. El RPC revalida rol y
// tienda: esto solo evita mostrar una pantalla que no les sirve.
export default async function TrasladosLayout({ children }: { children: React.ReactNode }) {
  await requireRole(['owner', 'cashier']);
  return <>{children}</>;
}
