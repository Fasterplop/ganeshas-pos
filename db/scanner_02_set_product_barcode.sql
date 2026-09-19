-- ============================================================================
-- Cambiar el código de barras de un producto desde el inventario.
--
-- POR QUÉ: los cajeros con permiso de reposición ya pueden AÑADIR productos
-- (y ahí eligen el código), pero al EDITAR uno existente el campo está en
-- readOnly y el submit solo repone stock. Cuando una etiqueta se despega, se
-- moja o el código de fábrica cambia, hacía falta el owner. Este RPC abre esa
-- operación a los mismos cajeros que ya pueden añadir, validando en el
-- servidor (la clave anónima viaja en el navegador: la UI no es una defensa).
--
-- ALCANCE (calcado de `restock_stock`, db/restock_local_scope.sql):
--   owner              -> cualquier producto.
--   can_restock_all    -> cualquier producto.
--   can_restock_local  -> solo productos cuya tienda dueña es su tienda asignada.
--   sin reposición     -> NOT_AUTHORIZED.
--
-- DECISIÓN DE NEGOCIO: el cambio es DIRECTO, sin historial de códigos viejos.
-- Las etiquetas ya pegadas con el código anterior DEJAN DE ESCANEAR. La UI lo
-- advierte de forma explícita antes de guardar.
--
-- TODO ADITIVO: solo crea una función. No toca tablas ni datos.
--
-- Aplicar en el SQL Editor de Supabase.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.set_product_barcode(
  p_product_id uuid,
  p_new_sku    text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role      text;
  v_assigned  uuid;
  v_can_all   boolean;
  v_can_local boolean;
  v_owner     uuid;
  v_active    boolean;
  v_current   text;
  v_sku       text := trim(COALESCE(p_new_sku, ''));
BEGIN
  SELECT role::text, assigned_store_id, can_restock_all, can_restock_local
    INTO v_role, v_assigned, v_can_all, v_can_local
    FROM public.profiles WHERE id = auth.uid();

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;

  IF v_sku = '' THEN
    RAISE EXCEPTION 'EMPTY_SKU';
  END IF;
  IF length(v_sku) > 64 THEN
    RAISE EXCEPTION 'SKU_TOO_LONG';
  END IF;

  SELECT owner_store_id, COALESCE(is_active, false), sku_barcode
    INTO v_owner, v_active, v_current
    FROM public.products
   WHERE id = p_product_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
  END IF;

  -- Un producto eliminado (borrado lógico) no se re-etiqueta: si va a volver
  -- al piso de venta, primero se reactiva.
  IF v_active = false THEN
    RAISE EXCEPTION 'PRODUCT_INACTIVE';
  END IF;

  -- Autorización por alcance (el owner no tiene restricción de tienda).
  IF v_role <> 'owner' THEN
    IF COALESCE(v_can_all, false) THEN
      NULL; -- global: cualquier producto.
    ELSIF COALESCE(v_can_local, false) THEN
      IF v_owner IS NULL OR v_assigned IS NULL OR v_owner <> v_assigned THEN
        RAISE EXCEPTION 'NOT_AUTHORIZED_STORE';
      END IF;
    ELSE
      RAISE EXCEPTION 'NOT_AUTHORIZED'; -- sin permiso de reposición.
    END IF;
  END IF;

  -- Mismo código: no se toca nada (idempotente).
  IF v_current = v_sku THEN
    RETURN v_sku;
  END IF;

  BEGIN
    UPDATE public.products SET sku_barcode = v_sku WHERE id = p_product_id;
  EXCEPTION WHEN unique_violation THEN
    -- products.sku_barcode es NOT NULL UNIQUE: el código ya es de otro producto.
    RAISE EXCEPTION 'SKU_TAKEN';
  END;

  RETURN v_sku;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_product_barcode(uuid, text) TO authenticated;

-- ============================================================================
-- VERIFICACIÓN
-- ============================================================================
SELECT jsonb_pretty(jsonb_build_object(
  'funcion_creada', EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'set_product_barcode'
  ),
  'ejecutable_por_authenticated', has_function_privilege(
    'authenticated', 'public.set_product_barcode(uuid, text)', 'EXECUTE'
  )
));
