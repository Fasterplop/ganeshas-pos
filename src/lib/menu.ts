// El menú de la app: una sola lista para el menú lateral (computadora) y la
// barra de arriba (teléfono).
//
// Pedido de Gerardo (23-nov-2026, con su dibujo «Menú compacto»):
//   * El dueño ve arriba Reportes, Registro de ventas e Inventario, y debajo
//     tres grupos que se abren al tocarlos: Clientes y cobros, Productos y
//     Administración.
//   * Los empleados ven su lista de siempre, ahora con su ícono («solo las
//     figuras se ve bien»).

import type { LucideIcon } from 'lucide-react';
import {
  BadgePercent,
  Box,
  ChartNoAxesColumn,
  Contact,
  HandCoins,
  Package,
  ScanSearch,
  Settings,
  ShoppingCart,
  Sparkles,
  Tag,
  Truck,
  UserCog,
  Users,
  Wallet,
} from 'lucide-react';
import type { AppRole } from '@/lib/roles';

export type MenuItem = {
  name: string;
  path: string;
  roles: AppRole[];
  icon: LucideIcon;
};

// En el orden de siempre (el de la lista de los empleados y del teléfono).
export const MENU_ITEMS: MenuItem[] = [
  { name: 'Reportes', path: '/dashboard', roles: ['owner', 'cashier'], icon: ChartNoAxesColumn },
  { name: 'Novedades', path: '/novedades', roles: ['owner'], icon: Sparkles },
  { name: 'Registro de Ventas', path: '/pos', roles: ['owner', 'cashier', 'vendedor'], icon: ShoppingCart },
  // Solo con el permiso de fiar (canFiar), el mismo que enciende «Fiado» en la caja.
  { name: 'Cuentas por cobrar', path: '/cuentas-por-cobrar', roles: ['owner', 'cashier', 'vendedor'], icon: HandCoins },
  { name: 'Inventario', path: '/inventory', roles: ['owner', 'cashier'], icon: Package },
  { name: 'Traslados', path: '/traslados', roles: ['owner', 'cashier'], icon: Truck },
  { name: 'Clientes', path: '/customers', roles: ['owner', 'cashier'], icon: Contact },
  { name: 'Consultar precio', path: '/consultar-precio', roles: ['owner', 'cashier', 'vendedor', 'consulta'], icon: ScanSearch },
  { name: 'Etiquetas', path: '/labels', roles: ['owner', 'cashier'], icon: Tag },
  { name: 'Ofertas', path: '/ofertas', roles: ['owner'], icon: BadgePercent },
  { name: 'Finanzas', path: '/finanzas', roles: ['owner'], icon: Wallet },
  { name: 'Usuarios', path: '/users', roles: ['owner'], icon: UserCog },
];

// Menú compacto del dueño: lo de arriba, suelto; lo demás, en grupos.
export const MENU_TOP_PATHS = ['/dashboard', '/pos', '/inventory'];

export type MenuGroup = { id: string; name: string; icon: LucideIcon; paths: string[] };
export const MENU_GROUPS: MenuGroup[] = [
  { id: 'clientes', name: 'Clientes y cobros', icon: Users, paths: ['/customers', '/cuentas-por-cobrar'] },
  { id: 'productos', name: 'Productos', icon: Box, paths: ['/novedades', '/traslados', '/consultar-precio', '/labels', '/ofertas'] },
  { id: 'admin', name: 'Administración', icon: Settings, paths: ['/finanzas', '/users'] },
];

/** Lo que este usuario puede ver, en el orden de MENU_ITEMS. */
export function visibleMenu(role: AppRole, canFiar?: boolean): MenuItem[] {
  return MENU_ITEMS.filter(item =>
    item.roles.includes(role) && (item.path !== '/cuentas-por-cobrar' || !!canFiar));
}

/** ¿Esta página es la de este ítem? (también sus subpáginas, p. ej. /finanzas/cajas) */
export function isMenuActive(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(`${path}/`);
}
