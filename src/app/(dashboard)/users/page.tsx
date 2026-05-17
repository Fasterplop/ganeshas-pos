// src/app/(dashboard)/users/page.tsx
'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { createCashierAction } from './actions';

// 1. Validación Estricta con Zod
const userSchema = z.object({
  full_name: z.string().min(3, { message: 'El nombre debe tener al menos 3 letras' }),
  email: z.string().email({ message: 'Ingresa un correo electrónico válido' }),
  password: z.string().min(6, { message: 'La contraseña debe tener mínimo 6 caracteres' }),
});

type UserFormValues = z.infer<typeof userSchema>;

export default function UsersPage() {
  const [isLoading, setIsLoading] = useState(false);
  const [serverMessage, setServerMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

  const { register, handleSubmit, reset, formState: { errors } } = useForm<UserFormValues>({
    resolver: zodResolver(userSchema),
  });

  // 2. Manejador del Formulario
  const onSubmit = async (data: UserFormValues) => {
    setIsLoading(true);
    setServerMessage(null);

    // Llamamos a nuestra Server Action
    const result = await createCashierAction(data);

    if (result.success) {
      setServerMessage({ type: 'success', text: '¡Cajero creado y autorizado con éxito!' });
      reset(); // Limpiamos el formulario
    } else {
      setServerMessage({ type: 'error', text: result.error || 'Error al crear el cajero' });
    }

    setIsLoading(false);
  };

  return (
    <div className="max-w-2xl mx-auto h-full font-sans">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-slate-800">Gestión de Usuarios</h1>
        <p className="text-slate-500">Crea accesos para nuevos cajeros en el sistema.</p>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-8">
        <div className="flex items-center gap-3 mb-6 pb-4 border-b border-slate-100">
          <div className="w-10 h-10 bg-teal-100 text-teal-700 rounded-full flex items-center justify-center text-lg">
            👤
          </div>
          <div>
            <h2 className="text-lg font-bold text-slate-800">Registrar Nuevo Cajero</h2>
            <p className="text-sm text-slate-500">El usuario tendrá acceso inmediato al POS.</p>
          </div>
        </div>

        {/* Mensajes del Servidor */}
        {serverMessage && (
          <div className={`p-4 rounded-lg mb-6 text-sm font-medium ${
            serverMessage.type === 'success' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-red-50 text-red-700 border border-red-200'
          }`}>
            {serverMessage.text}
          </div>
        )}

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Nombre Completo</label>
            <input 
              type="text" 
              {...register('full_name')}
              placeholder="Ej: Ana María García" 
              className="w-full p-3 border border-slate-300 rounded-lg bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-600 transition"
            />
            {errors.full_name && <p className="text-red-500 text-xs mt-1">{errors.full_name.message}</p>}
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Correo Electrónico</label>
            <input 
              type="email" 
              {...register('email')}
              placeholder="ana.cajera@ganeshas.com" 
              className="w-full p-3 border border-slate-300 rounded-lg bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-600 transition"
            />
            {errors.email && <p className="text-red-500 text-xs mt-1">{errors.email.message}</p>}
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Contraseña Temporal</label>
            <input 
              type="password" 
              {...register('password')}
              placeholder="••••••••" 
              className="w-full p-3 border border-slate-300 rounded-lg bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-600 transition"
            />
            {errors.password && <p className="text-red-500 text-xs mt-1">{errors.password.message}</p>}
          </div>

          <button 
            type="submit" 
            disabled={isLoading}
            className="w-full mt-4 bg-[#0f5c5c] text-white py-3 rounded-lg font-medium hover:bg-[#0a4545] transition flex justify-center items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading ? 'Creando Cajero...' : 'Crear Usuario Cajero'}
          </button>
        </form>
      </div>
    </div>
  );
}