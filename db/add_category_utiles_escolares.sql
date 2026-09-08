-- ============================================================================
-- Agrega la categoría 'utiles_escolares' al enum de categorías de producto.
-- (El enum product_category_v2 se creó en db/inventory_revamp.sql; lo usan
-- products.category y product_groups.category, así que cubre ambas.)
-- Regla de UI: el formulario de Inventario solo ofrece esta categoría cuando
-- la tienda dueña es la Tienda de Juguetes.
-- Aplicar en el SQL Editor de Supabase. Aditivo, no destructivo.
-- ============================================================================
ALTER TYPE public.product_category_v2 ADD VALUE IF NOT EXISTS 'utiles_escolares';
