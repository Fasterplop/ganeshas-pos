// Formato unificado de Talla/Color de un producto.
//
// Regla (definida con el negocio): se muestran SIEMPRE juntas, nunca por
// separado. El separador es " · " (punto medio con espacios).
//   - talla y color -> "S · Beige"
//   - solo talla     -> "S"
//   - solo color     -> "Beige"
//   - ninguno        -> "" (cadena vacía)
//
// Para inventario, POS, reportes y Excel se usa `variantLabel` (devuelve "N/A"
// cuando no hay ninguno). Para la etiqueta impresa se usa `formatVariant`
// directo y se omite la línea cuando devuelve "".
export function formatVariant(
  talla?: string | null,
  color?: string | null,
): string {
  const t = (talla ?? '').trim();
  const c = (color ?? '').trim();
  if (t && c) return `${t} · ${c}`;
  return t || c || '';
}

// Igual que formatVariant pero con "N/A" cuando no hay ni talla ni color.
export function variantLabel(
  talla?: string | null,
  color?: string | null,
): string {
  return formatVariant(talla, color) || 'N/A';
}
