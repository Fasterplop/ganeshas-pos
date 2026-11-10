// Búsqueda de productos tolerante a espacios.
//
// En nov-2026 había 159 productos y 29 modelos con espacios dobles en el
// nombre ("ZAPATILLA  SABINA-33K"). En pantalla se ven como uno solo —el
// navegador los junta—, así que quien escribía "zapatilla sabina" no los
// encontraba en ningún buscador.

/** Minúsculas, cualquier tanda de espacios/tabuladores como un espacio, sin bordes. */
export const normalizeSearch = (s: string | null | undefined): string =>
  (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Patrón para `ilike` que acepta cualquier cantidad de espacios entre
 * palabras: "zapatilla sabina" → "%zapatilla%sabina%". El término debe venir
 * ya limpio de los caracteres que rompen el filtro `.or()` de PostgREST.
 */
export const ilikeWords = (term: string): string => `%${term.trim().split(/\s+/).join('%')}%`;
