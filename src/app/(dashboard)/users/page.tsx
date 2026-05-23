'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { createClient } from '@/lib/supabase/client';
import { createCashierAction, getUsersAction, toggleUserActiveAction } from './actions';

const userSchema = z.object({
  full_name: z.string().min(3, { message: 'El nombre debe tener al menos 3 letras' }),
  email: z.string().email({ message: 'Ingresa un correo válido' }),
  password: z.string().min(6, { message: 'Mínimo 6 caracteres' }),
});

type UserFormValues = z.infer<typeof userSchema>;

export default function UsersPage() {
  const router = useRouter();
  const supabase = createClient();

  const [isAuthorized, setIsAuthorized] = useState(false);
  const [isPageLoading, setIsPageLoading] = useState(true);
  const [users, setUsers] = useState<any[]>([]);
  const [isFormLoading, setIsFormLoading] = useState(false);
  const [serverMessage, setServerMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

  const { register, handleSubmit, reset, formState: { errors } } = useForm<UserFormValues>({
    resolver: zodResolver(userSchema),
  });

  useEffect(() => {
    const checkRoleAndLoadData = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return router.push('/login');

      const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
      if (profile?.role !== 'owner') return router.push('/pos');

      setIsAuthorized(true);
      await fetchUsers();
      setIsPageLoading(false);
    };
    checkRoleAndLoadData();
  }, [router, supabase]);

  const fetchUsers = async () => {
    const result = await getUsersAction();
    if (result.success && result.users) setUsers(result.users);
  };

  const onSubmit = async (data: UserFormValues) => {
    setIsFormLoading(true);
    setServerMessage(null);
    const result = await createCashierAction(data);

    if (result.success) {
      setServerMessage({ type: 'success', text: '¡Cajero creado con éxito!' });
      reset(); 
      await fetchUsers();
    } else {
      setServerMessage({ type: 'error', text: result.error || 'Error al crear el cajero' });
    }
    setIsFormLoading(false);
  };

  const handleToggleStatus = async (userId: string, userName: string, currentStatus: boolean) => {
    const accion = currentStatus ? 'desactivar' : 'reactivar';
    if (window.confirm(`¿Seguro que deseas ${accion} el acceso de ${userName}?`)) {
      const result = await toggleUserActiveAction(userId, currentStatus);
      if (result.success) {
        await fetchUsers();
      } else {
        alert('Error al cambiar el estado: ' + result.error);
      }
    }
  };

  if (isPageLoading) {
    return (
      <div className="h-full flex items-center justify-center text-slate-500 w-full">
        <div className="animate-pulse flex flex-col items-center">
          <div className="w-8 h-8 border-4 border-teal-500 border-t-transparent rounded-full animate-spin mb-4"></div>
          <p>Verificando permisos...</p>
        </div>
      </div>
    );
  }

  if (!isAuthorized) return null;

  return (
    // Se elimina h-full y lg:overflow-hidden para permitir el scroll natural del navegador
    <div className="flex flex-col lg:flex-row gap-6 p-2 lg:p-0">
      
      {/* === COLUMNA IZQUIERDA: FORMULARIO === */}
      <div className="w-full lg:w-[380px] xl:w-[420px] flex-shrink-0 flex flex-col gap-4 pr-1">
        
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Control de Acceso</h1>
          <p className="text-sm text-slate-500">Añade o revoca permisos al sistema POS.</p>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex-shrink-0">
          <h2 className="font-semibold text-slate-700 mb-4 pb-2 border-b border-slate-100">Crear Nuevo Cajero</h2>
          
          {serverMessage && (
            <div className={`p-3 rounded-lg mb-4 text-sm font-medium ${
              serverMessage.type === 'success' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-red-50 text-red-700 border border-red-200'
            }`}>
              {serverMessage.text}
            </div>
          )}

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div>
              <label className="block text-xs font-bold tracking-wide text-slate-600 uppercase mb-1">Nombre Completo</label>
              <input type="text" {...register('full_name')} placeholder="Ej: Ana María" className="w-full p-2.5 border border-slate-300 rounded-lg text-sm bg-slate-50 hover:bg-white focus:bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-600 transition" />
              {errors.full_name && <p className="text-rose-500 text-xs mt-1 font-medium">{errors.full_name.message}</p>}
            </div>

            <div>
              <label className="block text-xs font-bold tracking-wide text-slate-600 uppercase mb-1">Correo Electrónico</label>
              <input type="email" {...register('email')} placeholder="ana@ejemplo.com" className="w-full p-2.5 border border-slate-300 rounded-lg text-sm bg-slate-50 hover:bg-white focus:bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-600 transition" />
              {errors.email && <p className="text-rose-500 text-xs mt-1 font-medium">{errors.email.message}</p>}
            </div>

            <div>
              <label className="block text-xs font-bold tracking-wide text-slate-600 uppercase mb-1">Contraseña Temporal</label>
              <input type="password" {...register('password')} placeholder="••••••••" className="w-full p-2.5 border border-slate-300 rounded-lg text-sm bg-slate-50 hover:bg-white focus:bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-600 transition" />
              {errors.password && <p className="text-rose-500 text-xs mt-1 font-medium">{errors.password.message}</p>}
            </div>

            <button type="submit" disabled={isFormLoading} className="w-full mt-6 bg-[#0f5c5c] text-white py-2.5 rounded-lg text-sm font-bold hover:bg-[#0a4545] shadow-md hover:shadow-lg transition-all flex justify-center items-center disabled:opacity-70 disabled:cursor-not-allowed">
              {isFormLoading ? (
                 <span className="flex items-center gap-2">
                   <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                   Creando...
                 </span>
              ) : 'Guardar Cajero'}
            </button>
          </form>
        </div>
      </div>

      {/* === COLUMNA DERECHA: LISTA DE USUARIOS === */}
      {/* Se eliminan restricciones de altura para que el contenido empuje la página hacia abajo */}
      <div className="w-full flex-1 flex flex-col gap-4">
        
        <div className="hidden lg:block">
          <h2 className="text-2xl font-bold text-slate-800">Usuarios Registrados</h2>
          <p className="text-sm text-slate-500">Gestiona el equipo de trabajo.</p>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 flex flex-col overflow-hidden">
          
          {/* == VISTA MOBILE: Tarjetas == */}
          {/* Eliminado el overflow-y-auto, ahora las tarjetas hacen crecer el div naturalmente */}
          <div className="md:hidden p-4 space-y-3 bg-slate-50/50">
            {users.map((user) => (
              <div key={user.id} className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm flex flex-col gap-3">
                <div className="flex justify-between items-start">
                  <div>
                    <h3 className="font-bold text-slate-800">{user.full_name}</h3>
                    <p className="text-xs text-slate-500">{user.email}</p>
                  </div>
                  <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${user.role === 'owner' ? 'bg-purple-100 text-purple-700' : 'bg-teal-100 text-teal-700'}`}>
                    {user.role === 'owner' ? 'Dueño' : 'Cajero'}
                  </span>
                </div>
                
                <div className="flex justify-between items-center pt-3 border-t border-slate-100">
                  <span className={`flex items-center gap-1.5 text-xs font-semibold ${user.is_active ? 'text-emerald-600' : 'text-rose-500'}`}>
                    <span className={`w-2 h-2 rounded-full ${user.is_active ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-rose-500'}`}></span>
                    {user.is_active ? 'Activo' : 'Inactivo'}
                  </span>
                  
                  {user.role !== 'owner' && (
                    <button
                      onClick={() => handleToggleStatus(user.id, user.full_name, user.is_active)}
                      className={`px-3 py-1.5 rounded-lg transition border text-xs font-bold ${
                        user.is_active 
                          ? 'text-rose-600 border-rose-200 bg-rose-50 hover:bg-rose-100' 
                          : 'text-emerald-700 border-emerald-200 bg-emerald-50 hover:bg-emerald-100'
                      }`}
                    >
                      {user.is_active ? 'Desactivar' : 'Reactivar'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* == VISTA DESKTOP/TABLET: Tabla == */}
          {/* Mantiene overflow-x-auto solo por si la pantalla es estrecha para que la tabla no se rompa horizontalmente */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead className="bg-slate-50 border-b border-slate-200 shadow-sm">
                <tr className="text-[11px] uppercase tracking-wider text-slate-500 font-bold">
                  <th className="px-6 py-4">Usuario</th>
                  <th className="px-6 py-4">Rol</th>
                  <th className="px-6 py-4">Estado</th>
                  <th className="px-6 py-4 text-center">Acción</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {users.map((user) => (
                  <tr key={user.id} className="hover:bg-slate-50 transition">
                    <td className="px-6 py-4">
                      <div className="font-bold text-slate-800">{user.full_name}</div>
                      <div className="text-xs text-slate-500">{user.email}</div>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`px-2.5 py-1 rounded-full text-[11px] font-bold tracking-wide uppercase ${user.role === 'owner' ? 'bg-purple-100 text-purple-700 border border-purple-200' : 'bg-teal-50 text-teal-700 border border-teal-200'}`}>
                        {user.role === 'owner' ? 'Dueño' : 'Cajero'}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${user.is_active ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-rose-50 text-rose-700 border border-rose-200'}`}>
                         <span className={`w-1.5 h-1.5 rounded-full ${user.is_active ? 'bg-emerald-500 shadow-[0_0_5px_rgba(16,185,129,0.5)]' : 'bg-rose-500'}`}></span>
                        {user.is_active ? 'Activo' : 'Inactivo'}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-center">
                      {user.role !== 'owner' ? (
                        // Se eliminaron las clases de opacidad. El botón ahora siempre es visible.
                        <button
                          onClick={() => handleToggleStatus(user.id, user.full_name, user.is_active)}
                          className={`px-3 py-1.5 rounded-md transition border text-xs font-bold ${
                            user.is_active 
                              ? 'text-rose-600 border-rose-200 bg-rose-50 hover:bg-rose-100' 
                              : 'text-emerald-700 border-emerald-200 bg-emerald-50 hover:bg-emerald-100'
                          }`}
                        >
                          {user.is_active ? 'Desactivar' : 'Reactivar'}
                        </button>
                      ) : (
                         <span className="text-xs text-slate-400 italic">No aplicable</span>
                      )}
                    </td>
                  </tr>
                ))}
                {users.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-6 py-12 text-center text-slate-400">
                      <svg className="w-12 h-12 mx-auto mb-3 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
                      <p className="text-base font-medium text-slate-500">No hay usuarios registrados</p>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

        </div>
      </div>
    </div>
  );
}