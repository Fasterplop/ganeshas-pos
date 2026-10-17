-- ============================================================================
-- Transferencias entre tiendas (2): PASAR un producto a la otra tienda.
--
-- POR QUÉ: transferir (transfer_01) mueve UNIDADES y el producto sigue siendo
-- de su tienda dueña. Sirve para vender allá o exhibir un tiempo, pero no
-- para mudar un producto: la primera transferencia real (2026-10-16, un
-- perfume de Juguetes a Ropa con la nota «TRAIDO A SUCURSAL AQUI YA NO HAY»)
-- dejó la unidad en Ropa, el perfume fuera del inventario de Ropa (que lista
-- solo lo propio) y en el de Juguetes con 0 y el chip «1 en Ropa». El dueño
-- esperaba encontrarlo en Ropa.
--
-- QUÉ HACE move_product_to_store: el producto pasa a ser de la otra tienda.
--   * products.owner_store_id = la tienda nueva.
--   * TODAS las unidades de la tienda vieja pasan a la nueva (la vieja queda
--     en 0). Las que la tienda nueva ya tenía traídas se suman: eran de este
--     mismo producto. Si la tienda vieja tiene el producto en NEGATIVO no se
--     pasa (OWNER_STOCK_NEGATIVE): ese negativo es un conteo por revisar y
--     mudarlo lo escondería en la cuenta de la otra tienda.
--   * Conserva código, etiqueta, precio y categoría. El código puede llevar el
--     prefijo de la tienda vieja (JUG-/ROP-): da igual, la etiqueta impresa
--     sigue sirviendo y el UNIQUE es global.
--   * Ofertas: las de ESTE producto (y las del modelo, si el modelo se muda)
--     anotadas a la tienda vieja pasan a la nueva. Las de categoría son de
--     cada tienda: el producto toma las de la tienda nueva.
--
-- MODELOS (variantes): un producto y su modelo (product_groups) son siempre
-- de la misma tienda; hoy no hay ninguna excepción y esto no la crea.
--   * Si el producto es la ÚNICA variante activa del modelo, o se pide el
--     modelo completo (p_whole_group), se muda el modelo con todas sus
--     variantes activas, cada una con sus unidades.
--   * Si no, solo esa variante: sale del modelo (parent_group_id = NULL) y
--     llega a la tienda nueva como producto suelto, con su nombre, talla y
--     color. Las demás tallas siguen en la tienda vieja.
--
-- QUIÉN PUEDE: lo mismo que transferir desde el inventario: el dueño y los
-- cajeros con perfil activo; el cajero, solo si una de las dos tiendas es la
-- suya. El vendedor no (no entra al inventario, que es donde está el botón).
--
-- HISTORIAL: una fila por producto mudado en stock_transfers, con
-- changes_owner = true. La cantidad puede ser 0 (el perfume del ejemplo ya
-- estaba en Ropa: se muda el producto sin mover ninguna unidad), por eso el
-- CHECK de quantity se afloja solo para esas filas.
--
-- IDEMPOTENCIA: p_request_id queda en la fila del producto que se tocó. Un
-- doble clic o un reintento devuelve el resultado del primero; si el producto
-- ya es de la tienda destino sin ese id, es ALREADY_OWNER (pantalla vieja).
--
-- ERRORES (RAISE EXCEPTION, el front los traduce en src/lib/transfers.ts):
--   NOT_AUTHORIZED, NOT_AUTHORIZED_STORE, INVALID_ARGUMENTS, STORE_NOT_AVAILABLE,
--   PRODUCT_NOT_FOUND, PRODUCT_INACTIVE, NO_OWNER_STORE, ALREADY_OWNER,
--   OWNER_STOCK_NEGATIVE.
--
-- ORDEN DE BLOQUEO: el modelo, el producto, sus hermanas (por id) y al final
-- las filas de store_stock (por producto y tienda). transfer_stock no bloquea
-- products, así que no puede cerrar un ciclo con esto.
--
-- CÓMO APLICAR: en el SQL Editor de Supabase, el archivo ENTERO, con las
-- tiendas cerradas (el ALTER de stock_transfers pide un candado breve; el
-- lock_timeout hace que se rinda en vez de encolar la caja). Requiere
-- db/transfer_01_stock_transfers.sql. Antes: respaldo (node scripts/backup-db.mjs).
-- Es idempotente: se puede volver a correr.
--
-- PARA VOLVER ATRÁS: los productos ya mudados se quedan en su tienda nueva
-- (eso es un dato, no esquema). Para quitar la función:
--   DROP FUNCTION public.move_product_to_store(uuid, uuid, boolean, text, uuid);
--   NOTIFY pgrst, 'reload schema';
-- La columna changes_owner puede quedarse: nada más la lee.
-- ============================================================================

