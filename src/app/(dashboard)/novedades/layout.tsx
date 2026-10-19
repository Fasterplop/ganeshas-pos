import { requireRole } from '@/lib/auth/guard';

// Novedades: subidas de precio y transferencias con su motivo. Solo el dueño.
// Las políticas de price_changes (db/novedades_01…sql) son la capa que de
// verdad protege los datos; esto evita pintar la pantalla a otro rol.
export default async function NovedadesLayout({ children }: { children: React.ReactNode }) {
  await requireRole(['owner']);
  return <>{children}</>;
}
