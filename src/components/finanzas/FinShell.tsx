'use client';

// Envoltorio común de todas las pantallas de Finanzas: pestañas y la
// comprobación de que el módulo esté instalado en la base.
//
// No hay selector de tienda: las finanzas son del negocio completo.
//
// Las ocho secciones van como PESTAÑAS y no como ocho ítems en la barra
// lateral: el menú del POS tiene seis entradas y meterle ocho más lo volvería
// inservible, sobre todo en móvil.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { isMissingTableError } from '@/lib/finanzas/errors';

const TABS = [
  { name: 'Resumen', path: '/finanzas' },
  { name: 'Cajas', path: '/finanzas/cajas' },
  { name: 'Proveedores', path: '/finanzas/proveedores' },
  { name: 'Compras', path: '/finanzas/compras' },
  { name: 'Cuentas', path: '/finanzas/cuentas' },
  { name: 'Calendario', path: '/finanzas/calendario' },
  { name: 'Gastos', path: '/finanzas/gastos' },
  { name: 'Personal', path: '/finanzas/personal' },
];

type InstallState = 'checking' | 'ready' | 'missing';

interface FinShellProps {
  title: string;
  subtitle?: string;
  /** Botones de la esquina superior derecha (exportar, crear, etc.). */
  actions?: React.ReactNode;
  children: React.ReactNode;
}

export default function FinShell({ title, subtitle, actions, children }: FinShellProps) {
  const pathname = usePathname();
  const [install, setInstall] = useState<InstallState>('checking');

  // Las migraciones se aplican A MANO en Supabase, así que el front puede
  // estar desplegado antes que el SQL. Sin esta comprobación, la primera
  // pantalla sería un error críptico en consola en vez de decir qué falta.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { error } = await supabase.from('fin_suppliers').select('id').limit(1);
      if (cancelled) return;
      setInstall(error && isMissingTableError(error) ? 'missing' : 'ready');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="font-sans">
      <header className="mb-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-800">{title}</h1>
            {subtitle && <p className="text-sm text-slate-500 mt-1">{subtitle}</p>}
          </div>
          <div className="flex items-center gap-3">{actions}</div>
        </div>

        <nav className="mt-5 -mx-1 overflow-x-auto">
          <div className="flex gap-1 min-w-max border-b border-slate-200 px-1">
            {TABS.map((tab) => {
              const isActive =
                tab.path === '/finanzas'
                  ? pathname === '/finanzas'
                  : pathname.startsWith(tab.path);
              return (
                <Link
                  key={tab.path}
                  href={tab.path}
                  className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition-colors ${
                    isActive
                      ? 'border-teal-700 text-teal-800'
                      : 'border-transparent text-slate-500 hover:text-slate-800 hover:border-slate-300'
                  }`}
                >
                  {tab.name}
                </Link>
              );
            })}
          </div>
        </nav>
      </header>

      {install === 'checking' && (
        <div className="text-slate-500 text-sm py-12 text-center">Cargando Finanzas…</div>
      )}

      {install === 'missing' && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 max-w-2xl">
          <h2 className="font-bold text-amber-900 mb-2">Finanzas todavía no está instalado</h2>
          <p className="text-sm text-amber-800 mb-3">
            Las tablas del módulo no existen en la base de datos. Hay que correr, en el SQL Editor
            de Supabase y en este orden:
          </p>
          <ol className="text-sm text-amber-900 font-mono space-y-1 list-decimal list-inside">
            <li>db/finanzas_01_schema.sql</li>
            <li>db/finanzas_02_storage.sql</li>
          </ol>
          <p className="text-xs text-amber-700 mt-3">
            El resto del sistema (ventas, inventario, clientes) sigue funcionando con normalidad.
          </p>
        </div>
      )}

      {install === 'ready' && children}
    </div>
  );
}
