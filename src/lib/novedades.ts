// Subidas de precio por cajero y Novedades del dueño.
//
// Un cajero con el permiso «Subir precios» (profiles.can_raise_prices) cambia
// un precio SOLO con el RPC `raise_product_price` (db/novedades_01_…sql): ahí
// se valida que el precio nuevo sea mayor y queda el registro en
// `price_changes`. Un trigger en `products` rechaza cualquier otro cambio de
// precio que no sea del dueño, así que bajar un precio no se puede ni desde la
// consola del navegador.
//
// Novedades junta, para el dueño, esas subidas, las transferencias entre
// tiendas que hicieron otros (`stock_transfers`, cuya nota es el motivo) y los
// traslados (`store_shipments`, db/traslados_01.sql): los envíos de las
// cajeras, cada «Falta algo» y lo que se deshizo. Lo "nuevo" es lo posterior a
// profiles.novedades_seen_at.
//
// Sin el SQL aplicado todo degrada: la lista sale vacía, el contador en 0 y
// subir un precio avisa qué archivo falta correr.

import type { SupabaseClient } from '@supabase/supabase-js';
import { isMissingFunctionError } from '@/lib/exchange';
import { isMissingColumnError, isMissingTableError } from '@/lib/supabaseErrors';

export const NOVEDADES_MIGRATION_MISSING =
  'Novedades todavía no está instalado en la base de datos (falta correr db/novedades_01_precios_y_telefono.sql en Supabase).';

/** Evento de ventana: el dueño marcó todo como visto (el menú baja el contador). */
export const NOVEDADES_SEEN_EVENT = 'novedades-seen';

// Mensajes para los códigos que lanza raise_product_price.
const RAISE_ERRORS: Record<string, string> = {
  PRICE_NOT_HIGHER: 'El precio nuevo tiene que ser mayor que el actual. Bajar un precio solo lo puede hacer el dueño.',
  PRICE_CHANGE_NOT_ALLOWED: 'Solo el dueño puede cambiar este precio.',
  NOT_AUTHORIZED: 'No tienes permiso para subir precios.',
  PRODUCT_INACTIVE: 'Este producto está eliminado del inventario.',
  PRODUCT_NOT_FOUND: 'El producto ya no existe. Refresca e intenta de nuevo.',
  INVALID_ARGUMENTS: 'El precio no es válido.',
};

export async function raiseProductPrice(
  supabase: SupabaseClient,
  productId: string,
  newPrice: number,
): Promise<{ oldPrice: number; newPrice: number } | { error: string }> {
  const { data, error } = await supabase.rpc('raise_product_price', {
    p_product_id: productId,
    p_new_price: newPrice,
  });
  if (error) {
    if (isMissingFunctionError(error)) return { error: NOVEDADES_MIGRATION_MISSING };
    const msg = error.message ?? '';
    const code = Object.keys(RAISE_ERRORS).find(k => msg.includes(k));
    return { error: code ? RAISE_ERRORS[code] : `No se pudo subir el precio: ${msg}` };
  }
  const r = (data ?? {}) as Record<string, unknown>;
  return { oldPrice: Number(r.old_price) || 0, newPrice: Number(r.new_price) || newPrice };
}

// --- Novedades ----------------------------------------------------------------

export type NovedadKind = 'price' | 'transfer' | 'traslado';

/** Qué pasó con un traslado. */
export type TrasladoEvent = 'enviado' | 'incompleto' | 'deshecho';

export interface Novedad {
  id: string;
  kind: NovedadKind;
  created_at: string;
  who: string;
  productName: string;
  sku: string;
  talla: string | null;
  color: string | null;
  // Subida de precio
  oldPrice?: number;
  newPrice?: number;
  // Transferencia
  quantity?: number;
  fromStoreId?: string;
  toStoreId?: string;
  note?: string | null;
  source?: string;
  changesOwner?: boolean;
  // Traslado (fromStoreId, toStoreId y note se comparten con la transferencia)
  event?: TrasladoEvent;
  pieces?: number;
  missing?: number;
}

