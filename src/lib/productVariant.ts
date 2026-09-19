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

// Tamaño de fuente (px) para la etiqueta impresa: cuanto más largo el texto
// completo (nombre + " · " + talla/color), más chico, para que haga wrap sin
// desbordar el alto fijo de 29 mm. La variante va proporcionalmente más chica.
export function labelFontPx(fullText: string): { name: number; variant: number } {
  const n = fullText.trim().length;
  let name: number;
  if (n <= 15) name = 18;
  else if (n <= 22) name = 16;
  else if (n <= 30) name = 14;
  else if (n <= 40) name = 12;
  else name = 10;
  return { name, variant: Math.max(Math.round(name * 0.72), 9) };
}

// Igual que labelFontPx pero para la etiqueta SIN PRECIO: al quitar el bloque
// del precio se liberan ~24 px de alto, y ese espacio se reparte entre un
// nombre más grande y un código de barras más alto. Acá la talla/color NO va
// pegada al nombre: lleva su propia línea en negrita, así que se mide solo el
// nombre y la variante se devuelve con su propio tamaño.
export function labelFontPxNoPrice(name: string): { name: number; variant: number } {
  const n = name.trim().length;
  let size: number;
  if (n <= 15) size = 22;
  else if (n <= 22) size = 19;
  else if (n <= 30) size = 16;
  else if (n <= 40) size = 14;
  else size = 12;
  return { name: size, variant: Math.max(Math.round(size * 0.62), 10) };
}
