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

-- 3) Reponer stock de forma segura.
--    - owner: cualquier tienda, cualquier valor.
--    - cajero con can_restock_all: cualquier tienda, pero SOLO puede subir.
--    - cajero normal: solo su tienda asignada, y SOLO puede subir.
CREATE OR REPLACE FUNCTION public.restock_stock(
  p_product_id uuid,
  p_store_id   uuid,
  p_new_stock  integer
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role     text;
  v_assigned uuid;
  v_can_all  boolean;
  v_current  integer;
BEGIN
  SELECT role::text, assigned_store_id, can_restock_all
    INTO v_role, v_assigned, v_can_all
    FROM public.profiles WHERE id = auth.uid();

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;

  -- Autorización por tienda (los cajeros sin permiso solo su tienda asignada).
  IF v_role <> 'owner' AND NOT COALESCE(v_can_all, false) AND p_store_id <> v_assigned THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED_STORE';
  END IF;

  -- Stock actual (0 si aún no existe la fila).
  SELECT stock INTO v_current
    FROM public.store_stock
   WHERE product_id = p_product_id AND store_id = p_store_id;
  IF v_current IS NULL THEN v_current := 0; END IF;

  -- Los cajeros (con o sin permiso) solo pueden SUBIR stock.
  IF v_role <> 'owner' AND p_new_stock < v_current THEN
    RAISE EXCEPTION 'ONLY_INCREASE';
  END IF;

  INSERT INTO public.store_stock (product_id, store_id, stock)
  VALUES (p_product_id, p_store_id, p_new_stock)
  ON CONFLICT (product_id, store_id) DO UPDATE SET stock = EXCLUDED.stock;
END;
$$;

GRANT EXECUTE ON FUNCTION public.restock_stock(uuid, uuid, integer) TO authenticated;
