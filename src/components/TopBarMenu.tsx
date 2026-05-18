'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import Image from 'next/image';
import { createClient } from '@/lib/supabase/client';

type Role = 'owner' | 'cashier';

interface TopBarMenuProps {
  userRole: Role;
  userName: string;
}

export default function TopBarMenu({ userRole, userName }: TopBarMenuProps) {
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
    <header className="md:hidden w-full bg-[#0f5c5c] text-white print:hidden flex flex-col shadow-md shrink-0">
      {/* Fila superior: Logo y Usuario */}
      <div className="flex items-center justify-between p-3 border-b border-teal-700">
        <div className="flex items-center gap-2">
          {/* <div className="bg-white p-1 rounded-full">
            <Image src="/logo.webp" alt="Logo" width={24} height={24} className="object-contain" />
          </div> */}
          <h2 className="text-base font-bold tracking-wider">GANESHA STORE</h2>
        </div>
        <div className="flex items-center gap-3 text-xs font-medium text-teal-200">
          <div className="truncate max-w-[120px]">
            {userName}
          </div>
          <button
            onClick={handleLogout}
            className="text-red-300 hover:text-red-100 transition-colors cursor-pointer"
            title="Cerrar Sesión"
          >
            Cerrar Sesión 
          </button>
        </div>
      </div>

      {/* Fila inferior: Menú horizontal deslizable */}
      <nav className="flex overflow-x-auto gap-2 px-3 py-2 scrollbar-hide items-center">
        {filteredMenu.map((item) => {
          const isActive = pathname === item.path;
          return (
            <Link
              key={item.path}
              href={item.path}
              className={`whitespace-nowrap px-4 py-2 rounded-full text-sm transition-colors ${
                isActive 
                  ? 'bg-teal-700 text-white font-semibold' 
                  : 'text-teal-100 hover:bg-teal-800'
              }`}
            >
              {item.name}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}