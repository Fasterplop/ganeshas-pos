'use client'; // Es un componente de cliente porque tiene enlaces activos

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import Image from 'next/image';

// Definimos los tipos de roles basados en tu base de datos
type Role = 'owner' | 'cashier';

interface SidebarProps {
  userRole: Role;
  userName: string;
}

export default function Sidebar({ userRole, userName }: SidebarProps) {
  const pathname = usePathname();

  // Aquí configuramos TODAS las rutas y quién puede verlas según tu DDT
  const menuItems = [
    { name: 'Dashboard', path: '/', roles: ['owner'] },
    { name: 'Punto de Venta', path: '/pos', roles: ['owner', 'cashier'] },
    { name: 'Inventario', path: '/inventory', roles: ['owner'] },
    { name: 'Clientes', path: '/customers', roles: ['owner', 'cashier'] },
    { name: 'Etiquetas', path: '/labels', roles: ['owner', 'cashier'] },
    { name: 'Usuarios', path: '/users', roles: ['owner'] },
  ];

  // Filtramos: Solo guardamos los items donde el rol del usuario esté permitido
  const filteredMenu = menuItems.filter(item => item.roles.includes(userRole));

  return (
    <aside className="print:hidden w-64 bg-[#0f5c5c] text-white min-h-screen flex flex-col shadow-xl">
      {/* Logo y Título */}
      <div className="p-6 flex flex-col items-center border-b border-teal-700">
        <div className="bg-white p-2 rounded-full mb-3">
           <Image src="/logo.webp" alt="Logo" width={40} height={40} className="object-contain" />
        </div>
        <h2 className="text-xl font-bold tracking-wider">GANESHA</h2>
        <p className="text-xs text-teal-200">POS System</p>
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

      {/* Info del Usuario al final */}
      <div className="p-4 bg-teal-900 border-t border-teal-800">
        <p className="text-sm font-medium">{userName}</p>
        {/* <p className="text-xs text-teal-300 capitalize">Rol: {userRole}</p> */}
      </div>
    </aside>
  );
}