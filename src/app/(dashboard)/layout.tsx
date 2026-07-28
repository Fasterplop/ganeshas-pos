import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import Sidebar from '@/components/Sidebar';
import TopBarMenu from '@/components/TopBarMenu'; // <-- Importamos el menú
import BcvModal from '@/components/BcvModal';
import StoreGuard from '@/components/StoreGuard'; // <-- Importamos el nuevo Guard

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

  // 1. Obtenemos Perfil ampliando la selección para incluir id y assigned_store_id
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, full_name, role, assigned_store_id')
    .eq('id', user.id)
    .single();

  if (!profile) {
    redirect('/login');
  }

  // 2. Obtenemos todas las tiendas disponibles
  const { data: stores } = await supabase
    .from('stores')
    .select('id, name, is_active')
    .order('name');

  // Si por alguna razón falla la carga de tiendas, protegemos la ruta
  if (!stores) {
    redirect('/login');
  }

  return (
    // Agregamos flex-col para móvil y md:flex-row para escritorio
    <div className="flex flex-col md:flex-row h-screen bg-slate-50 overflow-hidden font-sans">
      
      {/* Se mostrará SOLO en móvil. Le pasamos stores */}
      <TopBarMenu 
        userRole={profile.role} 
        userName={profile.full_name} 
        stores={stores}
      />

      {/* Se mostrará SOLO en escritorio. Le pasamos stores */}
      <Sidebar 
        userRole={profile.role} 
        userName={profile.full_name} 
        stores={stores}
      />

      <BcvModal />

      {/* 3. EL GUARD ENVUELVE EL CONTENIDO PRINCIPAL */}
      <StoreGuard userProfile={profile} stores={stores}>
        <main className="flex-1 overflow-y-auto p-8 print:p-0 print:overflow-visible relative">
          {children}
        </main>
      </StoreGuard>
    </div>
  );
}