type ProductEmbed = { name: string; sku_barcode: string; talla: string | null; color: string | null } | null;

const LIMIT = 200;

/**
 * Lo último de las tres fuentes, mezclado del más reciente al más antiguo. Lo
 * que hizo el propio dueño no entra: no es novedad para él.
 */
export async function fetchNovedades(
  supabase: SupabaseClient,
  ownerId: string,
): Promise<{ rows: Novedad[]; error: string | null }> {
  const [prices, transfers, shipments] = await Promise.all([
    supabase
      .from('price_changes')
      .select('id, created_at, old_price, new_price, products (name, sku_barcode, talla, color), profiles (full_name)')
      .order('created_at', { ascending: false })
      .limit(LIMIT),
    supabase
      .from('stock_transfers')
      .select('id, created_at, quantity, source, note, from_store_id, to_store_id, changes_owner, products (name, sku_barcode, talla, color), profiles (full_name)')
      .neq('created_by', ownerId)
      .order('created_at', { ascending: false })
      .limit(LIMIT),
    // Sin db/traslados_01.sql la tabla no existe: el error se ignora abajo.
    supabase
      .from('store_shipments')
      .select(
        'id, created_at, created_by, received_at, undone_at, undone_by, status, pieces, note, from_store_id, to_store_id, ' +
          'author:profiles!store_shipments_author_fkey (full_name), receiver:profiles!store_shipments_receiver_fkey (full_name), ' +
          'undoer:profiles!store_shipments_undoer_fkey (full_name), store_shipment_items (missing)',
      )
      .order('created_at', { ascending: false })
      .limit(LIMIT),
  ]);

  if (prices.error && isMissingTableError(prices.error)) {
    return { rows: [], error: NOVEDADES_MIGRATION_MISSING };
  }
  if (prices.error) return { rows: [], error: prices.error.message || 'No se pudieron cargar las novedades.' };
  if (transfers.error) return { rows: [], error: transfers.error.message || 'No se pudieron cargar las transferencias.' };

  const rows: Novedad[] = [];
  for (const raw of prices.data ?? []) {
    const p = raw as unknown as {
      id: string; created_at: string; old_price: number; new_price: number;
      products: ProductEmbed; profiles: { full_name: string } | null;
    };
    rows.push({
      id: `p-${p.id}`,
      kind: 'price',
      created_at: p.created_at,
      who: p.profiles?.full_name ?? 'Desconocido',
      productName: p.products?.name ?? 'Producto eliminado',
      sku: p.products?.sku_barcode ?? '',
      talla: p.products?.talla ?? null,
      color: p.products?.color ?? null,
      oldPrice: Number(p.old_price) || 0,
      newPrice: Number(p.new_price) || 0,
    });
  }
  for (const raw of transfers.data ?? []) {
    const t = raw as unknown as {
      id: string; created_at: string; quantity: number; source: string; note: string | null;
      from_store_id: string; to_store_id: string; changes_owner: boolean | null;
      products: ProductEmbed; profiles: { full_name: string } | null;
    };
    rows.push({
      id: `t-${t.id}`,
      kind: 'transfer',
      created_at: t.created_at,
      who: t.profiles?.full_name ?? 'Desconocido',
      productName: t.products?.name ?? 'Producto eliminado',
      sku: t.products?.sku_barcode ?? '',
      talla: t.products?.talla ?? null,
      color: t.products?.color ?? null,
      quantity: Number(t.quantity) || 0,
      fromStoreId: t.from_store_id,
      toStoreId: t.to_store_id,
      note: t.note,
      source: t.source,
      changesOwner: !!t.changes_owner,
    });
  }
  if (!shipments.error) {
    type Who = { full_name: string } | { full_name: string }[] | null;
    const nameOf = (w: Who) => (Array.isArray(w) ? w[0]?.full_name : w?.full_name) ?? 'Desconocido';
    for (const raw of shipments.data ?? []) {
      const s = raw as unknown as {
        id: string; created_at: string; created_by: string; received_at: string | null; undone_at: string | null;
        undone_by: string | null; status: string; pieces: number; note: string; from_store_id: string; to_store_id: string;
        author: Who; receiver: Who; undoer: Who; store_shipment_items: { missing: number }[] | null;
      };
      const base = {
        kind: 'traslado' as const, productName: '', sku: '', talla: null, color: null,
        pieces: Number(s.pieces) || 0, fromStoreId: s.from_store_id, toStoreId: s.to_store_id, note: s.note,
      };
      if (s.created_by !== ownerId) {
        rows.push({ ...base, id: `s-${s.id}`, event: 'enviado', created_at: s.created_at, who: nameOf(s.author) });
      }
      if (s.status === 'incompleto' && s.received_at) {
        const missing = (s.store_shipment_items ?? []).reduce((a, it) => a + (Number(it.missing) || 0), 0);
        rows.push({ ...base, id: `si-${s.id}`, event: 'incompleto', created_at: s.received_at, who: nameOf(s.receiver), missing });
      }
      if (s.status === 'deshecho' && s.undone_at && s.undone_by !== ownerId) {
        rows.push({ ...base, id: `sd-${s.id}`, event: 'deshecho', created_at: s.undone_at, who: nameOf(s.undoer) });
      }
    }
  }
  rows.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  return { rows, error: null };
}

