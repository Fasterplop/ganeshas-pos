// Identificación de tienda a partir de su NOMBRE.
//
// El proyecto no tiene constantes con los UUID de las sucursales: desde
// siempre se las reconoce por una porción de su nombre ("Tienda de Ropa",
// "Tienda de Juguetes"), y así lo hacen también los scripts de `scripts/`.
// Estas funciones vivían sueltas dentro de `inventory/page.tsx`; se mueven acá
// porque ahora también las necesitan las etiquetas (la versión sin precio es
// solo para la tienda de ropa).

// Prefijo de SKU según la TIENDA dueña (juguetes -> JUG, ropa -> ROP).
export function storePrefix(storeName: string): string {
  const n = storeName.toLowerCase();
  if (n.includes('juguet')) return 'JUG';
  if (n.includes('ropa')) return 'ROP';
  return storeName.trim().substring(0, 3).toUpperCase() || 'GEN';
}

// ¿Es la tienda de ropa? Es la única donde la etiqueta puede ir sin precio.
export function isClothingStore(storeName?: string | null): boolean {
  return (storeName ?? '').toLowerCase().includes('ropa');
}

// ¿Es la juguetería? Ahí el precio SIEMPRE se imprime, por decisión del negocio.
export function isToyStore(storeName?: string | null): boolean {
  return (storeName ?? '').toLowerCase().includes('juguet');
}
