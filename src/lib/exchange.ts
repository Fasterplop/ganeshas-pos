// Helpers puros para "cambios de producto" (ver db/exchange_02_schema_and_rpc.sql).
//
// Un cambio es una fila de `sales` con kind = 'exchange' cuyas líneas son las
// devueltas (quantity negativa, unit_price = crédito prorrateado) y las nuevas
// (quantity positiva). Estas funciones solo PREVISUALIZAN en el cliente lo que
// el RPC register_exchange recalcula y valida en el servidor.

import { isMissingColumnError } from '@/lib/supabaseErrors';

export type SaleKind = 'sale' | 'exchange';

// Métodos con los que se puede pagar la diferencia de un cambio (sin Cashea).
export type ExchangePaymentMethod = 'efectivo' | 'zelle' | 'pago_movil' | 'punto_de_venta';

export const EXCHANGE_PAYMENT_OPTIONS: { value: ExchangePaymentMethod; label: string; icon: string }[] = [
  { value: 'efectivo',       label: 'Efectivo',       icon: '💵' },
  { value: 'punto_de_venta', label: 'Punto de Venta', icon: '💳' },
  { value: 'zelle',          label: 'Zelle',          icon: '🔄' },
  { value: 'pago_movil',     label: 'Pago Móvil',     icon: '📱' },
];

// Misma tasa del recargo por Punto de Venta que usa el POS (y el RPC).
export const PDV_SURCHARGE_RATE = 0.05;

// Método de pago que lleva un cambio sin diferencia (total 0).
export const EXCHANGE_NO_DIFF_METHOD = 'cambio';

// Redondeo a 2 decimales robusto a 0.005 (45.005 -> 45.01, como ROUND() de Postgres).
export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export const isExchange = (sale: { kind?: unknown } | null | undefined): boolean =>
  sale?.kind === 'exchange';

/**
 * r = (total − recargo PDV + canje + crédito de las líneas devueltas)
 *     / Σ subtotal de las líneas positivas, acotado a [0, 1].
 * Es la fracción del precio de lista que el cliente realmente pagó tras el
 * descuento manual de la venta (el canje de puntos NO reduce el crédito).
 * Una venta normal no tiene líneas devueltas: queda (total − recargo + canje)
 * / Σ subtotal. Un cambio sin descuento da 1; con descuento, (nuevos −
 * descuento) / nuevos. Sin líneas positivas vale 1. Misma fórmula que el RPC
 * (db/exchange_03_discount.sql): si se toca una hay que tocar la otra.
 */
export function creditRatio(
  sale: { total_amount: unknown; punto_de_venta_surcharge_usd?: unknown; redemption_discount_usd?: unknown },
  items: { subtotal: unknown; quantity: unknown }[],
): number {
  let sum = 0;
  let returnedCredit = 0;
  for (const it of items) {
    const subtotal = Number(it.subtotal) || 0;
    if (Number(it.quantity) > 0) sum += subtotal;
    else if (Number(it.quantity) < 0) returnedCredit -= subtotal;
  }
  if (sum <= 0) return 1;
  const paid = (Number(sale.total_amount) || 0)
    - (Number(sale.punto_de_venta_surcharge_usd) || 0)
    + (Number(sale.redemption_discount_usd) || 0)
    + returnedCredit;
  return Math.min(1, Math.max(0, paid / sum));
}

// Crédito por unidad devuelta.
export const lineCredit = (unitPrice: number, ratio: number) => round2(unitPrice * ratio);

// Descuento manual sobre la diferencia de un cambio (mismas opciones que el POS).
export type ExchangeDiscountType = 'none' | 'percent' | 'fixed';

/**
 * Monto en USD del descuento que escribió el cajero, acotado a [0, diferencia]:
 * un cambio nunca queda a favor del cliente. Es el número que se le manda al
 * RPC (p_discount_usd), que lo vuelve a validar.
 */
export function exchangeDiscountUsd(diff: number, type: ExchangeDiscountType, value: string): number {
  if (diff <= 0 || type === 'none' || value.trim() === '' || isNaN(Number(value))) return 0;
  const raw = type === 'percent' ? diff * (Number(value) / 100) : Number(value);
  return Math.min(diff, Math.max(0, round2(raw)));
}

/**
 * Descuento manual que tuvo un cambio ya registrado. No hay columna: sale de
 * lo que valían sus líneas (devueltas en negativo) menos lo que se cobró, igual
 * que el descuento manual de una venta. Menos de un centavo se toma como 0
 * (redondeo de las líneas).
 */