/** Hasta dónde vio el dueño (null = nunca marcó; todo cuenta como nuevo). */
export async function fetchNovedadesSeenAt(
  supabase: SupabaseClient,
  ownerId: string,
): Promise<{ seenAt: string | null; installed: boolean }> {
  const { data, error } = await supabase
    .from('profiles')
    .select('novedades_seen_at')
    .eq('id', ownerId)
    .single();
  if (error) return { seenAt: null, installed: !isMissingColumnError(error, 'novedades_seen_at') };
  return { seenAt: (data?.novedades_seen_at as string | null) ?? null, installed: true };
}

/** Cuántas novedades no ha visto el dueño. 0 si algo falla. */
export async function fetchNovedadesCount(
  supabase: SupabaseClient,
  ownerId: string,
): Promise<number> {
  try {
    const { seenAt, installed } = await fetchNovedadesSeenAt(supabase, ownerId);
    if (!installed) return 0;
    const head = { count: 'exact' as const, head: true };
    let prices = supabase.from('price_changes').select('id', head);
    let transfers = supabase.from('stock_transfers').select('id', head).neq('created_by', ownerId);
    // Traslados: los mismos tres hechos que fetchNovedades.
    let sent = supabase.from('store_shipments').select('id', head).neq('created_by', ownerId);
    let incomplete = supabase.from('store_shipments').select('id', head).eq('status', 'incompleto');
    let undone = supabase.from('store_shipments').select('id', head).eq('status', 'deshecho').neq('undone_by', ownerId);
    if (seenAt) {
      prices = prices.gt('created_at', seenAt);
      transfers = transfers.gt('created_at', seenAt);
      sent = sent.gt('created_at', seenAt);
      incomplete = incomplete.gt('received_at', seenAt);
      undone = undone.gt('undone_at', seenAt);
    }
    const results = await Promise.all([prices, transfers, sent, incomplete, undone]);
    // Una fuente que falla (p. ej. traslados sin instalar) cuenta 0.
    return results.reduce((a, r) => a + (r.error ? 0 : r.count ?? 0), 0);
  } catch {
    return 0;
  }
}

export async function markNovedadesSeen(
  supabase: SupabaseClient,
): Promise<{ seenAt: string | null; error: string | null }> {
  const { data, error } = await supabase.rpc('mark_novedades_seen');
  if (error) {
    if (isMissingFunctionError(error)) return { seenAt: null, error: NOVEDADES_MIGRATION_MISSING };
    return { seenAt: null, error: error.message || 'No se pudo marcar como visto.' };
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(NOVEDADES_SEEN_EVENT));
  return { seenAt: (data as string | null) ?? new Date().toISOString(), error: null };
}
