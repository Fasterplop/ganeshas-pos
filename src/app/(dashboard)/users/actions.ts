// src/app/(dashboard)/users/actions.ts
'use server';

import { createClient } from '@supabase/supabase-js';

// Inicializamos el cliente administrador. 
// Nota: Usamos la librería base de supabase-js porque no necesitamos manejar cookies aquí.
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY! // ¡La llave secreta!
);

export async function createCashierAction(formData: any) {
  try {
    // 1. Crear el usuario en la tabla protegida auth.users
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: formData.email,
      password: formData.password,
      email_confirm: true, // Auto-confirmamos el correo para este MVP
    });

    if (authError) {
      return { success: false, error: authError.message };
    }

    if (!authData.user) {
      return { success: false, error: 'No se pudo crear el usuario.' };
    }

    // 2. Insertar el perfil en nuestra tabla pública 'profiles'
    const { error: profileError } = await supabaseAdmin.from('profiles').insert({
      id: authData.user.id,
      full_name: formData.full_name,
      role: 'cashier', // Forzamos el rol de cajero por seguridad
    });

    if (profileError) {
      // Si falla el perfil, idealmente borraríamos el usuario en auth, pero para el MVP basta con notificar
      return { success: false, error: 'Usuario creado en Auth, pero falló el Perfil: ' + profileError.message };
    }

    return { success: true };

  } catch (err: any) {
    return { success: false, error: err.message || 'Error desconocido en el servidor' };
  }
}