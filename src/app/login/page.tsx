'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { createClient } from '@/lib/supabase/client';
import Image from 'next/image';

// 1. Definimos las reglas de validación con Zod
const loginSchema = z.object({
  email: z.string().email({ message: 'Debe ser un correo válido' }),
  password: z.string().min(6, { message: 'La contraseña debe tener al menos 6 caracteres' }),
});

// Inferimos el tipo de datos para TypeScript
type LoginFormValues = z.infer<typeof loginSchema>;

export default function LoginPage() {
  const router = useRouter();
  const supabase = createClient();
  const [errorMessage, setErrorMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // 2. Configuramos React Hook Form
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
  });

  // 3. Función que se ejecuta al presionar "Iniciar Sesión"
  const onSubmit = async (data: LoginFormValues) => {
    setIsLoading(true);
    setErrorMessage('');

    // 1. Intentamos iniciar sesión en Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email: data.email,
      password: data.password,
    });

    if (authError || !authData.user) {
      setErrorMessage('Usuario o contraseña incorrectos.');
      setIsLoading(false);
      return;
    }

    // 2. Buscamos inmediatamente el rol de este usuario en la tabla 'profiles'
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', authData.user.id)
      .single();

    if (profileError || !profile) {
      setErrorMessage('Error al obtener el perfil asignado.');
      setIsLoading(false);
      return;
    }

    // 3. Redirección inteligente según el Rol exigido por el DDT
    if (profile.role === 'owner') {
      // El dueño tiene acceso total y va al Dashboard principal
      router.push('/');
    } else if (profile.role === 'cashier') {
      // El cajero no tiene acceso al Dashboard, lo mandamos directo al Punto de Venta
      router.push('/pos'); 
    }

    router.refresh(); // Refrescamos el estado de la sesión
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 font-sans">
      <div className="bg-white p-10 rounded-xl shadow-sm border border-slate-100 max-w-md w-full">
        
        {/* Cabecera (Logo y Títulos) */}
        <div className="flex flex-col items-center mb-8">
          <div className="mb-4 flex items-center justify-center">
  <Image
    src="/logo.webp"
    alt="Logo GaneshaStores"
    width={70}
    height={70}
    className="object-contain w-auto h-auto"
    priority
  />
</div>
     
          <p className="text-sm text-slate-500">Terminal de Acceso</p>
        </div>

        {/* Formulario */}
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
          
          {/* Campo Usuario (Correo) */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Usuario (Correo)</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                {/* Ícono de Usuario */}
                <svg className="h-5 w-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                </svg>
              </div>
              <input
                type="email"
                {...register('email')}
                className="block w-full pl-10 pr-3 py-2 border border-slate-200 rounded-md bg-white text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-600 focus:border-transparent transition"
                placeholder="Ingresa tu correo"
              />
            </div>
            {errors.email && <p className="text-red-500 text-xs mt-1">{errors.email.message}</p>}
          </div>

          {/* Campo Contraseña */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Contraseña</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                {/* Ícono de Candado */}
                <svg className="h-5 w-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              </div>
              <input
                type="password"
                {...register('password')}
                className="block w-full pl-10 pr-3 py-2 border border-slate-200 rounded-md bg-white text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-600 focus:border-transparent transition"
                placeholder="••••••••"
              />
            </div>
            {errors.password && <p className="text-red-500 text-xs mt-1">{errors.password.message}</p>}
          </div>

          {/* Mensaje de Error de Supabase */}
          {errorMessage && (
            <div className="bg-red-50 text-red-600 p-2 rounded text-sm text-center">
              {errorMessage}
            </div>
          )}

          {/* Botón de Enviar */}
          <button
            type="submit"
            disabled={isLoading}
            className="w-full flex justify-center items-center py-2.5 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-[#0f5c5c] hover:bg-[#0a4545] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-teal-500 transition disabled:opacity-50"
          >
            {isLoading ? 'Conectando...' : 'Iniciar Sesión'}
            {!isLoading && (
              <svg className="ml-2 -mr-1 h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
              </svg>
            )}
          </button>
        </form>

        {/* Footer (Aviso) */}
        <div className="mt-8 pt-6 border-t border-slate-100 flex flex-col items-center text-center">
          <svg className="h-5 w-5 text-slate-300 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
          </svg>
          <p className="text-xs text-slate-500">
            Acceso restringido según rol asignado.<br />
            Consulte al administrador para asistencia.
          </p>
        </div>

      </div>
    </div>
  );
}