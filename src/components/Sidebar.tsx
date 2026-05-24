'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import Image from 'next/image';
import { createClient } from '@/lib/supabase/client';
import { usePOSStore, Store } from '@/store/usePOSStore';

type Role = 'owner' | 'cashier';

interface SidebarProps {
  userRole: Role;
  userName: string;
  stores: Store[]; // <-- Nueva prop para recibir las tiendas
}

export default function Sidebar({ userRole, userName, stores }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createClient();
  const { currentStore, setCurrentStore } = usePOSStore(); // <-- Estado global

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  };

  const menuItems = [
    { name: 'Reportes', path: '/dashboard', roles: ['owner', 'cashier'] },
    { name: 'Registro de Ventas', path: '/pos', roles: ['owner', 'cashier'] },
    { name: 'Inventario', path: '/inventory', roles: ['owner', 'cashier'] },
    { name: 'Clientes', path: '/customers', roles: ['owner', 'cashier'] },
    { name: 'Etiquetas', path: '/labels', roles: ['owner', 'cashier'] },
    { name: 'Usuarios', path: '/users', roles: ['owner'] },
  ];

  const filteredMenu = menuItems.filter(item => item.roles.includes(userRole));

  return (
    <aside className="hidden md:flex flex-col w-64 bg-[#0f5c5c] text-white min-h-screen shadow-xl print:hidden shrink-0">
      {/* Logo y Título */}
      <div className="p-6 flex flex-col items-center border-b border-teal-700">
        <h2 className="text-xl font-bold tracking-wider">GANESHA STORE</h2>
      </div>

      {/* --- NUEVO BLOQUE: Selector de Tiendas --- */}
      {userRole === 'owner' && (
        <div className="px-6 py-4 border-b border-teal-800">
          <label className="text-[10px] uppercase tracking-widest text-teal-300 font-bold mb-1 block">
            Tienda Activa
          </label>
          <select 
            value={currentStore?.id || ''}
            onChange={(e) => {
              const selected = stores.find(s => s.id === e.target.value);
              if (selected) setCurrentStore(selected);
            }}
            className="w-full bg-teal-800 text-white text-sm p-2 rounded border border-teal-600 focus:outline-none focus:ring-1 focus:ring-teal-400 cursor-pointer"
          >
            <option value="" disabled>Seleccione...</option>
            {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      )}

      {/* Indicador visual para el Cajero (Solo lectura) */}
      {userRole === 'cashier' && currentStore && (
        <div className="px-6 py-4 border-b border-teal-800 bg-teal-900/30">
          <p className="text-[10px] uppercase tracking-widest text-teal-300 font-bold mb-1">
            Sucursal Asignada
          </p>
          <p className="text-sm font-semibold text-teal-50 truncate">{currentStore.name}</p>
        </div>
      )}
      {/* -------------------------------------- */}

      {/* Menú Dinámico */}
      <nav className="flex-1 px-4 py-6 space-y-2">
        {filteredMenu.map((item) => {
          const isActive = pathname === item.path;
          return (
            <Link
              key={item.path}
              href={item.path}
              className={`block px-4 py-3 rounded-lg transition-colors ${
                isActive 
                  ? 'bg-teal-700 text-white font-semibold' 
                  : 'text-teal-100 hover:bg-teal-800 hover:text-white'
              }`}
            >
              {item.name}
            </Link>
          );
        })}
      </nav>

      {/* Info del Usuario al final con Botón de Log Out */}
      <div className="p-4 bg-teal-900 border-t border-teal-800 text-center flex flex-col gap-1">
        <p className="text-sm font-medium">{userName}</p>
        <button
          onClick={handleLogout}
          className="text-xs text-red-300 hover:text-red-100 transition-colors mt-1 font-medium cursor-pointer"
        >
          Cerrar Sesión 
        </button>
      </div>
    </aside>
  );
}