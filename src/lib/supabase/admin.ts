// Cliente de Supabase con la service_role: SOLO para código de servidor
// (server actions y route handlers). Se salta la RLS, así que quien lo use
// tiene que hacer su propia comprobación de permisos antes de tocar datos.
//
// Nunca importarlo desde un componente 'use client': la clave viajaría al
// navegador.
import { createClient } from '@supabase/supabase-js';

export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
