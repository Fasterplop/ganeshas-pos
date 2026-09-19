// Ofertas: % de descuento con fecha de fin, guardado en la base.
//
// REGLA DE ORO: el precio con oferta lo calcula SIEMPRE el SQL
// (`v_products_priced.effective_price` y `public.effective_product_price`,
// db/scanner_03_offers.sql). Este archivo NO calcula precios de venta: solo
// da tipos y textos. Si el navegador hiciera su propia cuenta, tarde o
// temprano diría un número distinto al que cobra la caja y al que valida
// `register_exchange`, que aborta con TOTAL_MISMATCH.
//
// La única excepción es `previewOfferPrice`, y es exactamente eso: una vista
// previa en la pantalla de ofertas, antes de que la oferta exista en la base.

import { round2 } from '@/lib/finanzas/money';
import { caracasToday, daysUntil, formatDate } from '@/lib/finanzas/dates';

export type OfferScope = 'product' | 'group' | 'category';

export interface ProductOffer {
  id: string;
  scope: OfferScope;
  product_id: string | null;
  group_id: string | null;
  category: string | null;
  store_id: string | null;
  percent: number;
  starts_at: string;        // 'YYYY-MM-DD'
  ends_at: string | null;   // null = sin fecha de fin
  is_active: boolean;
  created_by: string;
  created_at: string;
}

/** Las tres columnas que la vista `v_products_priced` agrega a `products`. */
export interface OfferFields {
  offer_id: string | null;
  offer_percent: number | null;
  offer_ends_at: string | null;
  effective_price: number;
}

export const OFFER_SCOPE_LABEL: Record<OfferScope, string> = {
  product: 'Un producto',
  group: 'Un modelo (todas sus tallas)',
  category: 'Una categoría completa',
};

/** ¿Esta fila de la vista trae una oferta vigente? */
export function hasOffer(
  row: { offer_id?: string | null; offer_percent?: number | null } | null | undefined,
): boolean {
  return !!row?.offer_id && Number(row?.offer_percent) > 0;
}

/**
 * Precio a cobrar de una fila de `v_products_priced`.
 *
 * Existe para no repetir el fallback en cada pantalla: si el SQL de ofertas
 * todavía no se aplicó, la consulta cae a `products` y no hay
 * `effective_price`; entonces manda el precio de lista.
 */
export function priceOf(row: { price: number; effective_price?: number | null }): number {
  const eff = Number(row.effective_price);
  return Number.isFinite(eff) && eff > 0 ? eff : Number(row.price) || 0;
}

/** "OFERTA −20%" (el signo es un menos real, no un guion). */
export function offerBadge(percent: number | null | undefined): string {
  const p = Number(percent) || 0;
  return `OFERTA −${formatPercent(p)}%`;
}

/** 20 -> "20", 12.5 -> "12,5" (sin decimales inútiles). */
export function formatPercent(percent: number | null | undefined): string {
  const p = Number(percent) || 0;
  return (Math.round(p * 10) / 10).toString().replace('.', ',');
}

/**
 * "hasta el 30/09/2026" · "último día" · "" cuando no tiene fecha de fin.
 * Devuelve cadena vacía para poder omitir la línea sin condicionales extra.
 */
export function offerEndsLabel(endsAt: string | null | undefined): string {
  if (!endsAt) return '';
  const d = daysUntil(endsAt);
  if (d === null) return '';
  if (d < 0) return 'vencida';
  if (d === 0) return 'último día';
  if (d === 1) return 'hasta mañana';
  return `hasta el ${formatDate(endsAt)}`;
}

export type OfferState = 'vigente' | 'programada' | 'vencida' | 'desactivada';

/** Estado de una oferta para la tabla de la pantalla de ofertas. */
export function offerState(offer: Pick<ProductOffer, 'is_active' | 'starts_at' | 'ends_at'>): OfferState {
  if (!offer.is_active) return 'desactivada';
  const today = caracasToday();
  if (offer.starts_at > today) return 'programada';
  if (offer.ends_at && offer.ends_at < today) return 'vencida';
  return 'vigente';
}

export const OFFER_STATE_LABEL: Record<OfferState, string> = {
  vigente: 'Vigente',
  programada: 'Programada',
  vencida: 'Vencida',
  desactivada: 'Desactivada',
};

/**
 * VISTA PREVIA solamente: qué precio quedaría con este porcentaje.
 *
 * Replica `ROUND(price * (100 - percent) / 100, 2)` de db/scanner_03_offers.sql.
 * Se usa antes de guardar, cuando la oferta todavía no existe y por lo tanto
 * la vista no la puede calcular. Una vez guardada, el precio SIEMPRE se lee de
 * `effective_price`, nunca de acá.
 */
export function previewOfferPrice(price: number, percent: number): number {
  const base = Number(price) || 0;
  const p = Number(percent) || 0;
  return round2((base * (100 - p)) / 100);
}
