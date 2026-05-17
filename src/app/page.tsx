// src/app/page.tsx
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

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

  // 3. Redirección inteligente basada en el rol
  if (profile?.role === 'owner') {
    redirect('/dashboard'); // Va a las analíticas
  } else {
    redirect('/pos'); // Va directo a facturar (cashier)
  }
}