import { requireRole } from '@/lib/auth/guard';

// Guard de Clientes: solo dueño y cajero.
//
// El rol `consulta` (teléfono del piso de venta) solo entra a
// /consultar-precio: acá se lo devuelve a su pantalla. Antes esta ruta no
// tenía ningún guard y bastaba con escribir la URL para entrar.
export default async function CustomersLayout({ children }: { children: React.ReactNode }) {
  await requireRole(['owner', 'cashier']);
  return <>{children}</>;
}
