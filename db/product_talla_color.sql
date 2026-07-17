-- ============================================================================
-- Talla y Color opcionales en el catálogo de productos.
--
-- Aditivo y NO destructivo: agrega 2 columnas nullable a public.products.
-- Los productos existentes quedan con talla/color en NULL (se muestran como
-- "N/A" en la UI y se omiten en la etiqueta impresa). No toca ventas, stock,
-- clientes ni ningún dato actual.
--
-- Ambas son texto libre (las tallas varían: S/M/L, 10, 38...; los colores son
-- abiertos). Se muestran SIEMPRE juntas con el formato "Talla · Color"
-- (ver src/lib/productVariant.ts): "S · Beige" / "S" / "Beige" / "N/A".
--
-- Aplicar en el SQL Editor de Supabase.
-- ============================================================================

ALTER TABLE public.products ADD COLUMN IF NOT EXISTS talla text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS color text;
