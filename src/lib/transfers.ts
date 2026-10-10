// Transferencias de stock entre las dos tiendas.
//
// Transferir es mover UNIDADES entre las dos filas de `store_stock` que cada
// producto ya tiene (una por tienda). El producto NO cambia de tienda dueña:
// conserva su `owner_store_id`, su código, su etiqueta y sus ofertas.
//
// REGLA DE VISIBILIDAD que sale de acá: la caja de una tienda vende lo propio
// (`owner_store_id` = tienda activa) O lo que tenga unidades traídas (stock > 0
// en la fila de esa tienda). Nada de la otra tienda se vende sin traerlo
// primero: vender un producto ajeno sin transferirlo descuenta una fila que
// ninguna pantalla muestra (el descuadre que motivó el filtro por tienda).
//
// Todo movimiento va por el RPC `transfer_stock` (db/transfer_01_…sql): son dos
// filas de dos tiendas y el cajero solo puede escribir la suya, así que desde
// el navegador no se puede hacer bien. El RPC revalida rol y tienda, mueve por
// delta con las filas bloqueadas y deja el registro en `stock_transfers`.

import type { SupabaseClient } from '@supabase/supabase-js';
import { isMissingFunctionError } from '@/lib/exchange';
import { isMissingTableError } from '@/lib/supabaseErrors';

export interface StoreLite {
  id: string;
  name: string;
  is_active?: boolean | null;
}

/** Lo que la ventana de transferencia necesita saber del producto. */
export interface TransferProduct {
  id: string;
  name: string;
  sku_barcode?: string | null;
  talla?: string | null;
  color?: string | null;
  owner_store_id: string | null;
  /** Precio a cobrar; solo se muestra, no entra en ningún cálculo. */
  price?: number | null;
}

export type TransferSource = 'pos' | 'inventory' | 'ajuste';

/** Lo que devuelve `transfer_stock`. */
export interface TransferResult {
  transfer_id: string;
  product_id: string;
  from_store_id: string;
  to_store_id: string;
  quantity: number;
  from_stock: number;
  to_stock: number;
  /** true si era un reintento y se devolvió el movimiento ya hecho. */
  replayed: boolean;
}

/** Un producto de la otra tienda con unidades (o un descuadre) en esta. */
export interface ForeignStockRow {
  product: TransferProduct & { price: number };
  /** Stock en la tienda que se está viendo. Negativo = se vendió sin traerlo. */
  stock: number;
}

export interface TransferHistoryRow {
  id: string;
  created_at: string;
  quantity: number;
  source: TransferSource;
  note: string | null;
  from_store_id: string;
  to_store_id: string;
  products: { name: string; sku_barcode: string; talla: string | null; color: string | null } | null;
  profiles: { full_name: string } | null;
}

export const TRANSFER_MIGRATION_MISSING =
  'Las transferencias todavía no están instaladas en la base de datos (falta correr db/transfer_01_stock_transfers.sql en Supabase).';

// Mensajes para los códigos que lanza transfer_stock (RAISE EXCEPTION 'CODIGO').
// NOT_AUTHORIZED_STORE contiene a NOT_AUTHORIZED: el orden del objeto importa
// y por eso el específico va primero.
export const TRANSFER_ERRORS: Record<string, string> = {
  NOT_AUTHORIZED_STORE: 'Solo puedes transferir desde o hacia tu propia tienda.',
  NOT_AUTHORIZED: 'No tienes permiso para transferir productos.',
  INSUFFICIENT_STOCK: 'No hay suficientes unidades en la tienda de origen para esa cantidad.',
  INVALID_QUANTITY: 'La cantidad no es válida.',
  SAME_STORE: 'La tienda de origen y la de destino son la misma.',
  STORE_NOT_AVAILABLE: 'Una de las dos tiendas no está activa.',
  PRODUCT_INACTIVE: 'Este producto está eliminado del inventario: no se puede transferir.',
  PRODUCT_NOT_FOUND: 'El producto ya no existe. Refresca e intenta de nuevo.',
  INVALID_SOURCE: 'No se pudo registrar la transferencia (origen desconocido).',
  INVALID_ARGUMENTS: 'Faltan datos para hacer la transferencia.',
};

/** Traduce el error del RPC a un mensaje para el cajero. */
export function transferErrorMessage(
  error: { message?: string; code?: string } | null | undefined,
  fallback = 'No se pudo hacer la transferencia.',
): string {
  const msg = error?.message ?? '';
  for (const code of Object.keys(TRANSFER_ERRORS)) {
    if (msg.includes(code)) return TRANSFER_ERRORS[code];
  }
  if (isMissingFunctionError(error)) return TRANSFER_MIGRATION_MISSING;
  return msg || fallback;
}

