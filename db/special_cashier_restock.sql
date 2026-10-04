-- ============================================================================
-- Cajero "reponedor": permiso especial para SUBIR stock en TODAS las tiendas.
--   1) profiles.can_restock_all: bandera del permiso (la activa el owner en /users).
--   2) Lectura de store_stock entre tiendas (para el filtro de vista de inventario,
--      disponible a ambos roles).
--   3) RPC restock_stock: sube stock respetando el permiso y "solo aumentar".
-- Aplicar en el SQL Editor de Supabase. Todo aditivo.
-- ============================================================================

-- 1) Permiso especial.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS can_restock_all boolean NOT NULL DEFAULT false;

-- 2) Lectura de stock de cualquier tienda (para ver el inventario de la otra
--    tienda en el filtro de solo-vista). El stock no es dato sensible.
DROP POLICY IF EXISTS store_stock_select_all ON public.store_stock;
CREATE POLICY store_stock_select_all ON public.store_stock
  FOR SELECT TO authenticated USING (true);

-- 3) Reponer stock de forma segura: restock_stock se define en
--    db/restock_local_scope.sql (agrega el alcance "solo su tienda").
