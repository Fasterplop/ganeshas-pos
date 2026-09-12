// Moneda del módulo de Finanzas.
//
// Regla del módulo: TODO reporte suma `amount_usd`. La moneda de captura
// (`currency` + `amount` + `bcv_rate`) se guarda para el respaldo y la
// auditoría, pero no se suma nunca. Es el mismo criterio que ya usa
// sales.bcv_rate: la tasa queda congelada en el documento, así una compra de
// marzo sigue valiendo lo mismo cuando se mire en septiembre.

export type Currency = 'USD' | 'VES';

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function fmtUSD(n: number | string | null | undefined): string {
  const v = Number(n) || 0;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtVES(n: number | string | null | undefined): string {
  const v = Number(n) || 0;
  return `${v.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Bs`;
}

/**
 * Equivalente en dólares de lo que se escribió.
 *
 * Devuelve null cuando falta la tasa en una captura en bolívares, en vez de
 * asumir 0 o 1: guardar un monto en Bs sin tasa deja un gasto imposible de
 * auditar meses después. Quien llama debe bloquear el guardado.
 */
export function toUSD(amount: number, currency: Currency, bcvRate?: number | null): number | null {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (currency === 'USD') return round2(amount);
  if (!bcvRate || !Number.isFinite(bcvRate) || bcvRate <= 0) return null;
  return round2(amount / bcvRate);
}

/** Etiqueta de una cuenta: "Amex Business ···· 2890". Nunca más que los 4. */
export function accountLabel(account: {
  name?: string | null;
  last4?: string | null;
  bank_name?: string | null;
} | null | undefined): string {
  if (!account) return '—';
  const base = account.name || account.bank_name || 'Cuenta';
  return account.last4 ? `${base} ···· ${account.last4}` : base;
}

export const ACCOUNT_KIND_LABEL: Record<string, string> = {
  banco: 'Banco',
  zelle: 'Zelle',
  efectivo: 'Efectivo',
  tarjeta_credito: 'Tarjeta de crédito',
  otro: 'Otro',
};

export const PAYMENT_TERMS_LABEL: Record<string, string> = {
  contado: 'Contado',
  '15_dias': '15 días',
  '30_dias': '30 días',
  consignacion: 'Consignación',
  otro: 'Otro',
};

/** Días de crédito de una condición de pago, para proponer el vencimiento. */
export function termDays(terms: string | null | undefined): number | null {
  if (terms === '15_dias') return 15;
  if (terms === '30_dias') return 30;
  if (terms === 'contado') return 0;
  return null; // consignación / otro: no hay vencimiento automático
}
