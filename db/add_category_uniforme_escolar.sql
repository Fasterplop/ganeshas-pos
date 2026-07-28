-- ============================================================================
-- Agrega la categoría 'uniforme_escolar' al enum de categorías de producto.
-- (El enum product_category_v2 se creó en db/inventory_revamp.sql.)
-- Aplicar en el SQL Editor de Supabase. Aditivo, no destructivo.
-- YA APLICADA en producción (2026-07-28).
-- ============================================================================
ALTER TYPE public.product_category_v2 ADD VALUE IF NOT EXISTS 'uniforme_escolar';
