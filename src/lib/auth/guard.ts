import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { homeFor, type AppRole } from '@/lib/roles';

/**
 * Guard de rol para un layout de servidor.
 *
 * POR QUÉ HACE FALTA: hasta ahora casi todas las rutas del dashboard se
 * "protegían" ocultando el ítem del menú. Con dos roles que veían casi lo
 * mismo eso alcanzaba; con el rol `consulta`, que solo debe ver una pantalla,
 * no: escribir la URL a mano bastaba para entrar. Solo /finanzas y /ofertas
 * tenían guard de verdad.
 *
 * Va en un layout (Server Component) y no en el cliente a propósito: un
 * `router.push` de cliente alcanza a pintar la pantalla antes de redirigir, y
 * lo que se pintaría acá son ventas, costos y datos de clientes.
 *
 * Esta es la segunda de las tres capas. La primera es que el ítem no aparezca
 * en el menú; la tercera —la única que de verdad protege los datos, porque la
 * clave anónima viaja en el navegador— son las políticas RLS y los chequeos de
 * rol dentro de los RPC `SECURITY DEFINER`.
 *
 * A quien no pasa se lo manda a SU pantalla de inicio, no a una de error: para
 * el empleado es un enlace que no le toca, no una falla.
 */
export async function requireRole(permitidos: AppRole[]): Promise<AppRole> {
  const supabase = await createClient();

  const { data: { user }, error } = await supabase.auth.getUser();
  if (!user || error) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  const role = profile?.role as AppRole | undefined;

  // Sin perfil no se entra a ninguna parte: es un usuario a medio crear.
  if (!role) redirect('/login');

  if (!permitidos.includes(role)) redirect(homeFor(role));

  return role;
}