export function exchangeDiscountOf(
  sale: { total_amount: unknown; punto_de_venta_surcharge_usd?: unknown; redemption_discount_usd?: unknown },
  items: { quantity: unknown; unit_price: unknown }[] | null | undefined,
): number {
  const diff = (items ?? []).reduce(
    (acc, it) => acc + round2((Number(it.quantity) || 0) * (Number(it.unit_price) || 0)), 0);
  const paid = (Number(sale.total_amount) || 0)
    - (Number(sale.punto_de_venta_surcharge_usd) || 0)
    + (Number(sale.redemption_discount_usd) || 0);
  const discount = round2(diff - paid);
  return discount > 0.01 ? discount : 0;
}

// Unidades devueltas y agregadas en un cambio (para mostrar "↩R / +N").
export function exchangeCounts(items: { quantity: unknown }[] | null | undefined): { returned: number; added: number } {
  let returned = 0;
  let added = 0;
  for (const it of items ?? []) {
    const q = Number(it.quantity) || 0;
    if (q < 0) returned += -q;
    else added += q;
  }
  return { returned, added };
}

// Mensajes en español para los códigos que lanza register_exchange /
// delete_sale_and_revert / adjust_customer_points (RAISE EXCEPTION 'CODIGO').
export const EXCHANGE_ERRORS: Record<string, string> = {
  NOT_AUTHORIZED: 'No tienes permiso para esta operación.',
  NOT_AUTHORIZED_STORE: 'Esta venta es de otra sucursal: el cambio se hace allá.',
  SALE_NOT_FOUND: 'La venta ya no existe (puede haber sido anulada).',
  INVALID_RATE: 'La tasa BCV no es válida. Actualízala e intenta de nuevo.',
  RETURNS_REQUIRED: 'Selecciona al menos un producto a devolver.',
  NEW_ITEMS_REQUIRED: 'Agrega al menos un producto nuevo.',
  RETURN_LINE_NOT_FOUND: 'Una de las líneas a devolver no pertenece a esta venta.',
  RETURN_LINE_NOT_RETURNABLE: 'Esa línea es un crédito de un cambio anterior y no se puede devolver.',
  INVALID_QUANTITY: 'Cantidad inválida.',
  RETURN_EXCEEDS: 'Se intenta devolver más unidades de las que quedan en la venta. Refresca e intenta de nuevo.',
  PRODUCT_NOT_FOUND: 'Uno de los productos nuevos no existe o está inactivo.',
  EXCHANGE_NEGATIVE: 'La diferencia queda a favor del cliente. No se devuelve dinero: agrega más productos.',
  INVALID_DISCOUNT: 'El descuento no es válido: no puede ser mayor que la diferencia.',
  NO_CUSTOMER_FOR_POINTS: 'Para canjear puntos la venta debe tener un cliente con cédula.',
  INVALID_REDEMPTION: 'El canje de puntos no es válido para esta diferencia.',
  INSUFFICIENT_POINTS: 'El cliente no tiene puntos suficientes.',
  INVALID_PAYMENT_METHOD: 'Selecciona un método de pago válido para la diferencia.',
  TOTAL_MISMATCH: 'El total cambió mientras registrabas el cambio (precio o tasa). Revisa y confirma de nuevo.',
  SALE_HAS_EXCHANGES: 'Esta venta tiene cambios registrados. Anula primero el cambio.',
  CUSTOMER_NOT_FOUND: 'El cliente no existe.',
  INVALID_DELTA: 'La cantidad de puntos debe ser distinta de cero.',
  REASON_REQUIRED: 'Escribe el motivo del ajuste.',
};

// PostgREST no encontró el RPC con los parámetros que se le mandaron
// (migración sin aplicar).
export const isMissingFunctionError = (error: { code?: string; message?: string } | null | undefined): boolean =>
  error?.code === 'PGRST202' || (error?.message ?? '').toLowerCase().includes('could not find the function');

// Traduce el error de un RPC a un mensaje legible (el código viene en message).
export function exchangeErrorMessage(
  error: { message?: string; code?: string } | null | undefined,
  fallback = 'No se pudo completar la operación.',
): string {
  const msg = error?.message ?? '';
  for (const code of Object.keys(EXCHANGE_ERRORS)) {
    if (msg.includes(code)) return EXCHANGE_ERRORS[code];
  }
  // PostgREST: la función no existe todavía (migración sin aplicar).
  if (isMissingFunctionError(error)) {
    return 'La función de cambios no está instalada en la base de datos (aplicar db/exchange_02_schema_and_rpc.sql).';
  }
  return msg || fallback;
}

// Alguna de las columnas de la migración de cambios todavía no existe en la BD
// (el código puede desplegarse antes que el SQL; ver src/lib/supabaseErrors.ts).
export const isMissingExchangeColumn = (error: { code?: string; message?: string } | null | undefined): boolean =>
  isMissingColumnError(error, 'kind')
  || isMissingColumnError(error, 'exchange_of_sale_id')
  || isMissingColumnError(error, 'source_sale_item_id');
