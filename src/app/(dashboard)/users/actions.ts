// src/app/(dashboard)/users/actions.ts
'use server';

import { ASSIGNABLE_ROLES, type AppRole } from '@/lib/roles';

import { createClient as createServerClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

const supabaseAdmin = createAdminClient();

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

    // El rol lo elige el dueño en el formulario. Se valida contra la lista
    // blanca ASSIGNABLE_ROLES: aunque el formData viene del navegador y podría
    // traer 'owner', acá solo se aceptan los roles que el dueño puede repartir.
    const rol: AppRole = ASSIGNABLE_ROLES.includes(formData.role) ? formData.role : 'cashier';

    const { error: profileError } = await supabaseAdmin.from('profiles').insert({
      id: authData.user.id,
      full_name: formData.full_name,
      role: rol,
      is_active: true, 
      assigned_store_id: formData.assigned_store_id,
    });

    if (profileError) {
      // Los valores 'consulta' y 'vendedor' del enum se agregan a mano en
      // Supabase (db/role_consulta_01_enum.sql y db/role_vendedor.sql). Si el
      // SQL no se corrió, Postgres responde 22P02 "invalid input value for
      // enum". Sin este aviso el dueño ve "falló el perfil" y no tiene forma
      // de saber qué falta.
      const esEnumSinAplicar =
        profileError.code === '22P02' || /invalid input value for enum/i.test(profileError.message ?? '');
      if (esEnumSinAplicar && rol !== 'cashier') {
        return {
          success: false,
          error: `El rol "${rol}" todavía no existe en la base de datos. Falta correr ${rol === 'vendedor' ? 'db/role_vendedor.sql' : 'db/role_consulta_01_enum.sql'} en Supabase.`,
        };
      }
      return { success: false, error: 'Usuario en Auth creado, pero falló el perfil.' };
    }

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || 'Error desconocido' };
  }
}

export async function getUsersAction() {
  if (!(await isOwner())) return { success: false, error: 'Acceso denegado' };

  try {
    // Traemos también assigned_store_id y el alcance de reposición (global/local).
    // Si la columna can_restock_local aún no existe (migración sin aplicar),
    // degradamos a la consulta anterior para no romper la vista de usuarios.
    // can_restock_local es opcional en el tipo para admitir ambas consultas.
    type ProfileRow = {
      id: string;
      full_name: string;
      role: string;
      is_active: boolean | null;
      assigned_store_id: string | null;
      can_restock_all: boolean | null;
      can_restock_local?: boolean | null;
      can_raise_prices?: boolean | null;
      phone_simple_mode?: boolean | null;
    };

    // Primero con los permisos de db/novedades_01…sql (subir precios y modo
    // teléfono); sin esas columnas, la consulta de siempre.
    const withPerms = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, role, is_active, assigned_store_id, can_restock_all, can_restock_local, can_raise_prices, phone_simple_mode')
      .order('full_name', { ascending: true });

    const primary = withPerms.error
      ? await supabaseAdmin
          .from('profiles')
          .select('id, full_name, role, is_active, assigned_store_id, can_restock_all, can_restock_local')
          .order('full_name', { ascending: true })
      : withPerms;
    const permsInstalled = !withPerms.error;

    let profiles: ProfileRow[] | null = primary.data;
    if (primary.error) {
      const fallback = await supabaseAdmin
        .from('profiles')
        .select('id, full_name, role, is_active, assigned_store_id, can_restock_all')
        .order('full_name', { ascending: true });
      if (fallback.error) throw fallback.error;
      profiles = fallback.data;
    }

    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.listUsers();
    if (authError) throw authError;

    const users = (profiles ?? []).map(profile => {
      const authUser = authData.users.find((u: any) => u.id === profile.id);
      return {
        id: profile.id,
        full_name: profile.full_name,
        role: profile.role,
        is_active: profile.is_active ?? true,
        email: authUser?.email || 'Sin correo',
        assigned_store_id: profile.assigned_store_id, // <-- NUEVO CAMPO
        can_restock_all: profile.can_restock_all ?? false, // reponer en TODAS las tiendas
        can_restock_local: profile.can_restock_local ?? false, // reponer solo en su tienda
        can_raise_prices: profile.can_raise_prices ?? false,   // subir precios (nunca bajarlos)
        phone_simple_mode: profile.phone_simple_mode ?? false, // en el teléfono: solo precio y caja
      };
    });

    return { success: true, users, permsInstalled };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// Alcance de reposición de un cajero: 'none' (sin reposición), 'local' (solo su
// tienda asignada) o 'global' (todas las tiendas). Guarda las dos banderas de
// forma consistente para que el POS y el RPC restock_stock las interpreten igual.
type RestockScope = 'none' | 'local' | 'global';

export async function setRestockScopeAction(userId: string, scope: RestockScope) {
  if (!(await isOwner())) return { success: false, error: 'Acceso denegado' };

  try {
    const { error } = await supabaseAdmin
      .from('profiles')
      .update({
        can_restock_all: scope === 'global',
        can_restock_local: scope === 'local',
      })
      .eq('id', userId);

    if (error) return { success: false, error: error.message };
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// Permisos de db/novedades_01…sql. Van por el admin client, como la
// reposición: el trigger profiles_perm_guard rechaza que un no-dueño los
// cambie con su propia sesión.
export async function setCanRaisePricesAction(userId: string, value: boolean) {
  if (!(await isOwner())) return { success: false, error: 'Acceso denegado' };
  try {
    const { error } = await supabaseAdmin.from('profiles').update({ can_raise_prices: value }).eq('id', userId);
    if (error) return { success: false, error: error.message };
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function setPhoneSimpleModeAction(userId: string, value: boolean) {
  if (!(await isOwner())) return { success: false, error: 'Acceso denegado' };
  try {
    const { error } = await supabaseAdmin.from('profiles').update({ phone_simple_mode: value }).eq('id', userId);
    if (error) return { success: false, error: error.message };
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
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