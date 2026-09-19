// Cambiar el código de barras de un producto.
//
// La operación va por el RPC `set_product_barcode` (db/scanner_02_…sql), que
// revalida en el servidor el rol y el alcance del cajero: la clave anónima
// viaja en el navegador, así que esconder el botón no es una defensa.
//
// DECISIÓN DE NEGOCIO: el cambio es directo, sin historial de códigos viejos.
// Las etiquetas ya pegadas con el código anterior dejan de escanear, y la UI
// tiene que decirlo antes de guardar.

export const BARCODE_ERRORS: Record<string, string> = {
  SKU_TAKEN: 'Ese código ya pertenece a otro producto. Escanea o escribe uno distinto.',
  EMPTY_SKU: 'Escribe o escanea el código nuevo.',
  SKU_TOO_LONG: 'El código es demasiado largo (máximo 64 caracteres).',
  PRODUCT_NOT_FOUND: 'El producto ya no existe. Refresca el inventario.',
  PRODUCT_INACTIVE: 'Este producto está eliminado del inventario: no se le puede cambiar el código.',
  NOT_AUTHORIZED_STORE: 'Ese producto es de otra sucursal: su código se cambia desde allá.',
  NOT_AUTHORIZED: 'No tienes permiso para cambiar el código de un producto.',
};

/** Traduce el error del RPC a un mensaje para el cajero. */
export function barcodeErrorMessage(
  error: { message?: string; code?: string } | null | undefined,
  fallback = 'No se pudo cambiar el código.',
): string {
  const msg = error?.message ?? '';
  // NOT_AUTHORIZED_STORE contiene a NOT_AUTHORIZED: el orden del objeto importa
  // y por eso el específico va primero en BARCODE_ERRORS.
  for (const code of Object.keys(BARCODE_ERRORS)) {
    if (msg.includes(code)) return BARCODE_ERRORS[code];
  }
  if (msg.toLowerCase().includes('could not find the function') || error?.code === 'PGRST202') {
    return 'Falta correr db/scanner_02_set_product_barcode.sql en Supabase.';
  }
  return msg || fallback;
}
