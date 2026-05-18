'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import Image from 'next/image';
import { createClient } from '@/lib/supabase/client';

type Role = 'owner' | 'cashier';

interface SidebarProps {
  userRole: Role;
  userName: string;
}

export default function Sidebar({ userRole, userName }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createClient();

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  };

  const menuItems = [
    { name: 'Reportes', path: '/', roles: ['owner'] },
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
        {/* <div className="bg-white p-2 rounded-full mb-3">
           <Image src="/logo.webp" alt="Logo" width={40} height={40} className="object-contain" />
        </div> */}
        <h2 className="text-xl font-bold tracking-wider">GANESHA STORE</h2>

      </div>

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