/** ¿El producto es de otra tienda que la indicada? */
export function isForeign(ownerStoreId: string | null | undefined, storeId: string | null | undefined): boolean {
  return !!ownerStoreId && !!storeId && ownerStoreId !== storeId;
}

/**
 * La otra tienda. Devuelve null si no hay EXACTAMENTE una más activa: la
 * función está pensada para dos sucursales y con otra cantidad no sabría a
 * cuál transferir.
 */
export function otherStore<T extends StoreLite>(stores: T[], storeId: string | null | undefined): T | null {
  if (!storeId) return null;
  const others = stores.filter(s => s.id !== storeId && s.is_active !== false);
  return others.length === 1 ? others[0] : null;
}

// ¿Está aplicado el SQL de transferencias?
//
// Las migraciones se aplican A MANO en Supabase, así que el front puede estar
// desplegado antes que el SQL. Mientras no lo esté, la caja y el inventario se
// comportan exactamente como antes (sin botón, y un código de la otra tienda
// sigue siendo "no encontrado"). Es una variable de módulo a propósito, igual
// que en pricedProducts.ts: lo que descubre una pantalla sirve a las demás.
// Solo se guarda una respuesta definitiva; un fallo de red se vuelve a probar.
// (Después de aplicar el SQL hay que recargar la página para que se entere.)
let available: boolean | null = null;

export async function checkTransfersAvailable(supabase: SupabaseClient): Promise<boolean> {
  if (available !== null) return available;
  const { error } = await supabase.from('stock_transfers').select('id').limit(1);
  if (!error) {
    available = true;
    return true;
  }
  if (isMissingTableError(error)) {
    available = false;
  }
  return false;
}

/** Tiendas, para nombrar la tienda dueña de un producto ajeno. */
export async function fetchStores(supabase: SupabaseClient): Promise<StoreLite[]> {
  const { data } = await supabase.from('stores').select('id, name, is_active').order('name');
  return (data ?? []) as StoreLite[];
}

/** Stock de un producto en una tienda. null si no se pudo leer. */
export async function localStockOf(
  supabase: SupabaseClient,
  productId: string,
  storeId: string,
): Promise<number | null> {
  const { data, error } = await supabase
    .from('store_stock')
    .select('stock')
    .eq('product_id', productId)
    .eq('store_id', storeId)
    .maybeSingle();
  if (error) return null;
  return Number(data?.stock) || 0;
}

/** Stock de un producto en cada tienda: { [store_id]: stock }. null si falló. */
export async function stockByStore(
  supabase: SupabaseClient,
  productId: string,
): Promise<Record<string, number> | null> {
  const { data, error } = await supabase
    .from('store_stock')
    .select('store_id, stock')
    .eq('product_id', productId);
  if (error) return null;
  const map: Record<string, number> = {};
  for (const row of data ?? []) map[row.store_id as string] = Number(row.stock) || 0;
  return map;
}

export async function transferStock(
  supabase: SupabaseClient,
  args: {
    productId: string;
    fromStoreId: string;
    toStoreId: string;
    quantity: number;
    source: TransferSource;
    note?: string | null;
    /** Solo tiene efecto sobre la fila de la tienda dueña (ver el SQL). */
    allowNegative?: boolean;
    /** Mismo id en un reintento = no se mueve dos veces. */
    requestId?: string | null;
  },
): Promise<{ result: TransferResult | null; error: string | null }> {
  const { data, error } = await supabase.rpc('transfer_stock', {
    p_product_id: args.productId,
    p_from_store_id: args.fromStoreId,
    p_to_store_id: args.toStoreId,
    p_quantity: args.quantity,
    p_note: args.note?.trim() ? args.note.trim() : null,
    p_source: args.source,
    p_allow_negative: !!args.allowNegative,
    p_request_id: args.requestId ?? null,
  });

  if (error) {
    if (isMissingFunctionError(error)) available = false;
    return { result: null, error: transferErrorMessage(error) };
  }

  const r = (data ?? {}) as Record<string, unknown>;
  return {
    result: {
      transfer_id: String(r.transfer_id ?? ''),
      product_id: String(r.product_id ?? args.productId),
      from_store_id: String(r.from_store_id ?? args.fromStoreId),
      to_store_id: String(r.to_store_id ?? args.toStoreId),
      quantity: Number(r.quantity) || args.quantity,
      from_stock: Number(r.from_stock) || 0,
      to_stock: Number(r.to_stock) || 0,
      replayed: !!r.replayed,
    },
    error: null,
  };
}

