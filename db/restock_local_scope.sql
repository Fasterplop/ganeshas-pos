-- ============================================================================
-- Alcance de reposición del cajero: "sin reposición" / "solo su tienda" / "todas".
--
-- Antes existía solo profiles.can_restock_all (global). Se agrega
-- profiles.can_restock_local para el nivel intermedio: reponer stock ÚNICAMENTE
-- en la tienda asignada del cajero. El owner elige el alcance en /users.
--
-- Alcances (cómo se guardan las dos banderas):
--   sin reposición → can_restock_all = false, can_restock_local = false
--   solo su tienda → can_restock_all = false, can_restock_local = true
--   todas          → can_restock_all = true   (can_restock_local se ignora)
--
-- Aplicar en el SQL Editor de Supabase. TODO ADITIVO: no borra ni altera datos
-- existentes; los cajeros ya creados quedan con can_restock_local = false (su
-- comportamiento no cambia). El RPC se reemplaza (CREATE OR REPLACE), sin tocar
-- ninguna tabla de clientes/ventas/stock.
-- ============================================================================

-- 1) Nueva bandera: reponer solo en la tienda asignada.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS can_restock_local boolean NOT NULL DEFAULT false;

-- 2) Reponer stock de forma segura (reemplaza la versión de special_cashier_restock.sql).
--    - owner: cualquier tienda, cualquier valor.
--    - cajero can_restock_all (global): cualquier tienda, pero SOLO puede subir.
--    - cajero can_restock_local (local): SOLO su tienda asignada, y SOLO subir.
--    - cajero sin permiso: no puede reponer.
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
  v_role      text;
  v_assigned  uuid;
  v_can_all   boolean;
  v_can_local boolean;
  v_current   integer;
BEGIN
  SELECT role::text, assigned_store_id, can_restock_all, can_restock_local
    INTO v_role, v_assigned, v_can_all, v_can_local
    FROM public.profiles WHERE id = auth.uid();

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;

  -- Autorización por alcance (el owner no tiene restricción de tienda).
  IF v_role <> 'owner' THEN
    IF COALESCE(v_can_all, false) THEN
      NULL; -- global: cualquier tienda.
    ELSIF COALESCE(v_can_local, false) THEN
      IF p_store_id <> v_assigned THEN
        RAISE EXCEPTION 'NOT_AUTHORIZED_STORE'; -- local: solo su tienda asignada.
      END IF;
    ELSE
      RAISE EXCEPTION 'NOT_AUTHORIZED'; -- sin permiso de reposición.
    END IF;
  END IF;

  -- Stock actual (0 si aún no existe la fila).
  SELECT stock INTO v_current
    FROM public.store_stock
   WHERE product_id = p_product_id AND store_id = p_store_id;
  IF v_current IS NULL THEN v_current := 0; END IF;

  -- Los cajeros (con cualquier alcance) solo pueden SUBIR stock.
  IF v_role <> 'owner' AND p_new_stock < v_current THEN
    RAISE EXCEPTION 'ONLY_INCREASE';
  END IF;

  INSERT INTO public.store_stock (product_id, store_id, stock)
  VALUES (p_product_id, p_store_id, p_new_stock)
  ON CONFLICT (product_id, store_id) DO UPDATE SET stock = EXCLUDED.stock;
END;
$$;

GRANT EXECUTE ON FUNCTION public.restock_stock(uuid, uuid, integer) TO authenticated;
