// Buscar un producto por su código de barras EXACTO.
//
// Es la misma consulta que hace la caja cuando el lector USB teclea el código
// y Enter (antes vivía dentro de handleKeyDown en pos/page.tsx). La comparten
// el lector de teclado y el escáner con cámara (src/components/CameraScanner),
// para que los dos encuentren exactamente lo mismo.
//
// Lee de la vista con ofertas: el precio que se ve es el que se cobra. Si el
// SQL de ofertas no está aplicado, pricedFallback degrada a `products`.

import type { SupabaseClient } from '@supabase/supabase-js';
import { pricedFallback, pricedTable } from '@/lib/pricedProducts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ScannedProduct = any;

export async function findProductByBarcode(
  supabase: SupabaseClient,
  code: string,
): Promise<{ product: ScannedProduct | null; error: { message?: string } | null }> {
  const barcode = code.trim();
  if (!barcode) return { product: null, error: null };

  const run = (table: string) =>
    supabase.from(table).select('*').eq('sku_barcode', barcode).eq('is_active', true).maybeSingle();

  let res = await run(pricedTable());
  if (pricedFallback(res.error)) res = await run(pricedTable());
  return { product: res.data ?? null, error: res.error };
}