const PAGE = 1000; // tope duro de PostgREST por respuesta

/**
 * Lo que el inventario de UNA tienda necesita saber de la otra:
 *   - foreignHere: productos de la otra tienda con stock distinto de 0 acá
 *     (positivo = traídos; negativo = vendidos sin traer, para regularizar).
 *   - awayByProduct: de MIS productos, cuántas unidades están en la otra.
 *
 * Va en consultas aparte y NUNCA se mezcla con la lista de productos del
 * inventario, que alimenta totales, Excel y el ajuste masivo de precios.
 * No lanza: si algo falla devuelve vacío y el inventario se ve como siempre.
 */
export async function fetchForeignStock(
  supabase: SupabaseClient,
  storeId: string,
): Promise<{ foreignHere: ForeignStockRow[]; awayByProduct: Record<string, number> }> {
  const foreignHere: ForeignStockRow[] = [];
  const awayByProduct: Record<string, number> = {};

  try {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('store_stock')
        .select('product_id, stock, products!inner(id, name, sku_barcode, talla, color, price, owner_store_id, is_active)')
        .eq('store_id', storeId)
        .neq('stock', 0)
        .neq('products.owner_store_id', storeId)
        .eq('products.is_active', true)
        .order('product_id')
        .range(from, from + PAGE - 1);
      if (error) break;
      for (const row of data ?? []) {
        // PostgREST devuelve la relación a-uno como objeto; el tipo generado
        // por supabase-js la marca como arreglo.
        const p = (Array.isArray(row.products) ? row.products[0] : row.products) as Record<string, unknown> | null;
        if (!p) continue;
        foreignHere.push({
          stock: Number(row.stock) || 0,
          product: {
            id: String(p.id),
            name: String(p.name ?? ''),
            sku_barcode: (p.sku_barcode as string) ?? null,
            talla: (p.talla as string) ?? null,
            color: (p.color as string) ?? null,
            owner_store_id: (p.owner_store_id as string) ?? null,
            price: Number(p.price) || 0,
          },
        });
      }
      if ((data ?? []).length < PAGE) break;
    }

    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('store_stock')
        .select('product_id, stock, products!inner(owner_store_id, is_active)')
        .neq('store_id', storeId)
        .neq('stock', 0)
        .eq('products.owner_store_id', storeId)
        .eq('products.is_active', true)
        .order('product_id')
        .range(from, from + PAGE - 1);
      if (error) break;
      for (const row of data ?? []) {
        const id = row.product_id as string;
        awayByProduct[id] = (awayByProduct[id] ?? 0) + (Number(row.stock) || 0);
      }
      if ((data ?? []).length < PAGE) break;
    }
  } catch {
    // Sin conexión o respuesta rara: el inventario sigue sin estos datos.
  }

  foreignHere.sort((a, b) => a.product.name.localeCompare(b.product.name));
  return { foreignHere, awayByProduct };
}

/**
 * Ids de los productos de la otra tienda que tienen unidades ACÁ, con su
 * stock. Es lo que la caja puede vender además de lo propio.
 */
export async function fetchForeignSellable(
  supabase: SupabaseClient,
  storeId: string,
): Promise<Record<string, number>> {
  const map: Record<string, number> = {};
  const { data, error } = await supabase
    .from('store_stock')
    .select('product_id, stock, products!inner(owner_store_id, is_active)')
    .eq('store_id', storeId)
    .gt('stock', 0)
    .neq('products.owner_store_id', storeId)
    .eq('products.is_active', true)
    .limit(200);
  if (error) return map;
  for (const row of data ?? []) map[row.product_id as string] = Number(row.stock) || 0;
  return map;
}

/** Últimos movimientos, del más reciente al más antiguo. */
export async function fetchTransferHistory(
  supabase: SupabaseClient,
  limit = 100,
): Promise<{ rows: TransferHistoryRow[]; error: string | null }> {
  const { data, error } = await supabase
    .from('stock_transfers')
    .select(`
      id, created_at, quantity, source, note, from_store_id, to_store_id,
      products (name, sku_barcode, talla, color),
      profiles (full_name)
    `)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    return {
      rows: [],
      error: isMissingTableError(error) ? TRANSFER_MIGRATION_MISSING : (error.message || 'No se pudo cargar el historial.'),
    };
  }
  return { rows: (data ?? []) as unknown as TransferHistoryRow[], error: null };
}

/** Texto corto de "desde dónde se hizo" para el historial. */
export const TRANSFER_SOURCE_LABEL: Record<TransferSource, string> = {
  pos: 'Caja',
  inventory: 'Inventario',
  ajuste: 'Ajuste',
};
