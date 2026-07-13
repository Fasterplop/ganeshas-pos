// src/app/(dashboard)/users/actions.ts
'use server';

import { createClient as createServerClient } from '@/lib/supabase/server';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function isOwner() {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) return false;

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  return profile?.role === 'owner';
}

export async function createCashierAction(formData: any) {
  if (!(await isOwner())) return { success: false, error: 'Acceso denegado: No tienes permisos.' };

  try {
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: formData.email,
      password: formData.password,
      email_confirm: true,
    });

    if (authError) return { success: false, error: authError.message };
    if (!authData.user) return { success: false, error: 'No se pudo crear el usuario.' };

    // Agregamos assigned_store_id a la inserción del perfil
    const { error: profileError } = await supabaseAdmin.from('profiles').insert({
      id: authData.user.id,
      full_name: formData.full_name,
      role: 'cashier',
      is_active: true, 
      assigned_store_id: formData.assigned_store_id, // <-- NUEVO CAMPO
    });

    if (profileError) return { success: false, error: 'Usuario en Auth creado, pero falló el perfil.' };

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || 'Error desconocido' };
  }
}

export async function getUsersAction() {
  if (!(await isOwner())) return { success: false, error: 'Acceso denegado' };

  try {
    // Traemos también assigned_store_id y el permiso especial de reposición
    const { data: profiles, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, role, is_active, assigned_store_id, can_restock_all')
      .order('full_name', { ascending: true });
      
    if (profileError) throw profileError;

    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.listUsers();
    if (authError) throw authError;

    const users = profiles.map(profile => {
      const authUser = authData.users.find((u: any) => u.id === profile.id);
      return {
        id: profile.id,
        full_name: profile.full_name,
        role: profile.role,
        is_active: profile.is_active ?? true,
        email: authUser?.email || 'Sin correo',
        assigned_store_id: profile.assigned_store_id, // <-- NUEVO CAMPO
        can_restock_all: profile.can_restock_all ?? false, // permiso especial de reposición
      };
    });

    return { success: true, users };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function setRestockPermissionAction(userId: string, value: boolean) {
  if (!(await isOwner())) return { success: false, error: 'Acceso denegado' };

  try {
    const { error } = await supabaseAdmin
      .from('profiles')
      .update({ can_restock_all: value })
      .eq('id', userId);

    if (error) return { success: false, error: error.message };
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function toggleUserActiveAction(userId: string, currentStatus: boolean) {
  if (!(await isOwner())) return { success: false, error: 'Acceso denegado' };

  try {
    const isActivating = !currentStatus;

    const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(
      userId,
      { ban_duration: isActivating ? 'none' : '876000h' } 
    );

    if (authError) return { success: false, error: authError.message };

    const { error: dbError } = await supabaseAdmin
      .from('profiles')
      .update({ is_active: isActivating })
      .eq('id', userId);

    if (dbError) return { success: false, error: dbError.message };

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}