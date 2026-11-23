// Cobros por tienda y forma de pago: cuánto dinero entró, y por dónde.
//
// Pedido de Gerardo (23-nov-2026, con su dibujo del «Resumen financiero»):
// necesita saber cuánto entró por cada forma de pago para declarar.
//
// Sigue la MISMA regla que el desglose de Reportes («Ventas de Hoy»):
//   * Pago simple: todo el total al método. Dividido: cada parte a su método.
//   * Cashea: la inicial cuenta en el método con que se pagó en tienda; el
//     resto lo paga Cashea y va en su propia fila. Las iniciales viejas, sin
//     método, van en «Inicial Cashea (sin método)».
//   * Un cambio sin diferencia ('cambio') no movió dinero.
//   * Un fiado no trajo dinero al venderse: cuentan sus abonos (el inicial
//     incluido), el día que entran y en su método.
// El recargo del 5% de Punto de Venta ya está dentro del monto cobrado.

import { EXCHANGE_NO_DIFF_METHOD } from '@/lib/exchange';
import { casheaInitialParts } from '@/lib/cashea';

export type CobroSale = {
  store_id: string;
  total_amount: number | string;
  bcv_rate: number | string | null;
  payment_method: string | null;
  payment_method_2?: string | null;
  payment_amount_1?: number | string | null;
  payment_amount_2?: number | string | null;
  cashea_initial_usd?: number | string | null;
  cashea_initial_method?: string | null;
  cashea_initial_method_2?: string | null;
  cashea_initial_amount_2?: number | string | null;
};

export type CobroAbono = {
  store_id: string;
  amount_usd: number | string;
  payment_method: string;
  bcv_rate: number | string | null;
};

/** Filas de la tabla, en este orden. Las de Cashea solo salen si tienen monto. */
export const COBRO_METHODS: { key: string; label: string; icon: string }[] = [
  { key: 'efectivo', label: 'Efectivo', icon: '💵' },
  { key: 'punto_de_venta', label: 'Punto de venta', icon: '💳' },
  { key: 'zelle', label: 'Zelle', icon: '🔄' },
  { key: 'pago_movil', label: 'Pago Móvil', icon: '📱' },
  { key: 'cashea', label: 'Cashea (lo paga Cashea)', icon: '🛍️' },
  { key: 'cashea_sin_metodo', label: 'Inicial Cashea (sin método)', icon: '🛍️' },
];
const ALWAYS_SHOWN = new Set(['efectivo', 'punto_de_venta', 'zelle', 'pago_movil']);

type Part = { method: string; usd: number };

const num = (v: unknown) => Number(v) || 0;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** El dinero que entró con una venta, repartido por método. */
export function cobrosDeVenta(sale: CobroSale): Part[] {
  const pm = sale.payment_method;
  if (!pm || pm === EXCHANGE_NO_DIFF_METHOD || pm === 'fiado') return [];
  const legs: Part[] = sale.payment_method_2
    ? [
        { method: pm, usd: num(sale.payment_amount_1) },
        { method: sale.payment_method_2, usd: num(sale.payment_amount_2) },
      ]
    : [{ method: pm, usd: num(sale.total_amount) }];

  const out: Part[] = [];
  for (const leg of legs) {
    if (leg.method !== 'cashea') {
      out.push(leg);
      continue;
    }
    const parts = casheaInitialParts(sale);
    const initial = parts.reduce((a, p) => a + p.amount, 0);
    for (const p of parts) out.push({ method: p.method ?? 'cashea_sin_metodo', usd: p.amount });
    out.push({ method: 'cashea', usd: Math.max(0, round2(leg.usd - initial)) });
  }
  return out.filter(p => p.usd > 0);
}

export type CobrosTable = {
  /** USD por método y por tienda: usd[method][storeId] */
  usd: Record<string, Record<string, number>>;
  /** Lo mismo en bolívares, a la tasa de cada venta / abono. */
  bs: Record<string, Record<string, number>>;
  /** Métodos que salen en la tabla, en orden. */
  methods: { key: string; label: string; icon: string }[];
  totalByStore: Record<string, number>;
  total: number;
  /** Cuánto de lo cobrado fueron abonos de fiado. */
  abonos: number;
};

/** Arma la tabla «Cobros por tienda y forma de pago». */
export function buildCobros(sales: CobroSale[], abonos: CobroAbono[]): CobrosTable {
  const usd: CobrosTable['usd'] = {};
  const bs: CobrosTable['bs'] = {};
  const add = (method: string, store: string, amount: number, rate: number) => {
    usd[method] ??= {};
    bs[method] ??= {};
    usd[method][store] = (usd[method][store] ?? 0) + amount;
    bs[method][store] = (bs[method][store] ?? 0) + amount * rate;
  };
  for (const s of sales) {
    for (const p of cobrosDeVenta(s)) add(p.method, s.store_id, p.usd, num(s.bcv_rate));
  }
  let abonosTotal = 0;
  for (const a of abonos) {
    const v = num(a.amount_usd);
    if (v <= 0) continue;
    abonosTotal += v;
    add(a.payment_method, a.store_id, v, num(a.bcv_rate));
  }

  const known = COBRO_METHODS.filter(m => ALWAYS_SHOWN.has(m.key) || usd[m.key]);
  const extra = Object.keys(usd)
    .filter(k => !COBRO_METHODS.some(m => m.key === k))
    .map(k => ({ key: k, label: k.replace(/_/g, ' '), icon: '💠' }));

  const totalByStore: Record<string, number> = {};
  let total = 0;
  for (const byStore of Object.values(usd)) {
    for (const [store, v] of Object.entries(byStore)) {
      totalByStore[store] = round2((totalByStore[store] ?? 0) + v);
      total += v;
    }
  }
  return { usd, bs, methods: [...known, ...extra], totalByStore, total: round2(total), abonos: round2(abonosTotal) };
}
