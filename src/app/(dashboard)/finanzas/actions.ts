// src/app/(dashboard)/finanzas/actions.ts
'use server';

import { createClient } from '@/lib/supabase/server';
import { generateToken, hashToken } from '@/lib/finanzas/agent/auth';

/**
 * Crea un token para el GPT "Finanzas Ganesha".
 *
 * Va en el servidor para que el token se genere con el mismo hash que valida
 * la API. Se guarda SOLO el hash: el texto se devuelve una única vez para que
 * el dueño lo pegue en ChatGPT, y después no hay forma de recuperarlo (si se
 * pierde, se anula y se genera otro).
 *
 * Usa el cliente con la sesión del usuario, no la service_role: la política
 * RLS de fin_api_tokens (fin_is_owner) es la que decide si puede.
 */
export async function createFinAgentToken(label: string): Promise<{ token?: string; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: 'Sesión vencida. Vuelve a iniciar sesión.' };

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (profile?.role !== 'owner') return { error: 'Solo el dueño puede conectar ChatGPT.' };

  const token = generateToken();
  const { error } = await supabase.from('fin_api_tokens').insert({
    token_hash: hashToken(token),
    label: label.trim().slice(0, 60) || 'ChatGPT',
    profile_id: user.id,
  });
  if (error) return { error: `No se pudo crear el token: ${error.message}` };

  return { token };
}
