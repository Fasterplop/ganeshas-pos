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
//    4. revisar los RPC `SECURITY DEFINER`, que son la única defensa real.

export const APP_ROLES = ['owner', 'cashier', 'consulta'] as const;
export type AppRole = (typeof APP_ROLES)[number];

/** Nombre que ve el dueño en la pantalla de Usuarios. */
export const ROLE_LABEL: Record<AppRole, string> = {
  owner: 'Dueño',
  cashier: 'Cajero',
  consulta: 'Solo consultar precios',
};

/** Versión corta, para el badge de la tabla (va en mayúsculas y no puede crecer). */
export const ROLE_BADGE: Record<AppRole, string> = {
  owner: 'Dueño',
  cashier: 'Cajero',
  consulta: 'Consulta',
};

/** Color del badge, para distinguir los tres roles de un vistazo. */
export const ROLE_BADGE_CLASS: Record<AppRole, string> = {
  owner: 'bg-purple-100 text-purple-700 border border-purple-200',
  cashier: 'bg-teal-50 text-teal-700 border border-teal-200',
  consulta: 'bg-amber-50 text-amber-700 border border-amber-200',
};

/** Una línea explicando qué puede hacer cada rol, para el formulario. */
export const ROLE_HELP: Record<AppRole, string> = {
  owner: 'Acceso a todo el sistema, incluidas Finanzas y Usuarios.',
  cashier: 'Caja, inventario, clientes, etiquetas y consulta de precios.',
  consulta:
    'Solo la pantalla Consultar precio, para el teléfono del piso de venta. No vende, no edita y no ve reportes.',
};

/** Roles que el dueño puede asignar al crear un usuario (a sí mismo no). */
export const ASSIGNABLE_ROLES: AppRole[] = ['cashier', 'consulta'];

/** A dónde va cada rol al entrar. */
export const ROLE_HOME: Record<AppRole, string> = {
  owner: '/dashboard',
  cashier: '/pos',
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
 * `consulta` no. Se usa para los guards de ruta y se refleja en los RPC.
 */
export function isOperativo(role: unknown): boolean {
  return role === 'owner' || role === 'cashier';
}

/** ¿Trabaja atado a una sucursal? El dueño salta entre tiendas; el resto no. */
export function tieneTiendaFija(role: unknown): boolean {
  return role === 'cashier' || role === 'consulta';
}
