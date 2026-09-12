import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

// Guard del módulo de Finanzas: SERVER-SIDE.
//
// La propuesta es explícita: todo el módulo es visible únicamente para el
// dueño; ningún cajero, vendedor ni encargado entra, ni siquiera en modo
// lectura. Por eso la comprobación va aquí y no solo en el cliente como en
// /users (src/app/(dashboard)/users/page.tsx:76-94): un redirect de cliente
// alcanza a pintar la pantalla antes de redirigir, y aquí lo que se pintaría
// son saldos y deudas del negocio.
//
// Esta es la segunda de las tres capas. La primera es que el ítem no aparece
// en el menú (roles: ['owner']), y la tercera —la única que de verdad protege
// los datos, porque la clave anónima viaja en el navegador— son las políticas
// RLS de db/finanzas_01_schema.sql.
//
// Es aditivo: no toca el layout padre de (dashboard), que sigue resolviendo
// sesión, tiendas, BcvModal y StoreGuard igual que siempre.
export default async function FinanzasLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();

  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (!user || userError) {
    redirect('/login');
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'owner') {
    redirect('/pos');
  }

  return <>{children}</>;
}
