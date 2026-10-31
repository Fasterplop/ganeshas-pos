// Montos de Cashea de una venta.
//
// Los usan Reportes (las tarjetas de hoy y el historial) y la pestaña Cashea de
// Finanzas. Viven acá para que los dos lados sumen exactamente igual: si uno
// cambia la regla y el otro no, los totales de un mismo día dejan de coincidir.
//
// Cashea puede ir solo o como una de las dos partes de un pago dividido
// (payment_method / payment_method_2). Nunca lleva recargo de punto de venta y
// un cambio de producto nunca se cobra con Cashea (db/exchange_03_discount.sql).

type CasheaSale = {
  payment_method?: unknown;
  payment_method_2?: unknown;
  payment_amount_1?: unknown;
  payment_amount_2?: unknown;
  total_amount?: unknown;
  cashea_initial_usd?: unknown;
};

/**
 * Monto COMPLETO que fue por Cashea en una venta (0 si Cashea no participó).
 * Pago simple: el total. Dividido: el monto del método donde esté Cashea.
 */
export const casheaLeg = (sale: CasheaSale): number => {
  if (sale.payment_method_2) {
    if (sale.payment_method === 'cashea') return Number(sale.payment_amount_1) || 0;
    if (sale.payment_method_2 === 'cashea') return Number(sale.payment_amount_2) || 0;
    return 0;
  }
  return sale.payment_method === 'cashea' ? (Number(sale.total_amount) || 0) : 0;
};

/**
 * Inicial de Cashea cobrada en tienda (db/cashea_initial.sql). 0 en ventas
 * viejas o si la columna todavía no existe.
 */
export const casheaInitialOf = (sale: CasheaSale): number => Number(sale.cashea_initial_usd) || 0;

/** Lo que financió Cashea: lo que va por Cashea menos la inicial. Nunca negativo. */
export const casheaFinancedOf = (sale: CasheaSale): number =>
  Math.max(0, casheaLeg(sale) - casheaInitialOf(sale));

/**
 * Día desde el que la caja guarda la inicial (se aplicó db/cashea_initial.sql).
 * Antes de esa fecha `cashea_initial_usd` vale 0 aunque el cliente la haya pagado.
 */
export const CASHEA_INITIAL_SINCE = '2026-09-07';
