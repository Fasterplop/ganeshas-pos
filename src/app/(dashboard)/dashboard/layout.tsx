import { requireRole } from '@/lib/auth/guard';

// Guard de Reportes: solo dueño y cajero (el cajero ve una versión recortada).
//
// El rol `consulta` (teléfono del piso de venta) solo entra a
// /consultar-precio: acá se lo devuelve a su pantalla. Antes esta ruta no
// tenía ningún guard y bastaba con escribir la URL para entrar.
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  await requireRole(['owner', 'cashier']);
  return <>{children}</>;
}
