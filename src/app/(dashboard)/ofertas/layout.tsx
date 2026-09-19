import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

// Guard de Ofertas: SERVER-SIDE.
//
// Una oferta cambia lo que cobra la caja, así que es una decisión de precios,
// del mismo peso que el ajuste masivo de precios: solo el dueño. Se usa el
// mismo patrón de tres capas que /finanzas: el ítem no aparece en el menú
// (roles: ['owner']), este layout redirige antes de pintar nada, y las
// políticas RLS de db/scanner_03_offers.sql son la única capa que de verdad
// protege los datos, porque la clave anónima viaja en el navegador.
//
// Los cajeros SÍ leen las ofertas (la caja las tiene que cobrar y el teléfono
// mostrarlas): lo que no pueden es crearlas ni apagarlas.
export default async function OfertasLayout({ children }: { children: React.ReactNode }) {
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
