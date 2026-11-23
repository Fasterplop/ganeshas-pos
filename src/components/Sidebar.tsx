'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import Image from 'next/image';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { usePOSStore, Store } from '@/store/usePOSStore';

import { tieneTiendaFija, type AppRole } from '@/lib/roles';
import { useNovedadesBadge } from '@/lib/useNovedadesBadge';
import { useTrasladosBadge } from '@/lib/useTrasladosBadge';
import { MENU_GROUPS, MENU_TOP_PATHS, isMenuActive, visibleMenu, type MenuItem } from '@/lib/menu';

type Role = AppRole;

interface SidebarProps {
  userRole: Role;
  userName: string;
  stores: Store[]; // <-- Nueva prop para recibir las tiendas
  /** Dueño, o con el permiso de fiar (Usuarios): ve «Cuentas por cobrar». */
  canFiar?: boolean;
}

export default function Sidebar({ userRole, userName, stores, canFiar }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createClient();
  const { currentStore, setCurrentStore } = usePOSStore(); // <-- Estado global
  const novedades = useNovedadesBadge(userRole === 'owner');
  // Envíos que esperan que la tienda activa confirme.
  const porRecibir = useTrasladosBadge(currentStore?.id, userRole === 'owner' || userRole === 'cashier');

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  };

  const items = visibleMenu(userRole, canFiar);
  const isOwner = userRole === 'owner';
  const badgeFor = (path: string) =>
    path === '/novedades' ? novedades : path === '/traslados' ? porRecibir : 0;

  // Menú compacto del dueño: un grupo abierto a la vez. Por defecto, el de la
  // página en que está; si toca otro grupo, manda lo que tocó (hasta que
  // cambie de página).
  const activeGroup = MENU_GROUPS.find(g => g.paths.some(p => isMenuActive(pathname, p)))?.id ?? null;
  const [picked, setPicked] = useState<{ path: string; group: string | null } | null>(null);
  const openGroup = picked && picked.path === pathname ? picked.group : activeGroup;
  const toggleGroup = (id: string) => setPicked({ path: pathname, group: openGroup === id ? null : id });

  const renderBadge = (n: number, title?: string) => (
    <span
      title={title}
      className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-red-500 text-white text-[11px] font-bold shrink-0"
    >
      {n > 99 ? '99+' : n}
    </span>
  );

  const renderLink = (item: MenuItem, sub = false) => {
    const isActive = isMenuActive(pathname, item.path);
    const Icon = item.icon;
    const badge = badgeFor(item.path);
    return (
      <Link
        key={item.path}
        href={item.path}
        className={`flex items-center gap-3 rounded-lg transition-colors ${sub ? 'px-3 py-1.5 text-sm' : 'px-3 py-2.5'} ${
          isActive
            ? 'bg-teal-500 text-white font-semibold shadow-sm'
            : 'text-teal-100 hover:bg-teal-800 hover:text-white'
        }`}
      >
        {!sub && <Icon className="w-5 h-5 shrink-0" aria-hidden />}
        <span className="flex-1 min-w-0 truncate">{item.name}</span>
        {badge > 0 && renderBadge(badge, item.path === '/traslados' ? 'Envíos por confirmar' : undefined)}
      </Link>
    );
  };

  const renderGrouped = () => (
    <>
      {items.filter(i => MENU_TOP_PATHS.includes(i.path)).map(i => renderLink(i))}
      <div className="my-3 border-t border-teal-600/60" />
      {MENU_GROUPS.map(g => {
        const groupItems = g.paths
          .map(p => items.find(i => i.path === p))
          .filter((i): i is MenuItem => !!i);
        if (groupItems.length === 0) return null;
        const open = openGroup === g.id;
        const GroupIcon = g.icon;
        const groupBadge = groupItems.reduce((sum, i) => sum + badgeFor(i.path), 0);
        return (
          <div key={g.id}>
            <button
              type="button"
              onClick={() => toggleGroup(g.id)}
              aria-expanded={open}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors ${
                open ? 'bg-teal-800 text-white font-semibold' : 'text-teal-100 hover:bg-teal-800 hover:text-white'
              }`}
            >
              <GroupIcon className="w-5 h-5 shrink-0" aria-hidden />
              <span className="flex-1 min-w-0 text-left truncate">{g.name}</span>
              {!open && groupBadge > 0 && renderBadge(groupBadge)}
              {open
                ? <ChevronDown className="w-4 h-4 shrink-0" aria-hidden />
                : <ChevronRight className="w-4 h-4 shrink-0" aria-hidden />}
            </button>
            {open && (
              <div className="ml-5 mt-1 mb-2 pl-3 border-l-2 border-teal-400/70 space-y-0.5">
                {groupItems.map(i => renderLink(i, true))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );

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

      {/* Indicador visual para quien trabaja en una sola sucursal (cajero,
          vendedor y consulta). El dueno tiene el selector de arriba. */}
      {tieneTiendaFija(userRole) && currentStore && (
        <div className="px-6 py-4 border-b border-teal-800 bg-teal-900/30">
          <p className="text-[10px] uppercase tracking-widest text-teal-300 font-bold mb-1">
            Sucursal Asignada
          </p>
          <p className="text-sm font-semibold text-teal-50 truncate">{currentStore.name}</p>
        </div>
      )}
      {/* -------------------------------------- */}

      {/* Menú: el dueño, compacto y por grupos; los empleados, su lista con íconos. */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {isOwner ? renderGrouped() : items.map(i => renderLink(i))}
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