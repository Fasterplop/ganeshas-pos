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

// Ancho de avance de cada carácter en Geist Black (peso 900), en milésimas de
// em. Medido en el navegador con la fuente real de la app; si algún día cambia
// la tipografía de la etiqueta hay que volver a medirlo, porque de acá sale
// cuántos renglones ocupa un nombre.
const GEIST_BLACK_ADVANCE: Record<string, number> = {
  '0': 713, '1': 492, '2': 676, '3': 674, '4': 684, '5': 701, '6': 649,
  '7': 558, '8': 704, '9': 656, ' ': 214, '!': 287, '"': 420, '#': 663,
  '$': 697, '%': 841, '&': 763, "'": 220, '(': 355, ')': 355, '*': 416,
  '+': 578, ',': 260, '-': 416, '.': 260, '/': 550, ':': 320, ';': 320,
  '<': 554, '=': 560, '>': 554, '?': 613, '@': 1000, 'A': 771, 'B': 718,
  'C': 755, 'D': 730, 'E': 634, 'F': 614, 'G': 764, 'H': 727, 'I': 320,
  'J': 647, 'K': 721, 'L': 595, 'M': 940, 'N': 755, 'O': 800, 'P': 686,
  'Q': 793, 'R': 714, 'S': 709, 'T': 631, 'U': 713, 'V': 772, 'W': 1061,
  'X': 742, 'Y': 668, 'Z': 627, '[': 418, '\\': 531, ']': 418, '^': 485,
  '_': 564, '`': 298, 'a': 623, 'b': 660, 'c': 632, 'd': 660, 'e': 635,
  'f': 434, 'g': 660, 'h': 631, 'i': 306, 'j': 379, 'k': 685, 'l': 343,
  'm': 915, 'n': 631, 'o': 648, 'p': 660, 'q': 660, 'r': 455, 's': 603,
  't': 444, 'u': 629, 'v': 657, 'w': 869, 'x': 693, 'y': 619, 'z': 613,
  '{': 420, '|': 314, '}': 420, '~': 523, '·': 260, '¡': 287, '¿': 613,
  '°': 444, 'º': 464, 'ª': 453,
};
// Lo que no esté en la tabla se cuenta como la letra más ancha (la W): mejor
// achicar de más que calcular un renglón de menos.
const WIDEST_ADVANCE = 1061;

function textWidthPx(text: string, px: number): number {
  let width = 0;
  for (const ch of text.normalize('NFD')) {
    // Las tildes, la virgulilla de la ñ y la diéresis quedan como marcas
    // sueltas y no avanzan: la letra mide lo mismo que su letra base.
    const code = ch.charCodeAt(0);
    if (code >= 0x300 && code <= 0x36f) continue;
    width += GEIST_BLACK_ADVANCE[ch] ?? WIDEST_ADVANCE;
  }
  return (width * px) / 1000;
}

// Cuenta los renglones que ocupa un texto imitando al navegador: corta solo en
// los espacios y, si una palabra sola no cabe, la parte. `pieces` permite
// mezclar tamaños (el nombre y, pegada, la talla/color más chica).
function countLines(pieces: { text: string; px: number }[], maxWidth: number): number {
  let lines = 1;
  let x = 0;
  for (const { text, px } of pieces) {
    const space = textWidthPx(' ', px);
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const w = textWidthPx(word, px);
      if (x > 0 && x + space + w <= maxWidth) {
        x += space + w;
        continue;
      }
      if (x > 0) lines++;
      // Palabra más ancha que el renglón: break-words la reparte en varios.
      const full = Math.floor(w / maxWidth);
      lines += full;
      x = w - full * maxWidth;
    }
  }
  return lines;
}

// Medidas de la etiqueta CON precio (ver BarcodeLabel): ancho útil del renglón
// del nombre, con un 1.5% de margen, y el alto que le queda al nombre dentro
// de la franja imprimible una vez puestos el precio y el código de barras.
const LABEL_NAME_WIDTH_PX = 203 * 0.985;
const PRICE_LABEL_NAME_HEIGHT_PX = 26.6;
export const LABEL_NAME_LINE_HEIGHT = 1.1;

// Tamaño de fuente (px) para la etiqueta impresa CON precio: el más grande con
// el que el nombre + " · " + talla/color cabe en el alto que le toca. En la
// práctica: de 18 a 13 px si entra en un renglón, 12 a 9 px si necesita dos y
// 8 px si necesita tres. La variante va proporcionalmente más chica.
//
// Antes se elegía solo por cantidad de letras, y un nombre de dos renglones a
// 14-16 px se salía de la franja que la Brother imprime: perdía los números
// del código y la parte de arriba del nombre.
export function labelFontPx(name: string, variant = ''): { name: number; variant: number } {
  const upper = name.toUpperCase();
  for (let size = 18; size > 8; size--) {
    const variantPx = Math.max(Math.round(size * 0.72), 9);
    const pieces = [{ text: upper, px: size }];
    if (variant) pieces.push({ text: `· ${variant}`, px: variantPx });
    const height = countLines(pieces, LABEL_NAME_WIDTH_PX) * size * LABEL_NAME_LINE_HEIGHT;
    if (height <= PRICE_LABEL_NAME_HEIGHT_PX) return { name: size, variant: variantPx };
  }
  return { name: 8, variant: 8 };
}

// Igual que labelFontPx pero para la etiqueta SIN PRECIO. Acá la talla/color NO
// va pegada al nombre: lleva su propia línea en negrita, así que se mide solo
// el nombre y la variante se devuelve con su propio tamaño.
//
// El alto que manda NO son los 29 mm de la etiqueta sino los ~23 mm (~85 px)
// que la Brother imprime de verdad (ver BarcodeLabel). Los cortes están
// puestos para que el nombre quepa en esa franja junto con la talla y un
// código de barras de al menos 20 px: hasta 17 px el nombre puede ocupar dos
// renglones, y de 12 px para abajo, tres. Subir un tamaño sin rehacer esa
// cuenta vuelve a sacar texto de la zona imprimible.
export function labelFontPxNoPrice(
  name: string,
  variant = '',
): { name: number; variant: number } {
  const n = name.trim().length;
  let size: number;
  if (n <= 10) size = 22;
  else if (n <= 13) size = 19;
  else if (n <= 17) size = 17;
  else if (n <= 24) size = 15;
  else if (n <= 30) size = 14;
  else if (n <= 36) size = 13;
  else if (n <= 52) size = 12;
  else size = 10;

  // Una talla/color tan larga ya no entra en un renglón: va más chica y le
  // quita alto al nombre para que el segundo renglón no empuje el código.
  if (variant.trim().length > 20) return { name: Math.min(size, 12), variant: 10 };

  return { name: size, variant: size >= 22 ? 14 : size >= 19 ? 13 : size >= 14 ? 12 : 11 };
}
