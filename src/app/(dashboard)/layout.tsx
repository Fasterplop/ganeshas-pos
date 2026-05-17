import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import Sidebar from '@/components/Sidebar';
import TopBarMenu from '@/components/TopBarMenu'; // <-- Importamos el nuevo menú
import BcvModal from '@/components/BcvModal';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();

  const { data: { user }, error: userError } = await supabase.auth.getUser();

  if (!user || userError) {
    redirect('/login');
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, role')
    .eq('id', user.id)
    .single();

  if (!profile) {
    redirect('/login');
  }

  return (
    // Agregamos flex-col para móvil y md:flex-row para escritorio
    <div className="flex flex-col md:flex-row h-screen bg-slate-50 overflow-hidden font-sans">
      
      {/* Se mostrará SOLO en móvil */}
      <TopBarMenu 
        userRole={profile.role} 
        userName={profile.full_name} 
      />

      {/* Se mostrará SOLO en escritorio */}
      <Sidebar 
        userRole={profile.role} 
        userName={profile.full_name} 
      />

      <BcvModal />

      <main className="flex-1 overflow-y-auto p-8 print:p-0 print:overflow-visible relative">
        {children}
      </main>
    </div>
  );
}