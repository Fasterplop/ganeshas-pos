'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import Image from 'next/image';

type Role = 'owner' | 'cashier';

interface TopBarMenuProps {
  userRole: Role;
  userName: string;
}

export default function TopBarMenu({ userRole, userName }: TopBarMenuProps) {
  const pathname = usePathname();

  const menuItems = [
    { name: 'Dashboard', path: '/', roles: ['owner'] },
    { name: 'POS', path: '/pos', roles: ['owner', 'cashier'] }, // Texto más corto para móvil
    { name: 'Inventario', path: '/inventory', roles: ['owner'] },
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
          <div className="bg-white p-1 rounded-full">
            <Image src="/logo.webp" alt="Logo" width={24} height={24} className="object-contain" />
          </div>
          <h2 className="text-base font-bold tracking-wider">GANESHA</h2>
        </div>
        <div className="text-xs font-medium text-teal-200 truncate max-w-[120px]">
          {userName}
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