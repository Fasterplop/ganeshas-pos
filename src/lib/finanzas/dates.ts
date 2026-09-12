// Fechas del módulo de Finanzas, ancladas a Caracas.
//
// Venezuela no cambia de hora, así que el resto del sistema trata la zona como
// un UTC-4 fijo y ancla los límites de consulta con el offset literal. Ver
// src/app/(dashboard)/dashboard/page.tsx:447-448 y :543-544.
//
// parseSupabaseDate se copia en vez de importarse: en el dashboard es una
// función local sin exportar, y tocar ese archivo para exportarla pondría en
// riesgo el reporte de ventas real por una comodidad de este módulo.

export const CARACAS_TZ = 'America/Caracas';
const CARACAS_OFFSET = '-04:00';

/** Hoy en Caracas como 'YYYY-MM-DD', listo para un <input type="date">. */
export function caracasToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: CARACAS_TZ });
}

/** Primer día del mes ('YYYY-MM-01') de la fecha dada, o del mes actual. */
export function caracasMonthStart(ymd?: string): string {
  const base = ymd || caracasToday();
  return `${base.slice(0, 7)}-01`;
}

/**
 * Límites de un rango de días para comparar contra un timestamptz.
 * Funciona porque created_at ya es timestamptz: Postgres compara instantes.
 */
export function caracasBounds(start: string, end: string): { fromISO: string; toISO: string } {
  return {
    fromISO: `${start}T00:00:00.000${CARACAS_OFFSET}`,
    toISO: `${end}T23:59:59.999${CARACAS_OFFSET}`,
  };
}

/**
 * Supabase devuelve '2026-09-12 14:30:00+00' (espacio, no 'T'). Safari y
 * algunos navegadores no parsean ese formato y devuelven Invalid Date.
 */
export function parseSupabaseDate(dateStr: string): Date {
  if (!dateStr) return new Date(NaN);
  let s = dateStr.replace(' ', 'T');
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s += 'Z';
  return new Date(s);
}

/** '12/09/2026' a partir de un date ('YYYY-MM-DD') o de un timestamptz. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  // Una columna `date` no tiene hora: formatearla con timeZone la correría un día.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-');
    return `${d}/${m}/${y}`;
  }
  const dt = parseSupabaseDate(value);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('es-VE', {
    timeZone: CARACAS_TZ,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const dt = parseSupabaseDate(value);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt
    .toLocaleString('es-VE', {
      timeZone: CARACAS_TZ,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    })
    .replace(/,/g, '');
}

/**
 * Días que faltan para una fecha ('YYYY-MM-DD'): 0 = hoy, negativo = vencido.
 *
 * Se hace con aritmética de fechas puras (Date.UTC sobre el texto) y no con
 * `new Date(...)`, porque construir un Date local y restarlo se corre un día
 * según la hora del navegador — justo el error que haría que el calendario
 * marque "vencido" algo que vence hoy.
 */
export function daysUntil(dueDate: string | null | undefined): number | null {
  if (!dueDate || !/^\d{4}-\d{2}-\d{2}/.test(dueDate)) return null;
  const toUTC = (s: string) =>
    Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((toUTC(dueDate) - toUTC(caracasToday())) / 86_400_000);
}

/** Urgencia de un vencimiento, según los avisos que pide la propuesta. */
export type DueLevel = 'vencido' | 'hoy' | 'pronto' | 'cerca' | 'lejos';

export function dueLevel(dueDate: string | null | undefined): DueLevel | null {
  const d = daysUntil(dueDate);
  if (d === null) return null;
  if (d < 0) return 'vencido';
  if (d === 0) return 'hoy';
  if (d <= 3) return 'pronto';
  if (d <= 7) return 'cerca';
  return 'lejos';
}
