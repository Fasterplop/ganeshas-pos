// Traslados: envíos en lote de una tienda a la otra.
//
// Las reglas viven en el SQL (db/traslados_01.sql): a qué producto llega cada
// pieza, todo o nada, negativos, quién puede. Este archivo es el lado de la
// pantalla:
//   * leer el catálogo de la tienda destino y los enlaces guardados,
//   * PROPONER a qué producto padre llega cada modelo (✓ mismo nombre,
//     ≈ parecido, ＋ no lo tiene) — la cajera lo ve antes de enviar,
//   * buscar lo que se pistolea (la etiqueta de la otra tienda encuentra su
//     gemelo),
//   * llamar a los cuatro RPC y traducir sus errores,
//   * guardar el borrador («Seguir después») en este navegador.
//
// Lo que se propone acá el servidor lo vuelve a decidir: la pantalla manda el
// modelo o el producto elegido y el RPC valida que sea de la tienda destino.

import type { SupabaseClient } from '@supabase/supabase-js';
import { findProductByBarcode, type ScannedProduct } from '@/lib/barcodeLookup';
import { isMissingFunctionError } from '@/lib/exchange';
import { pricedFallback, pricedTable } from '@/lib/pricedProducts';
import { isMissingTableError } from '@/lib/supabaseErrors';

export const TRASLADOS_MIGRATION_MISSING =
  'Traslados todavía no está instalado en la base de datos (falta correr db/traslados_01.sql en Supabase).';

export type ShipmentStatus = 'pendiente' | 'recibido' | 'incompleto' | 'deshecho';
/** Cómo se decidió a qué producto llegó una pieza (store_shipment_items.match). */
export type MatchKind = 'vuelve' | 'enlazado' | 'mismo' | 'parecido' | 'elegido' | 'origen';

const PAGE = 1000;

// --- Errores ---------------------------------------------------------------

// Mensajes para los códigos de db/traslados_01.sql. Algunos llegan como
// 'CODIGO:ROP-1182' (el código de la pieza que falló): {sku} se reemplaza.
// NOT_AUTHORIZED_STORE contiene a NOT_AUTHORIZED: el específico va primero.
const ERRORS: Record<string, string> = {
  NOT_AUTHORIZED_STORE: 'Solo puedes enviar desde tu tienda y recibir lo que llega a ella.',
  NOT_AUTHORIZED: 'No tienes permiso para hacer traslados.',
  ONLY_OWNER_AFTER_RECEIVED: 'La otra tienda ya confirmó este envío: solo Gerardo lo puede deshacer. Para devolver algo, envíalo de vuelta.',
  INSUFFICIENT_STOCK: 'No hay unidades de {sku} en esta tienda (es de la otra tienda y aquí no queda ninguna). No se envió nada.',
  TARGET_INVALID: 'El producto elegido para {sku} ya no está en la otra tienda. Elige otro. No se envió nada.',
  PRODUCT_INACTIVE: '{sku} está eliminado del inventario: quítalo del envío. No se envió nada.',
  PRODUCT_NOT_FOUND: 'Una pieza ya no existe. Quítala y vuelve a intentar. No se envió nada.',
  SOLD_IN_DESTINATION: 'Ya se vendió {sku} en la otra tienda: no se puede devolver todo. Si hace falta, envíalo de vuelta con un traslado nuevo.',
  INVALID_QUANTITY: 'Una cantidad no es válida.',
  SAME_STORE: 'La tienda de origen y la de destino son la misma.',
  STORE_NOT_AVAILABLE: 'Una de las dos tiendas no está activa.',
  NOTE_REQUIRED: 'Escribe el motivo del envío.',
  EMPTY_SHIPMENT: 'No hay piezas para enviar.',
  TOO_MANY_LINES: 'Son demasiadas piezas para un solo envío: divídelo en dos.',
  SKU_GENERATION_FAILED: 'No se pudo crear el código de una variante nueva. Intenta de nuevo.',
  SHIPMENT_NOT_FOUND: 'Ese envío ya no existe. Refresca la pantalla.',
  SHIPMENT_NOT_PENDING: 'Ese envío ya se confirmó o se deshizo. Refresca la pantalla.',
  ALREADY_UNDONE: 'Ese envío ya se había deshecho.',
  MISSING_INVALID: 'Revisa las cantidades que faltan.',
  ITEM_NOT_RELINKABLE: 'Esa pieza ya tiene su producto.',
  INVALID_ARGUMENTS: 'Faltan datos para hacer el traslado.',
};

