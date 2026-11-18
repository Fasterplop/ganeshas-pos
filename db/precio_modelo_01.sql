-- ============================================================================
-- Precio por modelo: cambiar de una vez el precio de TODAS las variantes de un
-- producto padre.
--
-- POR QUÉ (propuesta del 17-nov-2026, $15, aprobada por Gerardo):
--   Hoy el precio se cambia talla por talla (CHEMIS POLO NIÑO tiene 92
--   variantes: 92 veces). Con el ícono 💲 de la fila del modelo se cambian
--   todas juntas. Gerardo decide en Usuarios en qué tienda se usa: por ahora
--   NO la quiere en la Tienda de Juguetes.
--
-- QUÉ CREA:
--   1. store_settings: un interruptor por tienda (model_price_enabled). Todo
--      usuario con sesión lo LEE (el inventario decide si muestra el 💲); nadie
--      lo escribe por la API: lo cambia la pantalla Usuarios con el service
--      role, después de comprobar que quien pide es el dueño. Nace APAGADO en
--      todas las tiendas: Gerardo lo enciende en la tienda que quiera.
--   2. price_changes.batch_id y price_changes.group_id: las subidas de un
--      modelo hechas por un cajero comparten batch_id, y Novedades las muestra
--      como UNA línea («6 variantes»), no una por talla. group_id va sin llave
--      foránea a propósito: price_changes ya apunta a products, y con otra
--      llave a product_groups PostgREST la vería como tabla puente entre las
--      dos y cualquier embed products → product_groups pasaría a ser ambiguo.
--   3. set_model_price(modelo, modo, valor, cuántas variantes vio la pantalla):
--        modo 'same' → todas las variantes al precio `valor`;
--        modo 'add'  → a cada variante se le suma `valor` (negativo = bajar).
--      Todo o nada: cambian todas o ninguna. Reglas:
--        * el dueño sube o baja; un cajero con «Subir precios» solo sube: si
--          alguna variante bajaría, no cambia ninguna (PRICE_NOT_HIGHER);
--        * la tienda del modelo tiene que tener el interruptor encendido,
--          también para el dueño (FEATURE_DISABLED);
--        * si el modelo ya no tiene las variantes que vio la pantalla (alguien
--          agregó o borró una mientras tanto), no cambia nada (MODEL_CHANGED);
--        * las variantes que ya tienen el precio nuevo no se tocan, y si no
--          cambia ninguna es NOTHING_TO_CHANGE;
--        * también actualiza product_groups.default_price (el precio con el
--          que nacen las tallas nuevas del modelo, p. ej. en Traslados).
--      Las subidas de un cajero quedan en price_changes, como las de
--      raise_product_price; las del dueño no van a sus propias Novedades.
--
-- No toca raise_product_price, el trigger products_price_guard ni el ajuste
-- masivo de precios: este RPC pasa por el mismo guard con la misma bandera
-- (app.price_raise) que raise_product_price.
--
-- ERRORES (RAISE EXCEPTION, el front los traduce en src/lib/modelPrice.ts):
--   NOT_AUTHORIZED, INVALID_ARGUMENTS, GROUP_NOT_FOUND, GROUP_INACTIVE,
--   FEATURE_DISABLED, NO_VARIANTS, MODEL_CHANGED, PRICE_OUT_OF_RANGE,
--   NOTHING_TO_CHANGE, PRICE_NOT_HIGHER.
--
-- CÓMO APLICAR: en el SQL Editor de Supabase, el archivo ENTERO. Antes:
-- respaldo (node scripts/backup-db.mjs). Es idempotente: se puede volver a
-- correr. Pide un candado breve sobre price_changes (ALTER TABLE); el
-- lock_timeout hace que se rinda en vez de encolar la caja.
--
-- PARA VOLVER ATRÁS (sin borrar el historial):
--   DROP FUNCTION public.set_model_price(uuid, text, numeric, integer);
--   DROP TABLE public.store_settings;
--   NOTIFY pgrst, 'reload schema';
-- Las dos columnas de price_changes pueden quedarse: nadie más las escribe.
-- ============================================================================

SET lock_timeout = '5s';

