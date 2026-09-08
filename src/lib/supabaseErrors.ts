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