export function trasladoErrorMessage(
  error: { message?: string; code?: string } | null | undefined,
  fallback = 'No se pudo hacer el traslado.',
): string {
  const msg = error?.message ?? '';
  for (const code of Object.keys(ERRORS)) {
    const at = msg.indexOf(code);
    if (at === -1) continue;
    const rest = msg.slice(at + code.length);
    const sku = rest.startsWith(':') ? rest.slice(1).trim().split(/\s/)[0] : '';
    return ERRORS[code].replace('{sku}', sku || 'una pieza');
  }
  if (isMissingFunctionError(error)) return TRASLADOS_MIGRATION_MISSING;
  return msg || fallback;
}

// ¿Está aplicado el SQL? Igual que en transfers.ts: variable de módulo, solo
// se guarda una respuesta definitiva.
let available: boolean | null = null;

export async function checkTrasladosAvailable(supabase: SupabaseClient): Promise<boolean> {
  if (available !== null) return available;
  const { error } = await supabase.from('store_shipments').select('id').limit(1);
  if (!error) {
    available = true;
    return true;
  }
  if (isMissingTableError(error)) available = false;
  return false;
}

// --- Nombres: ✓ mismo, ≈ parecido ------------------------------------------

/**
 * Talla y color comparables: sin acentos, en mayúsculas, un solo espacio.
 * Es la misma regla que traslado_norm() en db/traslados_01.sql: si se toca una,
 * la otra.
 */
