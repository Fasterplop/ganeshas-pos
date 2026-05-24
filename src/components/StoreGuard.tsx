'use client';

import { useEffect, useState } from 'react';
import { usePOSStore, Store } from '@/store/usePOSStore';
import { createClient } from '@/lib/supabase/client';

interface StoreGuardProps {
  userProfile: {
    id: string;
    full_name: string; // <-- Aseguramos que typescript sepa que existe
    role: 'owner' | 'cashier';
    assigned_store_id?: string;
  };
  stores: Store[];
  children: React.ReactNode;
}

export default function StoreGuard({ userProfile, stores, children }: StoreGuardProps) {
  const { currentStore, setCurrentStore } = usePOSStore();
  const [isInitializing, setIsInitializing] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const initializeStore = () => {
      if (userProfile.role === 'cashier') {
        const assigned = stores.find(s => s.id === userProfile.assigned_store_id);
        if (!assigned || !assigned.is_active) {
          setError("Tu sucursal asignada no está activa. Contacta al administrador.");
        } else {
          setCurrentStore(assigned);
        }
      }
      setIsInitializing(false);
    };
    initializeStore();
  }, [userProfile, stores, setCurrentStore]);

  if (isInitializing) return <div className="h-screen flex items-center justify-center bg-slate-900 text-white">Iniciando contexto...</div>;

  if (error) {
    return (
      <div className="h-screen flex items-center justify-center bg-red-50 p-4">
        <div className="bg-white p-8 rounded-xl shadow-2xl text-center max-w-md border border-red-200">
          <h1 className="text-2xl font-bold text-red-600 mb-4">Acceso Denegado</h1>
          <p className="text-slate-600 mb-6">{error}</p>
          <button 
            onClick={async () => {
              const supabase = createClient();
              await supabase.auth.signOut();
              window.location.href = '/login';
            }}
            className="bg-red-600 text-white px-6 py-2 rounded-lg hover:bg-red-700 transition-colors"
          >
            Cerrar Sesión
          </button>
        </div>
      </div>
    );
  }

  if (userProfile.role === 'owner' && !currentStore) {
    return (
      <div className="h-screen w-full flex items-center justify-center bg-[#0f5c5c] p-4 fixed inset-0 z-[9999]">
        <div className="bg-white rounded-2xl shadow-2xl p-10 max-w-lg w-full text-center">
          {/* AQUÍ CORREGIMOS EL NOMBRE FIJO */}
          <h2 className="text-3xl font-bold text-slate-800 mb-2">
            ¡Bienvenido, {userProfile.full_name}!
          </h2>
          <p className="text-slate-500 mb-8">Por favor, selecciona la tienda para iniciar sesión en el sistema.</p>
          
          <div className="grid grid-cols-1 gap-4">
            {stores.length === 0 ? (
              <div className="text-red-500 p-4 border border-red-200 bg-red-50 rounded-xl">
                ⚠️ No hay tiendas registradas en la base de datos.
              </div>
            ) : (
              stores.map((store) => (
                <button
                  key={store.id}
                  disabled={!store.is_active}
                  onClick={() => setCurrentStore(store)}
                  className={`p-6 rounded-xl border-2 transition-all text-left flex justify-between items-center ${
                    store.is_active 
                    ? 'border-slate-100 hover:border-teal-500 hover:bg-teal-50 group' 
                    : 'bg-slate-50 opacity-50 cursor-not-allowed'
                  }`}
                >
                  <div>
                    <p className="font-bold text-lg text-slate-800">{store.name}</p>
                    <p className="text-sm text-slate-400">{store.is_active ? 'Operativa' : 'Cerrada'}</p>
                  </div>
                  {store.is_active && <span className="text-teal-500 opacity-0 group-hover:opacity-100 font-bold">Entrar →</span>}
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}