SET lock_timeout = '5s';

-- ----------------------------------------------------------------------------
-- 1. Historial: marcar las filas que mudan el producto y permitir cantidad 0
--    solo en ellas. El CHECK viejo se busca por su definición y no por su
--    nombre, por si Postgres lo nombró distinto.
-- ----------------------------------------------------------------------------
ALTER TABLE public.stock_transfers
  ADD COLUMN IF NOT EXISTS changes_owner boolean NOT NULL DEFAULT false;

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.stock_transfers'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%quantity%'
  LOOP
    EXECUTE format('ALTER TABLE public.stock_transfers DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.stock_transfers
  ADD CONSTRAINT stock_transfers_quantity_check
  CHECK (quantity > 0 OR (changes_owner AND quantity = 0));

-- ----------------------------------------------------------------------------
-- 2. Pasar el producto (o su modelo completo) a otra tienda.
--    Devuelve jsonb: { product_id, from_store_id, to_store_id, product_ids,
--                      units, from_stock, to_stock, group_id, group_name,
--                      group_moved, detached, replayed }.
--    from_stock / to_stock son del producto que se tocó.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.move_product_to_store(
  p_product_id  uuid,
  p_to_store_id uuid,
  p_whole_group boolean DEFAULT false,  -- si es variante: mudar el modelo entero
  p_note        text    DEFAULT NULL,
  p_request_id  uuid    DEFAULT NULL    -- idempotencia (doble clic / reintento)
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role        text;
  v_assigned    uuid;
  v_active      boolean;
  v_from        uuid;
  v_prod_active boolean;
  v_group       uuid;
  v_group_name  text;
  v_siblings    integer := 0;
  v_move_group  boolean := false;
  v_ids         uuid[];
  v_pid         uuid;
  v_old         integer;
  v_from_after  integer;
  v_to_after    integer;
  v_units       integer := 0;
  v_res_from    integer;
  v_res_to      integer;
  v_bad         text;
  v_prev        public.stock_transfers%ROWTYPE;
  v_note        text := NULLIF(trim(COALESCE(p_note, '')), '');
BEGIN
  -- 1. Autorización (misma razón que en transfer_stock: la clave anónima
  --    viaja en el navegador, el front no alcanza).
  SELECT role::text, assigned_store_id, is_active
    INTO v_role, v_assigned, v_active
    FROM public.profiles
   WHERE id = auth.uid();

  IF v_role IS NULL OR COALESCE(v_active, false) = false THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;
  IF v_role NOT IN ('owner', 'cashier') THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;

  IF p_product_id IS NULL OR p_to_store_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS';
  END IF;

  -- 2. Bloqueos: primero el modelo (si tiene), después el producto. Al revés,
  --    dos personas mudando a la vez dos tallas del mismo modelo se trabarían.
  --    Si entre la lectura y el bloqueo el producto cambió de modelo, se
  --    rechaza: la pantalla de quien lo pidió ya está vieja.
  SELECT parent_group_id INTO v_group FROM public.products WHERE id = p_product_id;
  IF v_group IS NOT NULL THEN
    SELECT name INTO v_group_name FROM public.product_groups WHERE id = v_group FOR UPDATE;
  END IF;

  SELECT owner_store_id, COALESCE(is_active, false)
    INTO v_from, v_prod_active
    FROM public.products
   WHERE id = p_product_id
     AND parent_group_id IS NOT DISTINCT FROM v_group
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
  END IF;

  -- 3. Idempotencia, DESPUÉS del bloqueo: un reintento que llega mientras el
  --    primero sigue en curso espera el candado y aquí ya lo ve confirmado.
  IF p_request_id IS NOT NULL THEN
    SELECT * INTO v_prev FROM public.stock_transfers WHERE request_id = p_request_id;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'product_id',    v_prev.product_id,
        'from_store_id', v_prev.from_store_id,
        'to_store_id',   v_prev.to_store_id,
        'product_ids',   jsonb_build_array(v_prev.product_id),
        'units',         v_prev.quantity,
        'from_stock',    v_prev.from_stock_after,
        'to_stock',      v_prev.to_stock_after,
        'group_id',      NULL,
        'group_name',    NULL,
        'group_moved',   false,
        'detached',      false,
        'replayed',      true
      );
    END IF;
  END IF;

  IF NOT v_prod_active THEN
    RAISE EXCEPTION 'PRODUCT_INACTIVE';
  END IF;
  IF v_from IS NULL THEN
    RAISE EXCEPTION 'NO_OWNER_STORE';
  END IF;
  IF v_from = p_to_store_id THEN
    RAISE EXCEPTION 'ALREADY_OWNER';
  END IF;

  -- 4. El cajero solo muda desde o hacia su propia tienda.
  IF v_role <> 'owner' AND (v_assigned IS NULL OR v_assigned NOT IN (v_from, p_to_store_id)) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED_STORE';
  END IF;

  IF (SELECT COUNT(*) FROM public.stores
       WHERE id IN (v_from, p_to_store_id) AND COALESCE(is_active, false)) <> 2 THEN
    RAISE EXCEPTION 'STORE_NOT_AVAILABLE';
  END IF;

  -- 5. Qué se muda: el producto solo, o el modelo con sus variantes activas.
  --    Las variantes desactivadas (borrado lógico) no se tocan.
  IF v_group IS NOT NULL THEN
    SELECT COUNT(*) INTO v_siblings
      FROM public.products
     WHERE parent_group_id = v_group
       AND id <> p_product_id
       AND COALESCE(is_active, false);

    v_move_group := COALESCE(p_whole_group, false) OR v_siblings = 0;
  END IF;

  IF v_move_group THEN
    -- Las hermanas, bloqueadas en orden fijo. Tienen que ser de la misma
    -- tienda que el producto: si alguna no lo es, el modelo ya estaba mal
    -- y no se adivina qué hacer.
    SELECT array_agg(id ORDER BY id) INTO v_ids
      FROM (SELECT id FROM public.products
             WHERE parent_group_id = v_group AND COALESCE(is_active, false)
             ORDER BY id
               FOR UPDATE) s;

    IF EXISTS (SELECT 1 FROM public.products
                WHERE id = ANY (v_ids) AND owner_store_id IS DISTINCT FROM v_from) THEN
      RAISE EXCEPTION 'INVALID_ARGUMENTS';
    END IF;
  ELSE
    v_ids := ARRAY[p_product_id];
  END IF;

  -- 6. Filas de stock: asegurarlas (el trigger de alta ya las crea) y
  --    bloquearlas en orden fijo.
  INSERT INTO public.store_stock (product_id, store_id, stock)
  SELECT pid, sid, 0
    FROM unnest(v_ids) AS pid
   CROSS JOIN (VALUES (v_from), (p_to_store_id)) AS t(sid)
  ON CONFLICT (product_id, store_id) DO NOTHING;

  PERFORM 1
     FROM public.store_stock
    WHERE product_id = ANY (v_ids)
      AND store_id IN (v_from, p_to_store_id)
    ORDER BY product_id, store_id
      FOR UPDATE;

  -- 7. Un negativo en la tienda vieja es un conteo por revisar: no se muda.
  SELECT p.name INTO v_bad
    FROM public.store_stock s
    JOIN public.products p ON p.id = s.product_id
   WHERE s.product_id = ANY (v_ids)
     AND s.store_id = v_from
     AND COALESCE(s.stock, 0) < 0
   LIMIT 1;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'OWNER_STOCK_NEGATIVE: %', v_bad;
  END IF;

  -- 8. Mudar cada producto: sus unidades por DELTA, la tienda dueña y el
  --    registro.
  FOREACH v_pid IN ARRAY v_ids LOOP
    SELECT COALESCE(stock, 0) INTO v_old
      FROM public.store_stock
     WHERE product_id = v_pid AND store_id = v_from;

    UPDATE public.store_stock
       SET stock = COALESCE(stock, 0) - v_old
     WHERE product_id = v_pid AND store_id = v_from
    RETURNING stock INTO v_from_after;

    UPDATE public.store_stock
       SET stock = COALESCE(stock, 0) + v_old
     WHERE product_id = v_pid AND store_id = p_to_store_id
    RETURNING stock INTO v_to_after;

    UPDATE public.products
       SET owner_store_id  = p_to_store_id,
           parent_group_id = CASE WHEN v_move_group THEN parent_group_id ELSE NULL END
     WHERE id = v_pid;

    INSERT INTO public.stock_transfers (
      product_id, from_store_id, to_store_id, quantity,
      from_stock_after, to_stock_after, note, source, request_id, created_by, changes_owner
    ) VALUES (
      v_pid, v_from, p_to_store_id, v_old,
      v_from_after, v_to_after, v_note, 'inventory',
      CASE WHEN v_pid = p_product_id THEN p_request_id END,
      auth.uid(), true
    );

    v_units := v_units + v_old;
    IF v_pid = p_product_id THEN
      v_res_from := v_from_after;
      v_res_to   := v_to_after;
    END IF;
  END LOOP;

  -- 9. El modelo, y las ofertas que viajan con el producto.
  IF v_move_group THEN
    UPDATE public.product_groups SET owner_store_id = p_to_store_id WHERE id = v_group;

    UPDATE public.product_offers
       SET store_id = p_to_store_id
     WHERE scope = 'group' AND group_id = v_group AND store_id = v_from;
  END IF;

  UPDATE public.product_offers
     SET store_id = p_to_store_id
   WHERE scope = 'product' AND product_id = ANY (v_ids) AND store_id = v_from;

  RETURN jsonb_build_object(
    'product_id',    p_product_id,
    'from_store_id', v_from,
    'to_store_id',   p_to_store_id,
    'product_ids',   to_jsonb(v_ids),
    'units',         v_units,
    'from_stock',    v_res_from,
    'to_stock',      v_res_to,
    'group_id',      v_group,
    'group_name',    v_group_name,
    'group_moved',   v_move_group,
    'detached',      v_group IS NOT NULL AND NOT v_move_group,
    'replayed',      false
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.move_product_to_store(uuid, uuid, boolean, text, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- VERIFICACIÓN. Tiene que dar:
--   columna = true, check = la definición nueva (con changes_owner),
--   versiones = 1, security_definer = true, ejecutable = true,
--   suma_stock_total = el mismo número de antes (esto no mueve stock).
-- ============================================================================
SELECT jsonb_pretty(jsonb_build_object(
  'columna', EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'stock_transfers' AND column_name = 'changes_owner'
  ),
  'check', (
    SELECT jsonb_agg(pg_get_constraintdef(oid)) FROM pg_constraint
     WHERE conrelid = 'public.stock_transfers'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%quantity%'
  ),
  'versiones', (
    SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'move_product_to_store'
  ),
  'security_definer', (
    SELECT bool_and(p.prosecdef) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'move_product_to_store'
  ),
  'ejecutable', has_function_privilege(
    'authenticated', 'public.move_product_to_store(uuid, uuid, boolean, text, uuid)', 'EXECUTE'
  ),
  'suma_stock_total', (SELECT SUM(stock) FROM public.store_stock)
));
