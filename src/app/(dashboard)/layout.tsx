import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import Sidebar from '@/components/Sidebar';
import BcvModal from '@/components/BcvModal';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();

  // 1. Verificamos de forma SEGURA al usuario contactando al servidor de Supabase
  const { data: { user }, error: userError } = await supabase.auth.getUser();

  // Si no hay usuario válido, lo pateamos a la pantalla de login
  if (!user || userError) {
    redirect('/login');
  }

  // 2. Buscamos el perfil del usuario usando el ID seguro verificado
  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, role')
    .eq('id', user.id)
    .single();

  // Si por alguna razón no tiene perfil, por seguridad lo mandamos al login
  if (!profile) {
    redirect('/login');
  }

  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden font-sans">
      {/* El Sidebar Lateral que acabamos de crear */}
      <Sidebar 
        userRole={profile.role} 
        userName={profile.full_name} 
      />

    {/* Aquí colocamos el Modal. Bloqueará la pantalla automáticamente si Zustand dice que la tasa es 0 */}
      <BcvModal />

      {/* El contenido principal de la app (el dashboard, el POS, el inventario, etc.) */}
      <main className="flex-1 overflow-y-auto p-8 print:p-0 print:overflow-visible relative">
        {children}
      </main>
    </div>
  );
}