// Categorías de producto: el enum `product_category_v2` de la base, con su
// nombre para mostrar.
//
// El orden es el del enum (db/inventory_revamp.sql más los db/add_category_*.sql).
// La fuente de verdad del VALOR sigue siendo la base; esto solo traduce.

export const PRODUCT_CATEGORIES = [
  'juguetes',
  'ropa',
  'zapato',
  'perfume',
  'accesorios',
  'lentes',
  'uniforme_escolar',
  'utiles_escolares',
  'bolso',
  'navaja_suiza',
] as const;

export type ProductCategoryValue = (typeof PRODUCT_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<string, string> = {
  juguetes: 'Juguetes',
  ropa: 'Ropa',
  zapato: 'Zapato',
  perfume: 'Perfume',
  accesorios: 'Accesorios',
  lentes: 'Lentes',
  uniforme_escolar: 'Uniformes Escolares',
  utiles_escolares: 'Útiles Escolares',
  bolso: 'Bolso',
  navaja_suiza: 'Navaja Suiza',
};

export const categoryLabel = (c: string) => CATEGORY_LABELS[c] ?? c;
