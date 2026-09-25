import { requireRole } from '@/lib/auth/guard';

// Guard de la caja: solo dueño y cajero.
//
// El rol `consulta` (teléfono del piso de venta) solo entra a
// /consultar-precio: acá se lo devuelve a su pantalla. Antes esta ruta no
// tenía ningún guard y bastaba con escribir la URL para entrar.
export default async function PosLayout({ children }: { children: React.ReactNode }) {
  await requireRole(['owner', 'cashier']);
  return <>{children}</>;
}
