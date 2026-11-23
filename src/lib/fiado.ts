// Fiado y Cuentas por cobrar (db/fiado_01_enum.sql + db/fiado_02_schema.sql).
//
// Una venta fiada es una fila normal de `sales` con payment_method = 'fiado'.
// Lo que debe = total_amount − sus abonos (`fiado_payments`). Los abonos solo
// se escriben con el RPC `fiado_abonar` (también el inicial, desde la caja) y
// los borra solo el dueño con `fiado_borrar_abono`.
//
// Quién fía y cobra: el dueño siempre; los demás, con el permiso
// profiles.can_fiar (Usuarios). Ese único permiso enciende a la vez el botón
// «Fiado» en la caja y «Cuentas por cobrar» en el menú.
//
// Sin el SQL aplicado todo degrada: nadie ve el botón ni la sección, y
// Reportes no cambia.

'use client';

import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/client';
import { isMissingColumnError } from '@/lib/supabaseErrors';

export const FIADO_MIGRATION_MISSING =
  'El fiado todavía no está instalado en la base de datos (falta correr db/fiado_01_enum.sql y db/fiado_02_schema.sql en Supabase).';

/** Métodos con los que se abona (sin Cashea). */
export type FiadoMethod = 'efectivo' | 'punto_de_venta' | 'zelle' | 'pago_movil';
export const FIADO_METHODS: { id: FiadoMethod; label: string; icon: string }[] = [
  { id: 'efectivo', label: 'Efectivo', icon: '💵' },
  { id: 'punto_de_venta', label: 'Punto de Venta', icon: '💳' },
  { id: 'zelle', label: 'Zelle', icon: '🔄' },
  { id: 'pago_movil', label: 'Pago Móvil', icon: '📱' },
];
export const FIADO_METHOD_LABEL: Record<string, string> = Object.fromEntries(
  FIADO_METHODS.map(m => [m.id, m.label]),
);

/** Evento de ventana: se registró o borró un abono (Reportes y el menú se refrescan). */
export const FIADO_CHANGED_EVENT = 'fiado-changed';

const FIADO_ERRORS: Record<string, string> = {
  NOT_AUTHORIZED: 'No tienes permiso para fiar ni cobrar abonos. Pídeselo al dueño.',
  INVALID_ARGUMENTS: 'El monto no es válido.',
  INVALID_METHOD: 'Revisa el método de pago del abono (los dos métodos deben ser distintos).',
  NOTHING_OWED: 'Este cliente ya no debe nada.',
  AMOUNT_EXCEEDS_BALANCE: 'El abono es mayor que lo que debe. Refresca e intenta de nuevo.',
  PAYMENT_NOT_FOUND: 'Ese abono ya no existe. Refresca la lista.',
  FIADO_NOT_ALLOWED: 'No tienes permiso para fiar. Pídeselo al dueño.',
  FIADO_NEEDS_CUSTOMER: 'Para fiar, agrega el cliente (cédula y nombre).',
  FIADO_INVALID: 'Una venta fiada no se puede dividir ni ir por Cashea.',
  FIADO_CHANGE_NOT_ALLOWED: 'Una venta fiada solo cambia registrando abonos.',
  FIADO_HAS_PAYMENTS: 'Esta venta fiada tiene abonos. Primero borra esos abonos en Cuentas por cobrar.',
  FIADO_CUSTOMER_OWES: 'Este cliente todavía debe un fiado. Primero tiene que terminar de pagar (Cuentas por cobrar).',
};

/** Traduce un error de los RPC / trigger de fiado a un mensaje para la cajera. */
export function fiadoErrorMessage(error: { message?: string; code?: string } | null | undefined): string {
  const msg = error?.message ?? '';
  for (const code of Object.keys(FIADO_ERRORS)) {
    if (msg.includes(code)) return FIADO_ERRORS[code];
  }
  if (error?.code === 'PGRST202' || /fiado_abonar|fiado_borrar_abono|fiado_payments/.test(msg) && /not find|does not exist/i.test(msg)) {
    return FIADO_MIGRATION_MISSING;
  }
  if (/invalid input value for enum .*"fiado"/i.test(msg)) return FIADO_MIGRATION_MISSING;
  return msg || 'Ocurrió un error inesperado.';
}

export type FiadoAccess = {
  /** Ya se sabe si puede (mientras tanto no se muestra nada). */
  ready: boolean;
  /** El SQL del fiado está aplicado. */
  installed: boolean;
  /** Puede fiar y cobrar abonos (dueño, o con el permiso). */
  allowed: boolean;
  isOwner: boolean;
};

/** ¿El usuario actual puede fiar? Lee su perfil una vez. */
export async function fetchFiadoAccess(supabase: SupabaseClient): Promise<Omit<FiadoAccess, 'ready'>> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { installed: false, allowed: false, isOwner: false };
  const { data, error } = await supabase
    .from('profiles')
    .select('role, is_active, can_fiar')
    .eq('id', user.id)
    .maybeSingle();
  if (error) {
    if (!isMissingColumnError(error, 'can_fiar')) console.warn('[fiado] no se pudo leer el permiso:', error.message);
    return { installed: false, allowed: false, isOwner: false };
  }
  const isOwner = data?.role === 'owner';
  const active = data?.is_active !== false;
  return { installed: true, allowed: active && (isOwner || !!data?.can_fiar), isOwner };
}

export function useFiadoAccess(): FiadoAccess {
  const [access, setAccess] = useState<FiadoAccess>({ ready: false, installed: false, allowed: false, isOwner: false });
  useEffect(() => {
    let alive = true;
    fetchFiadoAccess(createClient())
      .then(a => { if (alive) setAccess({ ready: true, ...a }); })
      .catch(() => { if (alive) setAccess({ ready: true, installed: false, allowed: false, isOwner: false }); });
    return () => { alive = false; };
  }, []);
  return access;
}

export type AbonoInput = {
  storeId: string;
  customerId: string;
  amount: number;
  method: FiadoMethod;
  ref?: string | null;
  method2?: FiadoMethod | null;
  amount2?: number | null;
  bcvRate?: number | null;
  /** Solo el abono inicial desde la caja: se aplica a esa venta. */
  saleId?: string | null;
};

/** Registra un abono. Devuelve lo que el cliente sigue debiendo en esa tienda. */
export async function registrarAbono(supabase: SupabaseClient, a: AbonoInput): Promise<number> {
  const { data, error } = await supabase.rpc('fiado_abonar', {
    p_store_id: a.storeId,
    p_customer_id: a.customerId,
    p_amount: Math.round(a.amount * 100) / 100,
    p_method: a.method,
    p_ref: a.ref?.trim() ? a.ref.trim() : null,
    p_method_2: a.method2 ?? null,
    p_amount_2: a.method2 && a.amount2 != null ? Math.round(a.amount2 * 100) / 100 : null,
    p_bcv_rate: a.bcvRate ?? null,
    p_sale_id: a.saleId ?? null,
  });
  if (error) throw new Error(fiadoErrorMessage(error));
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(FIADO_CHANGED_EVENT));
  return Number(data ?? 0);
}

/** Borra un abono completo (todas sus filas). Solo el dueño. */
export async function borrarAbono(supabase: SupabaseClient, batchId: string): Promise<void> {
  const { error } = await supabase.rpc('fiado_borrar_abono', { p_batch_id: batchId });
  if (error) throw new Error(fiadoErrorMessage(error));
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(FIADO_CHANGED_EVENT));
}

/** Redondeo a centavos para comparar montos. */
export const cents = (n: number) => Math.round(n * 100) / 100;
