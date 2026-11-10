// Códigos automáticos de producto (PREFIJO-6 dígitos) que no chocan con uno
// que ya existe.
//
// Hasta noviembre de 2026 el número se sorteaba sin mirar la base. Con 5.705
// códigos ROP ya ocupados (de 900.000 posibles), cada talla tenía ~0,6% de
// caer en uno usado: el UNIQUE de products.sku_barcode la rechazaba y el
// modelo quedaba sin esa talla. En un modelo de 20 tallas pasaba ~1 de cada 8
// veces, y las empleadas tenían que buscar a mano cuál faltaba.
//
// La consulta mira la tabla entera, activos e inactivos, igual que el UNIQUE
// (la lectura de products es USING (true) para cualquiera con sesión).
//
// Nunca impide guardar: si la consulta falla o tarda, devuelve los códigos sin
// comprobar, que es lo que se hacía antes. El inventario igual reacciona si la
// base rechaza uno (ver el manejo del 23505 en inventory/page.tsx).

import type { SupabaseClient } from '@supabase/supabase-js';

/** Mismo formato de siempre: PREFIJO-100000…999999. */
export function randomSku(prefix: string): string {
  return `${prefix}-${Math.floor(100000 + Math.random() * 900000)}`;
}

const CHECK_TIMEOUT_MS = 8000;
const CHUNK = 100;
const MAX_ROUNDS = 5;

/** De `codes`, los que ya tiene algún producto. null si no se pudo saber. */
async function takenAmong(supabase: SupabaseClient, codes: string[]): Promise<Set<string> | null> {
  const taken = new Set<string>();
  try {
    for (let i = 0; i < codes.length; i += CHUNK) {
      const { data, error } = await supabase
        .from('products')
        .select('sku_barcode')
        .in('sku_barcode', codes.slice(i, i + CHUNK))
        .abortSignal(AbortSignal.timeout(CHECK_TIMEOUT_MS));
      if (error) return null;
      for (const r of (data ?? []) as { sku_barcode: string }[]) taken.add(r.sku_barcode);
    }
    return taken;
  } catch {
    return null;
  }
}

/**
 * `n` códigos distintos con ese prefijo que ningún producto tiene. Si no se
 * puede comprobar, los devuelve igual (sin comprobar). Nunca falla.
 */
export async function pickFreeSkus(supabase: SupabaseClient, prefix: string, n: number): Promise<string[]> {
  if (n <= 0) return [];
  const used = new Set<string>();
  const fresh = () => {
    let c = randomSku(prefix);
    while (used.has(c)) c = randomSku(prefix);
    used.add(c);
    return c;
  };
  const codes = Array.from({ length: n }, fresh);

  let pending = codes.map((_, i) => i);
  for (let round = 0; round < MAX_ROUNDS && pending.length > 0; round++) {
    const taken = await takenAmong(supabase, pending.map(i => codes[i]));
    if (!taken) break; // sin comprobar: como antes
    pending = pending.filter(i => taken.has(codes[i]));
    for (const i of pending) codes[i] = fresh();
  }
  return codes;
}
