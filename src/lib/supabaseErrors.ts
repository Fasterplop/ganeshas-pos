// Detección de "la columna todavía no existe en la base de datos".
//
// Las migraciones db/*.sql se aplican a mano en Supabase, así que el código
// puede desplegarse antes que el SQL. Cuando eso pasa, PostgREST responde:
//   - insert/update -> code 'PGRST204': "Could not find the 'X' column of 'sales' in the schema cache"
//   - select        -> code '42703'  : "column sales.X does not exist"
// Quien llama decide cómo degradar (reintentar sin la columna, asumir 0, etc.).
export function isMissingColumnError(
  error: { code?: string; message?: string } | null | undefined,
  column: string,
): boolean {
  if (!error) return false;
  const msg = (error.message ?? '').toLowerCase();
  const looksLikeMissingColumn =
    error.code === 'PGRST204' ||
    error.code === '42703' ||
    msg.includes('schema cache') ||
    msg.includes('does not exist');
  return looksLikeMissingColumn && msg.includes(column.toLowerCase());
}

// Detección de "la tabla o la vista todavía no existe en la base de datos".
//
// Mismo motivo que arriba: el front puede desplegarse antes que el SQL. Sin
// esto, entrar a /consultar-precio o a /ofertas sin haber corrido
// db/scanner_03_offers.sql da una pantalla rota y un error críptico en
// consola; con esto, da un aviso que dice qué archivo falta correr.
//
// PostgREST responde:
//   select  -> code 'PGRST205': "Could not find the table 'public.X' in the schema cache"
//   directo -> code '42P01'   : relation "public.X" does not exist
//
// (Finanzas tiene su propia copia en src/lib/finanzas/errors.ts, a propósito:
// ese módulo se construyó con cero ediciones sobre archivos del POS.)
export function isMissingTableError(
  error: { code?: string; message?: string } | null | undefined,
): boolean {
  if (!error) return false;
  const msg = (error.message ?? '').toLowerCase();
  return (
    error.code === 'PGRST205' ||
    error.code === '42P01' ||
    (msg.includes('schema cache') && msg.includes('table')) ||
    msg.includes('does not exist')
  );
}