-- ----------------------------------------------------------------------------
-- 1. Interruptor por tienda. La política va ANTES del ENABLE: el event
--    trigger ensure_rls activa la RLS en cada CREATE TABLE, y una tabla con
--    RLS y sin políticas queda muda (lista vacía, sin error).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.store_settings (
  store_id            uuid        PRIMARY KEY REFERENCES public.stores(id) ON DELETE CASCADE,
  model_price_enabled boolean     NOT NULL DEFAULT false,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

DROP POLICY IF EXISTS "store_settings_select_authenticated" ON public.store_settings;
CREATE POLICY "store_settings_select_authenticated" ON public.store_settings
  FOR SELECT TO authenticated USING (true);

ALTER TABLE public.store_settings ENABLE ROW LEVEL SECURITY;

-- Sin políticas de escritura ya nadie escribe por la API; además se quitan los
-- permisos de tabla, por si algún día alguien agrega una política de más.
REVOKE ALL ON public.store_settings FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.store_settings FROM authenticated;
GRANT SELECT ON public.store_settings TO authenticated;

-- Una fila por tienda, apagada. Las tiendas que se creen después no tienen
-- fila (= apagada) hasta que el dueño toque su interruptor.
INSERT INTO public.store_settings (store_id)
SELECT id FROM public.stores
ON CONFLICT (store_id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 2. Lote y modelo en el historial de subidas.
-- ----------------------------------------------------------------------------
ALTER TABLE public.price_changes
  ADD COLUMN IF NOT EXISTS batch_id uuid,
  ADD COLUMN IF NOT EXISTS group_id uuid;

CREATE INDEX IF NOT EXISTS price_changes_batch_id_idx
  ON public.price_changes (batch_id) WHERE batch_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 3. Precio del modelo. Devuelve jsonb:
--    { group_id, variants, changed, mode, value }
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_model_price(
  p_group_id       uuid,
  p_mode           text,
  p_value          numeric,
  p_expected_count integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role      text;
  v_active    boolean;
  v_can_raise boolean;
  v_store     uuid;
  v_g_active  boolean;
  v_default   numeric;
  v_value     numeric := round(p_value, 2);
  v_count     integer;
  v_changed   integer;
  v_down      integer;
  v_bad       integer;
  v_batch     uuid := gen_random_uuid();
BEGIN
  -- 1. Autorización: el dueño, o un cajero activo con «Subir precios». Va
  --    aquí dentro porque la clave anónima viaja en el navegador.
  SELECT role::text, is_active, can_raise_prices
    INTO v_role, v_active, v_can_raise
    FROM public.profiles
   WHERE id = auth.uid();

  IF v_role IS NULL OR COALESCE(v_active, false) = false THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;
  IF NOT (v_role = 'owner' OR (v_role = 'cashier' AND COALESCE(v_can_raise, false))) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;

  -- 2. Argumentos (tope de cordura contra un dedazo de ceros de más).
  IF p_group_id IS NULL OR p_mode IS NULL OR p_mode NOT IN ('same', 'add') OR v_value IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS';
  END IF;
  IF p_mode = 'same' AND (v_value <= 0 OR v_value > 100000) THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS';
  END IF;
  IF p_mode = 'add' AND (v_value = 0 OR abs(v_value) > 100000) THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS';
  END IF;

  -- 3. El modelo, bloqueado: dos cambios a la vez sobre el mismo modelo van
  --    uno detrás del otro.
  SELECT owner_store_id, COALESCE(is_active, false), default_price
    INTO v_store, v_g_active, v_default
    FROM public.product_groups
   WHERE id = p_group_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROUP_NOT_FOUND';
  END IF;
  IF NOT v_g_active THEN
    RAISE EXCEPTION 'GROUP_INACTIVE';
  END IF;

  -- 4. ¿Está encendido en la tienda del modelo?
  IF NOT EXISTS (SELECT 1 FROM public.store_settings
                  WHERE store_id = v_store AND model_price_enabled) THEN
    RAISE EXCEPTION 'FEATURE_DISABLED';
  END IF;

  -- 5. Sus variantes activas de esa tienda (las mismas que lista el
  --    inventario), bloqueadas.
  SELECT COUNT(*) INTO v_count
    FROM (SELECT 1
            FROM public.products
           WHERE parent_group_id = p_group_id
             AND COALESCE(is_active, false)
             AND owner_store_id = v_store
           FOR UPDATE) s;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'NO_VARIANTS';
  END IF;
  IF p_expected_count IS NOT NULL AND p_expected_count <> v_count THEN
    RAISE EXCEPTION 'MODEL_CHANGED';
  END IF;

  -- 6. Qué pasaría con cada una, antes de tocar nada.
  SELECT COUNT(*) FILTER (WHERE np <> price),
         COUNT(*) FILTER (WHERE np < price),
         COUNT(*) FILTER (WHERE np <= 0 OR np > 100000)
    INTO v_changed, v_down, v_bad
    FROM (SELECT price,
                 CASE WHEN p_mode = 'same' THEN v_value ELSE round(price + v_value, 2) END AS np
            FROM public.products
           WHERE parent_group_id = p_group_id
             AND COALESCE(is_active, false)
             AND owner_store_id = v_store) s;

  IF v_bad > 0 THEN
    RAISE EXCEPTION 'PRICE_OUT_OF_RANGE';
  END IF;
  IF v_changed = 0 THEN
    RAISE EXCEPTION 'NOTHING_TO_CHANGE';
  END IF;
  -- Un cajero solo sube: si una sola bajaría, no cambia ninguna.
  IF v_role <> 'owner' AND v_down > 0 THEN
    RAISE EXCEPTION 'PRICE_NOT_HIGHER';
  END IF;

  -- 7. Novedades del dueño: una fila por variante que sube, todas con el
  --    mismo lote. Se anota ANTES del UPDATE, con el precio de antes.
  IF v_role <> 'owner' THEN
    INSERT INTO public.price_changes (product_id, old_price, new_price, changed_by, batch_id, group_id)
    SELECT id, price, np, auth.uid(), v_batch, p_group_id
      FROM (SELECT id, price,
                   CASE WHEN p_mode = 'same' THEN v_value ELSE round(price + v_value, 2) END AS np
              FROM public.products
             WHERE parent_group_id = p_group_id
               AND COALESCE(is_active, false)
               AND owner_store_id = v_store) s
     WHERE np > price;
  END IF;

  -- 8. El cambio. La bandera (local a esta transacción) deja pasar estos
  --    UPDATE por el trigger products_price_guard, como en raise_product_price.
  PERFORM set_config('app.price_raise', '1', true);
  UPDATE public.products
     SET price = CASE WHEN p_mode = 'same' THEN v_value ELSE round(price + v_value, 2) END
   WHERE parent_group_id = p_group_id
     AND COALESCE(is_active, false)
     AND owner_store_id = v_store
     AND price <> CASE WHEN p_mode = 'same' THEN v_value ELSE round(price + v_value, 2) END;
  PERFORM set_config('app.price_raise', '', true);

  -- 9. El precio con el que nacen las tallas nuevas del modelo.
  UPDATE public.product_groups
     SET default_price = CASE
           WHEN p_mode = 'same' THEN v_value
           WHEN round(COALESCE(v_default, 0) + v_value, 2) > 0 THEN round(COALESCE(v_default, 0) + v_value, 2)
           ELSE default_price
         END
   WHERE id = p_group_id;

  RETURN jsonb_build_object(
    'group_id', p_group_id,
    'variants', v_count,
    'changed',  v_changed,
    'mode',     p_mode,
    'value',    v_value
  );
END;
$$;

REVOKE ALL ON FUNCTION public.set_model_price(uuid, text, numeric, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_model_price(uuid, text, numeric, integer) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ----------------------------------------------------------------------------
-- 4. Verificación. Esperado: rls_activa = true, politicas = 1,
--    filas_por_tienda = tiendas, encendidas = 0, columnas_nuevas = 2,
--    rpc = true.
-- ----------------------------------------------------------------------------
SELECT
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.store_settings'::regclass)              AS rls_activa,
  (SELECT COUNT(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'store_settings')   AS politicas,
  (SELECT COUNT(*) FROM public.store_settings)                                                     AS filas_por_tienda,
  (SELECT COUNT(*) FROM public.stores)                                                             AS tiendas,
  (SELECT COUNT(*) FROM public.store_settings WHERE model_price_enabled)                            AS encendidas,
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'price_changes'
      AND column_name IN ('batch_id', 'group_id'))                                                  AS columnas_nuevas,
  (SELECT prosecdef FROM pg_proc
    WHERE oid = 'public.set_model_price(uuid, text, numeric, integer)'::regprocedure)              AS rpc;
