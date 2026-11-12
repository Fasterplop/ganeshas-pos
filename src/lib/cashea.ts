// Montos de Cashea de una venta.
//
// Los usan Reportes (las tarjetas de hoy y el historial) y la pestaña Cashea de
// Finanzas. Viven acá para que los dos lados sumen exactamente igual: si uno
// cambia la regla y el otro no, los totales de un mismo día dejan de coincidir.
//
// Cashea puede ir solo o como una de las dos partes de un pago dividido
// (payment_method / payment_method_2). Nunca lleva recargo de punto de venta y
// un cambio de producto nunca se cobra con Cashea (db/exchange_03_discount.sql).

import { isMissingColumnError } from '@/lib/supabaseErrors';

type CasheaSale = {
  payment_method?: unknown;
  payment_method_2?: unknown;
  payment_amount_1?: unknown;
  payment_amount_2?: unknown;
  total_amount?: unknown;
  cashea_initial_usd?: unknown;
  cashea_initial_method?: unknown;
  cashea_initial_method_2?: unknown;
  cashea_initial_amount_2?: unknown;
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

// --- Cómo se pagó la inicial (db/cashea_initial_method.sql) -----------------
//
// La caja pregunta «¿Cómo pagó la inicial?» con los métodos de siempre (la
// tarjeta entra por Punto de Venta) y Reportes suma la inicial en ese método
// del desglose. Se puede dividir en dos métodos, como el pago dividido:
//   cashea_initial_method    método (o el 1º si se dividió)
//   cashea_initial_method_2  2º método, solo si se dividió
//   cashea_initial_amount_2  monto del 2º; el del 1º es la inicial menos ese
// Las ventas de antes de esa migración no tienen método: salen «sin indicar».

export type CasheaInitialMethod = 'efectivo' | 'punto_de_venta' | 'zelle' | 'pago_movil';

/**
 * Métodos con que se puede pagar la inicial, en el orden del desglose.
 * label: botones de la caja · text: chips y Excel · short: tarjetas chicas.
 */
export const CASHEA_INITIAL_METHODS: { value: CasheaInitialMethod; label: string; text: string; short: string; icon: string }[] = [
  { value: 'efectivo',       label: 'Efectivo',       text: 'Efectivo',       short: 'Efectivo',   icon: '💵' },
  { value: 'punto_de_venta', label: 'Punto de Venta', text: 'Punto de venta', short: 'Punto',      icon: '💳' },
  { value: 'zelle',          label: 'Zelle',          text: 'Zelle',          short: 'Zelle',      icon: '🔄' },
  { value: 'pago_movil',     label: 'Pago Móvil',     text: 'Pago móvil',     short: 'Pago móvil', icon: '📱' },
];

/** Clave de las iniciales sin método (ventas viejas) en los acumulados por método. */
export const CASHEA_INITIAL_NO_METHOD = 'sin_metodo';

/** Columnas nuevas de `sales`, para los select y para quitarlas si faltan. */
export const CASHEA_INITIAL_METHOD_KEYS = ['cashea_initial_method', 'cashea_initial_method_2', 'cashea_initial_amount_2'] as const;
export const INITIAL_METHOD_COLS = CASHEA_INITIAL_METHOD_KEYS.join(', ');

/** ¿La base todavía no tiene las columnas del método de la inicial? */
export const isMissingInitialMethodColumn = (error: { code?: string; message?: string } | null | undefined): boolean =>
  isMissingColumnError(error, 'cashea_initial_method') || isMissingColumnError(error, 'cashea_initial_amount_2');

const isInitialMethod = (m: unknown): m is CasheaInitialMethod =>
  CASHEA_INITIAL_METHODS.some((o) => o.value === m);

/** Nombre de un método de la inicial («Pago Móvil»); '' si no hay. */
export const casheaInitialMethodLabel = (m: CasheaInitialMethod | null | undefined): string =>
  CASHEA_INITIAL_METHODS.find((o) => o.value === m)?.label ?? '';

const methodText = (m: CasheaInitialMethod | null) => CASHEA_INITIAL_METHODS.find((o) => o.value === m)?.text ?? '';

const round2 = (n: number) => Math.round(n * 100) / 100;

export type CasheaInitialPart = { method: CasheaInitialMethod | null; amount: number };

/**
 * La inicial de una venta repartida por método: [] si no hubo inicial, una
 * parte si se pagó con un método, dos si se dividió. En las ventas viejas el
 * método es null.
 */
export const casheaInitialParts = (sale: CasheaSale): CasheaInitialPart[] => {
  const initial = casheaInitialOf(sale);
  if (initial <= 0) return [];
  const m1 = isInitialMethod(sale.cashea_initial_method) ? sale.cashea_initial_method : null;
  const m2 = isInitialMethod(sale.cashea_initial_method_2) ? sale.cashea_initial_method_2 : null;
  const a2 = Number(sale.cashea_initial_amount_2) || 0;
  if (m1 && m2 && a2 > 0 && a2 < initial) {
    return [{ method: m1, amount: round2(initial - a2) }, { method: m2, amount: a2 }];
  }
  return [{ method: m1, amount: initial }];
};

/** Suma la inicial de una venta a un acumulado por método (las viejas van a CASHEA_INITIAL_NO_METHOD). */
export const addCasheaInitialByMethod = (acc: Record<string, number>, sale: CasheaSale): void => {
  for (const p of casheaInitialParts(sale)) {
    const key = p.method ?? CASHEA_INITIAL_NO_METHOD;
    acc[key] = (acc[key] || 0) + p.amount;
  }
};

export type CasheaInitialByMethodItem = { key: string; icon: string; text: string; short: string; amount: number };

/**
 * Un acumulado por método como lista para mostrar: en el orden del desglose,
 * solo lo mayor que 0, y «Sin indicar» al final.
 */
export const casheaInitialByMethodList = (acc: Record<string, number>): CasheaInitialByMethodItem[] => {
  const out: CasheaInitialByMethodItem[] = CASHEA_INITIAL_METHODS
    .filter((o) => (acc[o.value] || 0) > 0)
    .map((o) => ({ key: o.value, icon: o.icon, text: o.text, short: o.short, amount: acc[o.value] }));
  if ((acc[CASHEA_INITIAL_NO_METHOD] || 0) > 0) {
    out.push({ key: CASHEA_INITIAL_NO_METHOD, icon: '❔', text: 'Sin indicar', short: 'Sin indicar', amount: acc[CASHEA_INITIAL_NO_METHOD] });
  }
  return out;
};

/**
 * Cómo se pagó la inicial, en texto: «Pago móvil», «Pago móvil ($20.00),
 * efectivo ($8.00)», «sin indicar» (venta vieja) o '' si no hubo inicial.
 */
export const casheaInitialMethodText = (sale: CasheaSale): string => {
  const parts = casheaInitialParts(sale);
  if (parts.length === 0) return '';
  if (parts.length === 1) return methodText(parts[0].method) || 'sin indicar';
  return parts
    .map((p, i) => {
      const t = methodText(p.method);
      return `${i === 0 ? t : t.toLowerCase()} ($${p.amount.toFixed(2)})`;
    })
    .join(', ');
};
