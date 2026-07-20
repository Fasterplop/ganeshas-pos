-- ============================================================================
-- Agrega la categoría 'lentes' al enum de categorías de producto.
-- (El enum product_category_v2 se creó en db/inventory_revamp.sql.)
-- Aplicar en el SQL Editor de Supabase. Aditivo, no destructivo.
-- ============================================================================
ALTER TYPE public.product_category_v2 ADD VALUE IF NOT EXISTS 'lentes';
