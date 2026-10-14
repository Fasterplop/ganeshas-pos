// Roles del sistema (`profiles.role`, enum `public.profile_role` en Supabase).
//
// Hasta ahora los literales 'owner' / 'cashier' estaban sueltos por todo el
// front, cada pantalla con su propia union de tipos. Con un tercer rol eso se
// vuelve imposible de auditar: basta olvidar un `else` para que el rol nuevo
// caiga en la rama del dueño. Todo vive acá.
//
// ⚠️ Agregar un rol NO es solo agregarlo a esta lista:
//    1. `ALTER TYPE public.profile_role ADD VALUE` (db/role_consulta_01_enum.sql),
//    2. decidir a qué rutas entra (ROLE_HOME + los `roles:` del menú),
//    3. ponerle un guard de servidor a las rutas que NO debe ver,
//    4. revisar los RPC `SECURITY DEFINER`, que son la única defensa real,
//    5. darle sus políticas RLS: en esta base un rol sin restricciones propias
//       queda, a nivel de tablas, igual que un cajero (db/role_vendedor.sql),
//    6. sumarlo a `tieneTiendaFija` si trabaja en una sucursal: sin eso el
//       StoreGuard no le fija la tienda y la caja no arranca.

export const APP_ROLES = ['owner', 'cashier', 'vendedor', 'consulta'] as const;
export type AppRole = (typeof APP_ROLES)[number];

/** Nombre que ve el dueño en la pantalla de Usuarios. */
export const ROLE_LABEL: Record<AppRole, string> = {
  owner: 'Dueño',
  cashier: 'Cajero',
  vendedor: 'Vendedor',
  consulta: 'Solo consultar precios',
};

/** Versión corta, para el badge de la tabla (va en mayúsculas y no puede crecer). */
export const ROLE_BADGE: Record<AppRole, string> = {
  owner: 'Dueño',
  cashier: 'Cajero',
  vendedor: 'Vendedor',
  consulta: 'Consulta',
};

/** Color del badge, para distinguir los tres roles de un vistazo. */
export const ROLE_BADGE_CLASS: Record<AppRole, string> = {
  owner: 'bg-purple-100 text-purple-700 border border-purple-200',
  cashier: 'bg-teal-50 text-teal-700 border border-teal-200',
  vendedor: 'bg-sky-50 text-sky-700 border border-sky-200',
  consulta: 'bg-amber-50 text-amber-700 border border-amber-200',
};

/** Una línea explicando qué puede hacer cada rol, para el formulario. */
export const ROLE_HELP: Record<AppRole, string> = {
  owner: 'Acceso a todo el sistema, incluidas Finanzas y Usuarios.',
  cashier: 'Caja, inventario, clientes, etiquetas y consulta de precios.',
  vendedor:
    'Consultar precio y Registro de Ventas: cobra, hace cambios de producto y trae productos de la otra tienda. No entra a inventario, clientes, etiquetas ni reportes.',
  consulta:
    'Solo la pantalla Consultar precio, para el teléfono del piso de venta. No vende, no edita y no ve reportes.',
};

/** Roles que el dueño puede asignar al crear un usuario (a sí mismo no). */
export const ASSIGNABLE_ROLES: AppRole[] = ['cashier', 'vendedor', 'consulta'];

/** A dónde va cada rol al entrar. */
export const ROLE_HOME: Record<AppRole, string> = {
  owner: '/dashboard',
  cashier: '/pos',
  // Entra a Consultar precio y de ahí pasa a la caja por el menú: anda con el
  // teléfono en el piso de venta (así se pidió el 2026-10-13).
  vendedor: '/consultar-precio',
  consulta: '/consultar-precio',
};

export function isAppRole(v: unknown): v is AppRole {
  return typeof v === 'string' && (APP_ROLES as readonly string[]).includes(v);
}

/**
 * A dónde mandar a alguien. Un rol que no reconocemos va a /consultar-precio,
 * que es la pantalla de solo lectura: ante la duda, lo menos que se puede dar.
 */
export function homeFor(role: unknown): string {
  return isAppRole(role) ? ROLE_HOME[role] : '/consultar-precio';
}

/**
 * ¿Este rol opera el negocio (caja, inventario, clientes, etiquetas, reportes)?
 * `consulta` no. `vendedor` tampoco: solo consulta precios y cobra, así que
 * entra a la caja pero a ninguna de las otras pantallas.
 */
export function isOperativo(role: unknown): boolean {
  return role === 'owner' || role === 'cashier';
}

/** ¿Trabaja atado a una sucursal? El dueño salta entre tiendas; el resto no. */
export function tieneTiendaFija(role: unknown): boolean {
  return role === 'cashier' || role === 'vendedor' || role === 'consulta';
}
