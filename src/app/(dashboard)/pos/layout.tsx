import { requireRole } from '@/lib/auth/guard';

// Guard de la caja: dueño, cajero y vendedor.
//
// El rol `consulta` (teléfono del piso de venta) solo entra a
// /consultar-precio: acá se lo devuelve a su pantalla. Antes esta ruta no
// tenía ningún guard y bastaba con escribir la URL para entrar.
//
// El rol `vendedor` consulta precios y cobra: de las pantallas del cajero
// esta es la única a la que entra. Que pueda COBRAR no depende de este guard
// sino de la base (db/role_vendedor.sql: sus políticas y los RPC de la caja).
export default async function PosLayout({ children }: { children: React.ReactNode }) {
  await requireRole(['owner', 'cashier', 'vendedor']);
  return <>{children}</>;
}
