import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import Sidebar from '@/components/Sidebar';
import TopBarMenu from '@/components/TopBarMenu'; // <-- Importamos el menú
import BcvModal from '@/components/BcvModal';
import StoreGuard from '@/components/StoreGuard'; // <-- Importamos el nuevo Guard
import PhoneModeGuard from '@/components/PhoneModeGuard';

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
  // phone_simple_mode llega con db/novedades_01…sql. Si la columna todavía no
  // existe, la consulta falla entera: se repite sin ella para no mandar a
  // todos al login.
  let { data: profile } = await supabase
    .from('profiles')
    .select('id, full_name, role, assigned_store_id, phone_simple_mode')
    .eq('id', user.id)
    .single();
  if (!profile) {
    const { data: basic } = await supabase
      .from('profiles')
      .select('id, full_name, role, assigned_store_id')
      .eq('id', user.id)
      .single();
    profile = basic ? { ...basic, phone_simple_mode: false } : null;
  }

  if (!profile) {
    redirect('/login');
  }

  // Modo teléfono: solo para cajeros (en Usuarios no se ofrece a otros roles).
  const phoneSimple = profile.role === 'cashier' && !!profile.phone_simple_mode;

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
        phoneSimple={phoneSimple}
      />

      <PhoneModeGuard enabled={phoneSimple} />

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