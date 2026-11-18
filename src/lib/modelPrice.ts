// Precio por modelo: cambiar de una vez el precio de todas las variantes de un
// producto padre (db/precio_modelo_01.sql, propuesta del 17-nov-2026).
//
// El cambio lo hace SOLO el RPC `set_model_price`: todo o nada, el dueño sube
// o baja, un cajero con «Subir precios» solo sube (y le llega a Novedades como
// una línea). Cada tienda lo enciende o apaga en Usuarios
// (`store_settings.model_price_enabled`); apagado no se muestra el 💲.
//
// Sin el SQL aplicado todo degrada: el interruptor se lee como apagado y el
// inventario es el de siempre.

import type { SupabaseClient } from '@supabase/supabase-js';
import { isMissingFunctionError } from '@/lib/exchange';

export const MODEL_PRICE_MIGRATION_MISSING =
  'El precio por modelo todavía no está instalado en la base de datos (falta correr db/precio_modelo_01.sql en Supabase).';

/** 'same' = todas al mismo precio; 'add' = sumar lo mismo a cada una. */
export type ModelPriceMode = 'same' | 'add';

/** ¿Está encendido en esta tienda? Ante cualquier error (p. ej. SQL sin aplicar), no. */
export async function fetchModelPriceEnabled(supabase: SupabaseClient, storeId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('store_settings')
    .select('model_price_enabled')
    .eq('store_id', storeId)
    .maybeSingle();
  if (error) return false;
  return !!data?.model_price_enabled;
}

// Mensajes para los códigos que lanza set_model_price.
const ERRORS: Record<string, string> = {
  PRICE_NOT_HIGHER: 'Solo se puede subir: alguna variante quedaría más barata. Bajar precios solo lo puede hacer el dueño.',
  PRICE_CHANGE_NOT_ALLOWED: 'Solo el dueño puede cambiar estos precios.',
  NOT_AUTHORIZED: 'No tienes permiso para cambiar precios.',
  FEATURE_DISABLED: 'El precio por modelo está apagado en esta tienda (se enciende en Usuarios).',
  MODEL_CHANGED: 'El modelo cambió mientras tanto (se agregó o se quitó una variante). Revisa la lista y vuelve a guardar.',
  NOTHING_TO_CHANGE: 'Todas las variantes ya tienen ese precio.',
  PRICE_OUT_OF_RANGE: 'Algún precio quedaría en $0 o menos.',
  NO_VARIANTS: 'Este modelo no tiene variantes activas.',
  GROUP_INACTIVE: 'Este modelo está eliminado del inventario.',
  GROUP_NOT_FOUND: 'El modelo ya no existe. Refresca e intenta de nuevo.',
  INVALID_ARGUMENTS: 'El precio no es válido.',
};

export async function setModelPrice(
  supabase: SupabaseClient,
  groupId: string,
  mode: ModelPriceMode,
  value: number,
  expectedCount: number,
): Promise<{ changed: number; variants: number } | { error: string; modelChanged?: boolean }> {
  const { data, error } = await supabase.rpc('set_model_price', {
    p_group_id: groupId,
    p_mode: mode,
    p_value: value,
    p_expected_count: expectedCount,
  });
  if (error) {
    if (isMissingFunctionError(error)) return { error: MODEL_PRICE_MIGRATION_MISSING };
    const msg = error.message ?? '';
    const code = Object.keys(ERRORS).find(k => msg.includes(k));
    return {
      error: code ? ERRORS[code] : `No se pudieron cambiar los precios: ${msg}`,
      modelChanged: code === 'MODEL_CHANGED',
    };
  }
  const r = (data ?? {}) as Record<string, unknown>;
  return { changed: Number(r.changed) || 0, variants: Number(r.variants) || 0 };
}

const cents = (n: number) => Math.round(n * 100) / 100;

/** Lo que haría el RPC con un precio (misma cuenta que el SQL). */
export function newPriceFor(oldPrice: number, mode: ModelPriceMode, value: number): number {
  return mode === 'same' ? cents(value) : cents(cents(oldPrice) + cents(value));
}

// Orden de tallas para la lista de la ventana: primero las de letra en su
// orden de siempre, luego los números de menor a mayor, y el resto por texto.
const LETTER_SIZES = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', 'XXXL', '3XL', '4XL', '5XL'];

function sizeRank(talla: string | null): [number, number, string] {
  const t = (talla ?? '').trim().toUpperCase();
  const letter = LETTER_SIZES.indexOf(t);
  if (letter >= 0) return [0, letter, t];
  const num = parseFloat(t.replace(',', '.'));
  if (!Number.isNaN(num)) return [1, num, t];
  return [2, 0, t];
}

/** Variantes ordenadas por talla y luego por color, para mostrarlas en la ventana. */
export function sortVariants<T extends { talla: string | null; color: string | null }>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    const [ga, na, ta] = sizeRank(a.talla);
    const [gb, nb, tb] = sizeRank(b.talla);
    if (ga !== gb) return ga - gb;
    if (na !== nb) return na - nb;
    const byTalla = ta.localeCompare(tb, 'es', { numeric: true });
    if (byTalla !== 0) return byTalla;
    return (a.color ?? '').localeCompare(b.color ?? '', 'es');
  });
}