export function normText(s: string | null | undefined): string {
  return (s ?? '')
    .replace(/[áéíóúüÁÉÍÓÚÜ]/g, (c) => ({ á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u', ü: 'u', Á: 'A', É: 'E', Í: 'I', Ó: 'O', Ú: 'U', Ü: 'U' })[c] ?? c)
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/** Palabras de un nombre de producto, sin signos: 'Gorra Nike (Unisex)' → GORRA, NIKE, UNISEX. */
function nameWords(name: string): string[] {
  return normText(name).replace(/[^A-Z0-9Ñ ]+/g, ' ').split(' ').filter(Boolean);
}

/** Nombre comparable de un modelo. */
export const nameKey = (name: string) => nameWords(name).join(' ');

/**
 * ¿Se parecen dos nombres? Sí cuando todas las palabras del más corto están en
 * el otro («Gorra Nike» y «Gorra Nike Unisex») o cuando comparten al menos el
 * 60 % de las palabras. Devuelve un puntaje (0 = no se parecen) para elegir el
 * mejor candidato.
 */
export function nameSimilarity(a: string, b: string): number {
  const wa = new Set(nameWords(a));
  const wb = new Set(nameWords(b));
  if (wa.size === 0 || wb.size === 0) return 0;
  let common = 0;
  let meaningful = 0; // palabras en común de 3 letras o más: «DE» o «2» solas no cuentan
  for (const w of wa) {
    if (!wb.has(w)) continue;
    common++;
    if (w.length >= 3) meaningful++;
  }
  if (meaningful === 0) return 0;
  const contained = common === Math.min(wa.size, wb.size);
  const jaccard = common / (wa.size + wb.size - common);
  if (contained && Math.min(wa.size, wb.size) >= 2) return 0.6 + jaccard * 0.4;
  return jaccard >= 0.6 ? jaccard : 0;
}

// --- Catálogo de la tienda destino ------------------------------------------

export interface DestGroup {
  id: string;
  name: string;
  category: string;
  default_price: number;
}

export interface DestProduct {
  id: string;
  sku_barcode: string;
  name: string;
  talla: string | null;
  color: string | null;
  price: number;
  parent_group_id: string | null;
}

/**
 * Modelos y productos activos de una tienda, paginados (PostgREST corta en
 * 1000 filas sin avisar). Se lee una vez al abrir el envío.
 */
export async function fetchStoreCatalog(
  supabase: SupabaseClient,
  storeId: string,
): Promise<{ groups: DestGroup[]; products: DestProduct[]; error: string | null }> {
  const groups: DestGroup[] = [];
  const products: DestProduct[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('product_groups')
      .select('id, name, category, default_price')
      .eq('owner_store_id', storeId)
      .eq('is_active', true)
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) return { groups, products, error: error.message };
    groups.push(...((data ?? []) as DestGroup[]).map((g) => ({ ...g, name: g.name.trim() })));
    if ((data ?? []).length < PAGE) break;
  }
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('products')
      .select('id, sku_barcode, name, talla, color, price, parent_group_id')
      .eq('owner_store_id', storeId)
      .eq('is_active', true)
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) return { groups, products, error: error.message };
    products.push(...((data ?? []) as DestProduct[]).map((p) => ({ ...p, name: p.name.trim() })));
    if ((data ?? []).length < PAGE) break;
  }
  return { groups, products, error: null };
}

/** Precio que tendría una variante nueva en el modelo: el más común entre sus variantes (como el SQL). */
export function groupPrice(group: DestGroup, products: DestProduct[]): number {
  const counts = new Map<number, number>();
  for (const p of products) {
    if (p.parent_group_id !== group.id) continue;
    const price = Number(p.price) || 0;
    counts.set(price, (counts.get(price) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestN = 0;
  for (const [price, n] of counts) {
    if (n > bestN || (n === bestN && best !== null && price > best)) {
      best = price;
      bestN = n;
    }
  }
  return best ?? (Number(group.default_price) || 0);
}

/** La variante del modelo con esa talla y color (o null: sería variante nueva). */
export function variantInGroup(
  groupId: string,
  talla: string | null,
  color: string | null,
  products: DestProduct[],
): DestProduct | null {
  const t = normText(talla);
  const c = normText(color);
  return (
    products.find((p) => p.parent_group_id === groupId && normText(p.talla) === t && normText(p.color) === c) ?? null
  );
}

export type SuggestKind = 'mismo' | 'parecido' | 'ninguno';

/** El modelo de la tienda destino que se propone para un nombre: igual, parecido, o ninguno. */
export function suggestGroup(name: string, groups: DestGroup[]): { kind: SuggestKind; group: DestGroup | null } {
  const key = nameKey(name);
  const same = groups.find((g) => nameKey(g.name) === key);
  if (same) return { kind: 'mismo', group: same };
  let best: DestGroup | null = null;
  let bestScore = 0;
  for (const g of groups) {
    const s = nameSimilarity(name, g.name);
    if (s > bestScore) {
      best = g;
      bestScore = s;
    }
  }
  return best ? { kind: 'parecido', group: best } : { kind: 'ninguno', group: null };
}

// --- Enlaces guardados --------------------------------------------------------

export interface TwinMaps {
  /** producto de origen → su gemelo en la tienda destino */
  products: Map<string, string>;
  /** modelo de origen → su gemelo en la tienda destino */
  groups: Map<string, string>;
}

export async function fetchTwins(
  supabase: SupabaseClient,
  productIds: string[],
  groupIds: string[],
  toStoreId: string,
): Promise<TwinMaps> {
  const maps: TwinMaps = { products: new Map(), groups: new Map() };
  const CHUNK = 100;
  for (let i = 0; i < productIds.length; i += CHUNK) {
    const { data } = await supabase
      .from('product_twins')
      .select('product_id, twin_id')
      .eq('twin_store_id', toStoreId)
      .in('product_id', productIds.slice(i, i + CHUNK));
    for (const r of data ?? []) maps.products.set(r.product_id as string, r.twin_id as string);
  }
  for (let i = 0; i < groupIds.length; i += CHUNK) {
    const { data } = await supabase
      .from('group_twins')
      .select('group_id, twin_group_id')
      .eq('twin_store_id', toStoreId)
      .in('group_id', groupIds.slice(i, i + CHUNK));
    for (const r of data ?? []) maps.groups.set(r.group_id as string, r.twin_group_id as string);
  }
  return maps;
}

// --- Lo que se pistolea -------------------------------------------------------

export interface ScanProduct {
  id: string;
  sku_barcode: string;
  name: string;
  talla: string | null;
  color: string | null;
  price: number;
  owner_store_id: string | null;
  parent_group_id: string | null;
}

export type ScanResult =
  | { kind: 'ok'; product: ScanProduct; viaTwin: boolean }
  | { kind: 'not_here'; product: ScanProduct }
  | { kind: 'not_found' };

const toScanProduct = (p: Record<string, unknown>): ScanProduct => ({
  id: String(p.id),
  sku_barcode: String(p.sku_barcode ?? ''),
  name: String(p.name ?? ''),
  talla: (p.talla as string | null) ?? null,
  color: (p.color as string | null) ?? null,
  price: Number(p.price) || 0,
  owner_store_id: (p.owner_store_id as string | null) ?? null,
  parent_group_id: (p.parent_group_id as string | null) ?? null,
});

/**
 * Qué pieza es el código pistoleado, en la tienda `storeId`:
 *   1. un producto de esta tienda;
 *   2. un producto de la otra con su GEMELO aquí (la etiqueta de la otra
 *      tienda sigue sirviendo después de un traslado): el gemelo;
 *   3. un producto de la otra con unidades aquí (se lo habían traído);
 *   4. si no, no está en esta tienda.
 */
export async function resolveScan(supabase: SupabaseClient, code: string, storeId: string): Promise<ScanResult> {
  const own = await findProductByBarcode(supabase, code, storeId);
  if (own.product) return { kind: 'ok', product: toScanProduct(own.product), viaTwin: false };

  const any = await findProductByBarcode(supabase, code);
  if (!any.product) return { kind: 'not_found' };
  const p = toScanProduct(any.product);

  const { data: twin } = await supabase
    .from('product_twins')
    .select('twin_id')
    .eq('product_id', p.id)
    .eq('twin_store_id', storeId)
    .maybeSingle();
  if (twin?.twin_id) {
    const { data: tp } = await supabase
      .from('products')
      .select('id, sku_barcode, name, talla, color, price, owner_store_id, parent_group_id, is_active')
      .eq('id', twin.twin_id)
      .maybeSingle();
    if (tp && tp.is_active && tp.owner_store_id === storeId) {
      return { kind: 'ok', product: toScanProduct(tp), viaTwin: true };
    }
  }

  const { data: here } = await supabase
    .from('store_stock')
    .select('stock')
    .eq('product_id', p.id)
    .eq('store_id', storeId)
    .maybeSingle();
  if ((Number(here?.stock) || 0) > 0) return { kind: 'ok', product: p, viaTwin: false };
  return { kind: 'not_here', product: p };
}

/**
 * Para la caja: el gemelo EN ESTA TIENDA de un producto de la otra (la pieza
 * llegó por Traslados y se sumó a su producto de acá, pero lleva la etiqueta
 * de allá). Fila de la vista con ofertas, igual que findProductByBarcode.
 * null si no hay gemelo o si Traslados no está instalado.
 */
export async function fetchTwinHere(
  supabase: SupabaseClient,
  productId: string,
  storeId: string,
): Promise<ScannedProduct | null> {
  const { data: link, error } = await supabase
    .from('product_twins')
    .select('twin_id')
    .eq('product_id', productId)
    .eq('twin_store_id', storeId)
    .maybeSingle();
  if (error || !link?.twin_id) return null;
  const run = (table: string) =>
    supabase.from(table).select('*').eq('id', link.twin_id).eq('is_active', true).eq('owner_store_id', storeId).maybeSingle();
  let res = await run(pricedTable());
  if (pricedFallback(res.error)) res = await run(pricedTable());
  return res.data ?? null;
}

/** Un código de Juguetes con varias tallas en un solo campo («S, M, L»). */
export function sizesOf(talla: string | null | undefined): string[] {
  if (!talla || !talla.includes(',')) return [];
  return [...new Set(talla.split(',').map((s) => s.trim()).filter(Boolean))];
}

// --- RPC ----------------------------------------------------------------------

export interface SendLine {
  product_id: string;
  qty: number;
  size?: string | null;
  target_group_id?: string | null;
  target_product_id?: string | null;
  match?: 'mismo' | 'parecido' | 'elegido';
  /** true = que llegue con su padre de origen aunque haya un enlace guardado. */
  origin?: boolean;
}

export async function sendShipment(
  supabase: SupabaseClient,
  args: { fromStoreId: string; toStoreId: string; note: string; lines: SendLine[]; requestId: string },
): Promise<{ shipmentId: string | null; pieces: number; error: string | null }> {
  const { data, error } = await supabase.rpc('send_shipment', {
    p_from_store_id: args.fromStoreId,
    p_to_store_id: args.toStoreId,
    p_note: args.note.trim(),
    p_lines: args.lines,
    p_request_id: args.requestId,
  });
  if (error) {
    if (isMissingFunctionError(error)) available = false;
    return { shipmentId: null, pieces: 0, error: trasladoErrorMessage(error) };
  }
  const r = (data ?? {}) as Record<string, unknown>;
  return { shipmentId: String(r.shipment_id ?? ''), pieces: Number(r.pieces) || 0, error: null };
}

export async function receiveShipment(
  supabase: SupabaseClient,
  shipmentId: string,
  missing: { item_id: string; missing: number }[] = [],
): Promise<{ status: ShipmentStatus | null; error: string | null }> {
  const { data, error } = await supabase.rpc('receive_shipment', {
    p_shipment_id: shipmentId,
    p_missing: missing.length ? missing : null,
  });
  if (error) return { status: null, error: trasladoErrorMessage(error, 'No se pudo confirmar el envío.') };
  return { status: ((data as Record<string, unknown>)?.status as ShipmentStatus) ?? 'recibido', error: null };
}

export async function undoShipment(
  supabase: SupabaseClient,
  shipmentId: string,
): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc('undo_shipment', { p_shipment_id: shipmentId });
  return { error: error ? trasladoErrorMessage(error, 'No se pudo deshacer el envío.') : null };
}

export async function relinkShipmentItem(
  supabase: SupabaseClient,
  args: { itemId: string; targetGroupId?: string | null; targetProductId?: string | null },
): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc('relink_shipment_item', {
    p_item_id: args.itemId,
    p_target_group_id: args.targetGroupId ?? null,
    p_target_product_id: args.targetProductId ?? null,
  });
  return { error: error ? trasladoErrorMessage(error, 'No se pudo enlazar la pieza.') : null };
}

// --- Envíos (lectura) ---------------------------------------------------------

export interface ItemProduct {
  id: string;
  name: string;
  sku_barcode: string;
  talla: string | null;
  color: string | null;
  parent_group_id: string | null;
  owner_store_id: string | null;
}

export interface ShipmentItem {
  id: string;
  sort: number;
  quantity: number;
  missing: number;
  size: string | null;
  match: MatchKind;
  created_variant: boolean;
  origin_price: number | null;
  target_price: number | null;
  product: ItemProduct | null;
  target: ItemProduct | null;
}

export interface Shipment {
  id: string;
  from_store_id: string;
  to_store_id: string;
  note: string;
  status: ShipmentStatus;
  pieces: number;
  created_at: string;
  created_by: string;
  received_at: string | null;
  undone_at: string | null;
  author: string;
  receiver: string | null;
  undoer: string | null;
  items: ShipmentItem[];
}

const PRODUCT_COLS = 'id, name, sku_barcode, talla, color, parent_group_id, owner_store_id';
const SHIPMENT_SELECT = `
  id, from_store_id, to_store_id, note, status, pieces, created_at, created_by, received_at, undone_at,
  author:profiles!store_shipments_author_fkey (full_name),
  receiver:profiles!store_shipments_receiver_fkey (full_name),
  undoer:profiles!store_shipments_undoer_fkey (full_name),
  store_shipment_items (
    id, sort, quantity, missing, size, match, created_variant, origin_price, target_price,
    product:products!store_shipment_items_product_fkey (${PRODUCT_COLS}),
    target:products!store_shipment_items_target_fkey (${PRODUCT_COLS})
  )
`;

const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

function toShipment(raw: Record<string, unknown>): Shipment {
  const items = ((raw.store_shipment_items as Record<string, unknown>[] | null) ?? [])
    .map((it) => ({
      id: String(it.id),
      sort: Number(it.sort) || 0,
      quantity: Number(it.quantity) || 0,
      missing: Number(it.missing) || 0,
      size: (it.size as string | null) ?? null,
      match: it.match as MatchKind,
      created_variant: !!it.created_variant,
      origin_price: it.origin_price == null ? null : Number(it.origin_price),
      target_price: it.target_price == null ? null : Number(it.target_price),
      product: one(it.product as ItemProduct | ItemProduct[] | null),
      target: one(it.target as ItemProduct | ItemProduct[] | null),
    }))
    .sort((a, b) => a.sort - b.sort);
  const name = (v: unknown) => one(v as { full_name: string } | { full_name: string }[] | null)?.full_name ?? null;
  return {
    id: String(raw.id),
    from_store_id: String(raw.from_store_id),
    to_store_id: String(raw.to_store_id),
    note: String(raw.note ?? ''),
    status: raw.status as ShipmentStatus,
    pieces: Number(raw.pieces) || 0,
    created_at: String(raw.created_at),
    created_by: String(raw.created_by),
    received_at: (raw.received_at as string | null) ?? null,
    undone_at: (raw.undone_at as string | null) ?? null,
    author: name(raw.author) ?? 'Desconocido',
    receiver: name(raw.receiver),
    undoer: name(raw.undoer),
    items,
  };
}

/**
 * Envíos donde está la tienda (o todos, para el dueño: storeId null), del más
 * reciente al más viejo. La RLS ya limita al cajero a los de su tienda.
 */
export async function fetchShipments(
  supabase: SupabaseClient,
  opts: { storeId: string | null; limit?: number; pendingTo?: string },
): Promise<{ rows: Shipment[]; error: string | null }> {
  let q = supabase.from('store_shipments').select(SHIPMENT_SELECT);
  if (opts.pendingTo) q = q.eq('to_store_id', opts.pendingTo).eq('status', 'pendiente');
  else if (opts.storeId) q = q.or(`from_store_id.eq.${opts.storeId},to_store_id.eq.${opts.storeId}`);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(opts.limit ?? 30);
  if (error) {
    if (isMissingTableError(error)) {
      available = false;
      return { rows: [], error: TRASLADOS_MIGRATION_MISSING };
    }
    return { rows: [], error: error.message || 'No se pudieron cargar los envíos.' };
  }
  return { rows: ((data ?? []) as Record<string, unknown>[]).map(toShipment), error: null };
}

/** Cuántos envíos esperan que esta tienda confirme. 0 si algo falla. */
export async function fetchPendingToReceive(supabase: SupabaseClient, storeId: string): Promise<number> {
  const { count, error } = await supabase
    .from('store_shipments')
    .select('id', { count: 'exact', head: true })
    .eq('to_store_id', storeId)
    .eq('status', 'pendiente');
  return error ? 0 : (count ?? 0);
}

/** Evento de ventana: cambió algo en Traslados (el menú recalcula su número). */
export const TRASLADOS_CHANGED_EVENT = 'traslados-changed';
export const notifyTrasladosChanged = () => {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(TRASLADOS_CHANGED_EVENT));
};

// --- Borrador («Seguir después») ----------------------------------------------

/** Lo que hace falta para rearmar el envío: el resto se vuelve a leer. */
export interface DraftLine {
  product_id: string;
  qty: number;
  size: string | null;
}

export interface Draft {
  toStoreId: string;
  note: string;
  lines: DraftLine[];
  /** Decisión por modelo: id del modelo (o del producto suelto) → elección. */
  choices: Record<string, ModelChoice>;
  /** Variante elegida a mano: product_id[|talla] → producto de la otra tienda. */
  variantChoices: Record<string, string>;
  savedAt: string;
}

/** Lo que la cajera decidió para un modelo. */
export type ModelChoice =
  | { kind: 'group'; groupId: string; match: 'mismo' | 'parecido' | 'elegido' }
  | { kind: 'product'; productId: string }
  | { kind: 'origen' };

const draftKey = (userId: string, fromStoreId: string) => `traslados-borrador:${userId}:${fromStoreId}`;

// localStorage puede no existir o lanzar (ventana privada, datos bloqueados):
// el borrador es una comodidad, nunca un requisito.
export function loadDraft(userId: string, fromStoreId: string): Draft | null {
  try {
    const raw = window.localStorage.getItem(draftKey(userId, fromStoreId));
    if (!raw) return null;
    const d = JSON.parse(raw) as Draft;
    return Array.isArray(d.lines) ? d : null;
  } catch {
    return null;
  }
}

export function saveDraft(userId: string, fromStoreId: string, draft: Draft): void {
  try {
    if (draft.lines.length === 0 && !draft.note.trim()) {
      window.localStorage.removeItem(draftKey(userId, fromStoreId));
      return;
    }
    window.localStorage.setItem(draftKey(userId, fromStoreId), JSON.stringify(draft));
  } catch {
    // Sin almacenamiento: el envío sigue en pantalla, solo no se recuerda.
  }
}

export function clearDraft(userId: string, fromStoreId: string): void {
  try {
    window.localStorage.removeItem(draftKey(userId, fromStoreId));
  } catch {
    // nada
  }
}
