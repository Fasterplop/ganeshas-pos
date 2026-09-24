// Utilidades de los endpoints del conector: validación de parámetros y
// aritmética de fechas 'YYYY-MM-DD' sin pasar por la zona horaria del server.
import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { jsonError } from './auth';

export const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha en formato AAAA-MM-DD');
export const uuid = z.uuid();

/** Convierte los issues de zod en texto corto que el GPT pueda leer. */
export function zodMessage(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.length ? i.path.join('.') + ': ' : ''}${i.message}`)
    .join('; ');
}

/**
 * Lee y valida los query params. Devuelve el objeto o una Response 400 lista
 * para retornar.
 */
export function parseQuery<S extends z.ZodType>(
  req: NextRequest,
  schema: S,
): { ok: true; data: z.infer<S> } | { ok: false; res: Response } {
  const raw: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((v, k) => {
    if (v !== '') raw[k] = v;
  });
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, res: jsonError(400, zodMessage(parsed.error)) };
  return { ok: true, data: parsed.data };
}

/** 'true'/'1'/'si' → true. Para flags en query string. */
export const boolParam = z
  .string()
  .optional()
  .transform((v) => (v ? ['true', '1', 'si', 'sí', 'yes'].includes(v.toLowerCase()) : false));

const toUTC = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
const fromUTC = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function addDays(date: string, days: number): string {
  return fromUTC(toUTC(date) + days * 86_400_000);
}

export function diffDays(a: string, b: string): number {
  return Math.round((toUTC(a) - toUTC(b)) / 86_400_000);
}

function lastDayOfMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/**
 * Próxima fecha (desde `from`, inclusive) que cae en el día `day` del mes.
 * Un día 31 en un mes de 30 cae el último día, igual que hacen los bancos.
 */
export function nextDayOfMonth(from: string, day: number): string {
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7)) - 1;
  const d = Number(from.slice(8, 10));
  const inMonth = (yy: number, mm: number) => Math.min(day, lastDayOfMonth(yy, mm));
  if (inMonth(y, m) < d) {
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(inMonth(y, m)).padStart(2, '0')}`;
}

/** 'YYYY-MM' → ['YYYY-MM-01', último día del mes]. */
export function monthRange(month: string): { start: string; end: string } {
  const y = Number(month.slice(0, 4));
  const m0 = Number(month.slice(5, 7)) - 1;
  return {
    start: `${month}-01`,
    end: `${month}-${String(lastDayOfMonth(y, m0)).padStart(2, '0')}`,
  };
}
