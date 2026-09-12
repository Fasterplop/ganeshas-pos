// Detección de "la tabla todavía no existe en la base de datos".
//
// Las migraciones db/*.sql se aplican A MANO en el SQL Editor de Supabase, así
// que el front puede desplegarse antes que el SQL. Sin esto, entrar a Finanzas
// sin haber corrido db/finanzas_01_schema.sql da una pantalla rota y un error
// críptico en consola; con esto, da un aviso que dice qué archivo falta correr.
//
// Vive aquí y no en src/lib/supabaseErrors.ts para dejar el módulo en cero
// ediciones sobre archivos que comparte con el POS.
//
// PostgREST responde:
//   select  -> code 'PGRST205': "Could not find the table 'public.fin_x' in the schema cache"
//   directo -> code '42P01'   : relation "public.fin_x" does not exist

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

/**
 * ¿El error viene de una política RLS que bloqueó una escritura?
 *
 * Ojo con el caso contrario: una LECTURA bloqueada por RLS no da error, viene
 * como lista vacía. Ese es el bug silencioso que documenta
 * db/rls_01_activar.sql:19-25, y no hay forma de detectarlo desde el cliente.
 */
export function isRlsDenied(
  error: { code?: string; message?: string } | null | undefined,
): boolean {
  if (!error) return false;
  const msg = (error.message ?? '').toLowerCase();
  return error.code === '42501' || msg.includes('row-level security');
}

/** Mensaje en español para mostrarle al usuario, sin tecnicismos de Postgres. */
export function finErrorMessage(
  error: { code?: string; message?: string } | null | undefined,
): string {
  if (!error) return 'Error desconocido.';
  if (isMissingTableError(error)) {
    return 'El módulo de Finanzas todavía no está instalado en la base de datos. Falta correr db/finanzas_01_schema.sql en Supabase.';
  }
  if (isRlsDenied(error)) {
    return 'No tienes permisos para hacer eso. El módulo de Finanzas es exclusivo del dueño.';
  }
  if (error.code === '23505') {
    return 'Ya existe un registro con esos datos.';
  }
  if (error.code === '23514') {
    return 'Alguno de los datos no es válido. Revisa los campos marcados.';
  }
  return error.message || 'Error desconocido.';
}
