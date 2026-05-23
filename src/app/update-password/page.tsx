'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { createClient } from '@/lib/supabase/client';
import Image from 'next/image';

const updatePasswordSchema = z.object({
  password: z.string().min(6, { message: 'La contraseña debe tener al menos 6 caracteres' }),
  confirmPassword: z.string()
}).refine((data) => data.password === data.confirmPassword, {
  message: "Las contraseñas no coinciden",
  path: ["confirmPassword"]
});

type UpdatePasswordValues = z.infer<typeof updatePasswordSchema>;

export default function UpdatePasswordPage() {
  const router = useRouter();
  const supabase = createClient();
  const [errorMessage, setErrorMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<UpdatePasswordValues>({
    resolver: zodResolver(updatePasswordSchema),
  });

  const onSubmit = async (data: UpdatePasswordValues) => {
    setIsLoading(true);
    setErrorMessage('');

    // Actualizamos la contraseña del usuario que ya está autenticado gracias al callback
    const { error } = await supabase.auth.updateUser({
      password: data.password
    });

    if (error) {
      setErrorMessage('Hubo un error al actualizar la contraseña. Pide un nuevo enlace.');
      setIsLoading(false);
      return;
    }

    // Una vez actualizado, lo mandamos al login para que entre con su nueva clave (o al dashboard directo)
    // Supabase cierra las demás sesiones al cambiar clave, así que enviarlo al login es buena práctica.
    await supabase.auth.signOut();
    router.push('/login?message=Contraseña actualizada con éxito');
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 font-sans">
      <div className="bg-white p-10 rounded-xl shadow-sm border border-slate-100 max-w-md w-full">
        
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
          <p className="text-sm text-slate-500">Crear Nueva Contraseña</p>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
          
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Nueva Contraseña</label>
            <input
              type="password"
              {...register('password')}
              className="block w-full px-3 py-2 border border-slate-200 rounded-md bg-white text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-600 transition"
              placeholder="••••••••"
            />
            {errors.password && <p className="text-red-500 text-xs mt-1">{errors.password.message}</p>}
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Confirmar Contraseña</label>
            <input
              type="password"
              {...register('confirmPassword')}
              className="block w-full px-3 py-2 border border-slate-200 rounded-md bg-white text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-600 transition"
              placeholder="••••••••"
            />
            {errors.confirmPassword && <p className="text-red-500 text-xs mt-1">{errors.confirmPassword.message}</p>}
          </div>

          {errorMessage && (
            <div className="bg-red-50 text-red-600 p-2 rounded text-sm text-center">
              {errorMessage}
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full py-2.5 px-4 rounded-md shadow-sm text-sm font-medium text-white bg-[#0f5c5c] hover:bg-[#0a4545] focus:outline-none transition disabled:opacity-50"
          >
            {isLoading ? 'Actualizando...' : 'Guardar Contraseña'}
          </button>
        </form>
      </div>
    </div>
  );
}