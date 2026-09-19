// De dónde se leen los precios de venta.
//
// Con ofertas instaladas, el precio a cobrar NO es `products.price` sino
// `v_products_priced.effective_price`, que el SQL calcula aplicando la oferta
// vigente (db/scanner_03_offers.sql). Toda pantalla que muestre o cobre un
// precio tiene que leer de la vista, o mostrará un número distinto al que
// cobra la caja y al que valida `register_exchange`.
//
// Las migraciones se aplican A MANO en Supabase, así que el front puede estar
// desplegado antes que el SQL. Por eso la fuente se degrada sola: la primera
// consulta que falle porque la vista no existe deja el módulo apuntando a
// `products` para el resto de la sesión, y el sistema se comporta como antes
// de las ofertas. Es una variable de módulo a propósito: lo que descubre una
// pantalla no lo tienen que volver a descubrir las demás.

import { isMissingTableError } from '@/lib/supabaseErrors';

const OFFER_COLS = 'effective_price, offer_id, offer_percent, offer_ends_at';

let source: 'view' | 'base' = 'view';

/** Tabla o vista a consultar. */
export function pricedTable(): string {
  return source === 'view' ? 'v_products_priced' : 'products';
}

/** Agrega las columnas de oferta a una lista de columnas, si están disponibles. */
export function pricedCols(cols: string): string {
  return source === 'view' ? `${cols}, ${OFFER_COLS}` : cols;
}

/**
 * ¿El error es "la vista todavía no existe"? Si lo es, degrada la fuente y
 * devuelve true para que quien llama reintente contra `products`.
 */
export function pricedFallback(error: { code?: string; message?: string } | null | undefined): boolean {
  if (source === 'view' && isMissingTableError(error)) {
    source = 'base';
    return true;
  }
  return false;
}

/** true mientras la vista de ofertas esté disponible. */
export function offersAvailable(): boolean {
  return source === 'view';
}
