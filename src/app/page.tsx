// src/app/page.tsx
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { homeFor } from '@/lib/roles';

export default async function RootPage() {
  // ¡AQUÍ ESTÁ LA MAGIA! Añadimos "await" porque tu createClient es asíncrono
  const supabase = await createClient();
  
  // 1. Verificamos si hay una sesión activa de forma segura en el servidor
  const { data: { user }, error } = await supabase.auth.getUser();

  // Si no hay usuario o la cookie no es válida, lo mandamos al Login
  if (error || !user) {
    redirect('/login');
  }

  // 2. Si está logueado, consultamos su rol en la tabla profiles
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  // 3. Cada rol a su pantalla. Con `homeFor` en vez de un if/else: el `else`
  //    mandaba a /pos a cualquier rol que no fuera dueno, y eso con el rol
  //    'consulta' significaba mandarlo justo a la pantalla que no debe ver.
  redirect(homeFor(profile?.role));
}