-- ============================================================================
-- Cambios de producto (2/2) + ajuste manual de puntos (owner).
-- REQUIERE haber aplicado antes db/exchange_01_payment_method_cambio.sql
-- (como script separado; ver la explicación en ese archivo).
--
-- MODELO
--   Un cambio es una fila de `sales` con kind = 'exchange' y
--   exchange_of_sale_id -> la venta origen. Sus `sale_items` son:
--     * líneas DEVUELTAS: quantity NEGATIVA, unit_price = crédito prorrateado,
--       source_sale_item_id -> la línea original que se devuelve.
--     * líneas NUEVAS: quantity positiva, unit_price = precio de lista actual.
--   Así todo lo que ya existe "netea" solo: los top productos suman quantity,
--   los ingresos suman total_amount (= la diferencia cobrada, siempre >= 0) y
--   delete_sale_and_revert hace stock + quantity en ambas direcciones.
--   La venta origen NO se modifica: conserva su total, método y fecha.
--
-- REGLAS DE NEGOCIO (decididas por el owner)
--   * No se devuelve dinero ni se acredita: si los productos nuevos valen
--     menos que los devueltos, el cambio se rechaza (EXCHANGE_NEGATIVE).
--   * Crédito de lo devuelto = precio del ticket prorrateado por el descuento
--     manual de la venta origen. El canje de puntos de esa venta no lo reduce.
--   * Cajeros y owner registran cambios (el cajero solo en su tienda).
--     Anular un cambio (delete_sale_and_revert) es solo del owner.
--   * La diferencia se paga con efectivo/zelle/pago_movil/punto_de_venta
--     (recargo PDV 5% opcional) y puede reducirse canjeando puntos.
--   * El cambio suma FLOOR(total) puntos, como una venta.
--
-- PRE-FLIGHT (correr ANTES de aplicar y revisar el resultado): si sale_items
-- o sales tienen un CHECK sobre subtotal / unit_price / total_amount (> 0),
-- hay que relajarlo también (subtotal es negativo en las líneas devueltas y
-- total_amount es 0 en un cambio sin diferencia).
--   SELECT conrelid::regclass, conname, pg_get_constraintdef(oid)
--     FROM pg_constraint
--    WHERE conrelid IN ('public.sale_items'::regclass, 'public.sales'::regclass)
--      AND contype = 'c';
--
-- Aplicar en el SQL Editor de Supabase. Aditivo e idempotente: agrega columnas
-- con default, constraints, índices, una tabla y funciones (CREATE OR REPLACE).
-- Lo único que cambia sobre algo existente es el CHECK de sale_items.quantity,
-- que pasa de (quantity > 0) a (quantity <> 0).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. sales: tipo de fila y enlace a la venta origen
-- ----------------------------------------------------------------------------
ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'sale';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.sales'::regclass AND conname = 'sales_kind_check'
  ) THEN
    ALTER TABLE public.sales
      ADD CONSTRAINT sales_kind_check CHECK (kind IN ('sale', 'exchange'));
  END IF;
END $$;

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS exchange_of_sale_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.sales'::regclass
       AND conname = 'sales_exchange_of_sale_id_fkey'
  ) THEN
    -- Sin ON DELETE CASCADE a propósito: la BD también impide borrar una venta
    -- que tenga cambios (delete_sale_and_revert lo explica antes con
    -- SALE_HAS_EXCHANGES).
    ALTER TABLE public.sales
      ADD CONSTRAINT sales_exchange_of_sale_id_fkey
      FOREIGN KEY (exchange_of_sale_id) REFERENCES public.sales(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS sales_exchange_of_sale_id_idx
  ON public.sales (exchange_of_sale_id)
  WHERE exchange_of_sale_id IS NOT NULL;


-- ----------------------------------------------------------------------------
-- 2. sale_items: línea origen de una devolución + cantidades negativas
-- ----------------------------------------------------------------------------
ALTER TABLE public.sale_items
  ADD COLUMN IF NOT EXISTS source_sale_item_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.sale_items'::regclass
       AND conname = 'sale_items_source_sale_item_id_fkey'
  ) THEN
    ALTER TABLE public.sale_items
      ADD CONSTRAINT sale_items_source_sale_item_id_fkey
      FOREIGN KEY (source_sale_item_id) REFERENCES public.sale_items(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS sale_items_source_sale_item_id_idx
  ON public.sale_items (source_sale_item_id)
  WHERE source_sale_item_id IS NOT NULL;

-- El CHECK original (quantity > 0) pasa a (quantity <> 0): las líneas devueltas
-- de un cambio llevan cantidad negativa. Se localiza por su definición porque
-- el nombre lo generó Postgres (mismo enfoque que db/inventory_revamp.sql).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'public.sale_items'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ~* 'quantity'
       AND conname <> 'sale_items_quantity_nonzero'
  LOOP
    EXECUTE format('ALTER TABLE public.sale_items DROP CONSTRAINT %I', r.conname);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.sale_items'::regclass
       AND conname = 'sale_items_quantity_nonzero'
  ) THEN
    ALTER TABLE public.sale_items
      ADD CONSTRAINT sale_items_quantity_nonzero CHECK (quantity <> 0);
  END IF;
END $$;


-- ----------------------------------------------------------------------------
-- 3. Ajustes manuales de puntos: rastro de auditoría.
--    Sin FK a customers a propósito: delete_customer_global borra las filas del
--    cliente y este historial debe sobrevivir.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.customer_points_adjustments (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id varchar NOT NULL,
  store_id    uuid NOT NULL REFERENCES public.stores(id),
  delta       integer NOT NULL CHECK (delta <> 0),
  reason      text,
  created_by  uuid NOT NULL REFERENCES public.profiles(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS customer_points_adjustments_document_id_idx
  ON public.customer_points_adjustments (document_id, created_at DESC);


-- ----------------------------------------------------------------------------
-- 4. register_exchange: registra un cambio de forma ATÓMICA.
--    Devuelve el id de la fila `sales` del cambio.
--
--    Orden de escritura elegido para no cruzarse en deadlock con
--    delete_sale_and_revert (que bloquea store_stock y luego customers):
--      venta origen (FOR UPDATE) -> sales/sale_items -> store_stock (ordenado
--      por product_id) -> canje de puntos -> customers.
--
--    Errores (RAISE EXCEPTION, el front los traduce en src/lib/exchange.ts):
--      NOT_AUTHORIZED, NOT_AUTHORIZED_STORE, SALE_NOT_FOUND, INVALID_RATE,
--      RETURNS_REQUIRED, NEW_ITEMS_REQUIRED, RETURN_LINE_NOT_FOUND,
--      RETURN_LINE_NOT_RETURNABLE, INVALID_QUANTITY, RETURN_EXCEEDS,
--      PRODUCT_NOT_FOUND, EXCHANGE_NEGATIVE, NO_CUSTOMER_FOR_POINTS,
--      INVALID_REDEMPTION, INSUFFICIENT_POINTS (de redeem_points_global),
--      INVALID_PAYMENT_METHOD, TOTAL_MISMATCH.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_exchange(
  p_source_sale_id      uuid,
  p_returns             jsonb,    -- [{"sale_item_id": uuid, "quantity": int}]
  p_new_items           jsonb,    -- [{"product_id": uuid, "quantity": int}]
  p_payment_method      text,     -- efectivo|zelle|pago_movil|punto_de_venta (ignorado si total = 0)
  p_payment_ref         text,
  p_apply_pdv_surcharge boolean,
  p_redeem_points       integer,  -- 0 = sin canje; múltiplo de points_per_block
  p_expected_total      numeric,  -- lo que el cajero vio en pantalla
  p_bcv_rate            numeric
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role            text;
  v_assigned        uuid;
  v_active          boolean;
  v_sale            public.sales%ROWTYPE;
  v_sum_subtotal    numeric;
  v_ratio           numeric;
  v_ret             record;
  v_line            public.sale_items%ROWTYPE;
  v_returned_so_far integer;
  v_credit_unit     numeric;
  v_credit_total    numeric := 0;
  v_new             record;
  v_price           numeric;
  v_is_active       boolean;
  v_new_total       numeric := 0;
  v_diff            numeric;
  v_ppb             integer;
  v_dpb             numeric;
  v_blocks          integer;
  v_redemption_usd  numeric := 0;
  v_diff_net        numeric;
  v_surcharge       numeric := 0;
  v_total           numeric;
  v_method          text;
  v_exchange_id     uuid;
BEGIN
  -- 1. Autorización: usuario activo; el cajero solo en su tienda asignada.
  SELECT role::text, assigned_store_id, is_active
    INTO v_role, v_assigned, v_active
    FROM public.profiles
   WHERE id = auth.uid();

  IF v_role IS NULL OR COALESCE(v_active, false) = false THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;

  -- 2. Venta origen bloqueada: serializa cambios y anulaciones sobre la misma venta.
  SELECT * INTO v_sale
    FROM public.sales
   WHERE id = p_source_sale_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SALE_NOT_FOUND';
  END IF;

  IF v_role <> 'owner' AND (v_assigned IS NULL OR v_assigned <> v_sale.store_id) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED_STORE';
  END IF;

  IF p_bcv_rate IS NULL OR p_bcv_rate <= 0 THEN
    RAISE EXCEPTION 'INVALID_RATE';
  END IF;
  IF p_returns IS NULL OR jsonb_typeof(p_returns) <> 'array' OR jsonb_array_length(p_returns) = 0 THEN
    RAISE EXCEPTION 'RETURNS_REQUIRED';
  END IF;
  IF p_new_items IS NULL OR jsonb_typeof(p_new_items) <> 'array' OR jsonb_array_length(p_new_items) = 0 THEN
    RAISE EXCEPTION 'NEW_ITEMS_REQUIRED';
  END IF;
  IF COALESCE(p_redeem_points, 0) < 0 THEN
    RAISE EXCEPTION 'INVALID_REDEMPTION';
  END IF;

  -- 3. Prorrateo del descuento manual de la venta origen:
  --    r = (total - recargo PDV + canje) / Σ subtotal, acotado a [0, 1].
  --    Si la venta no tiene líneas (existe una real así) r = 1.
  --    Para una fila 'exchange' la fórmula da 1 (no tienen descuento manual).
  SELECT COALESCE(SUM(subtotal), 0) INTO v_sum_subtotal
    FROM public.sale_items
   WHERE sale_id = v_sale.id;

  IF v_sum_subtotal <= 0 THEN
    v_ratio := 1;
  ELSE
    v_ratio := (v_sale.total_amount
                - COALESCE(v_sale.punto_de_venta_surcharge_usd, 0)
                + COALESCE(v_sale.redemption_discount_usd, 0)) / v_sum_subtotal;
    v_ratio := LEAST(1, GREATEST(0, v_ratio));
  END IF;

  -- 4. Devoluciones: validar y acumular el crédito (se agrupan por línea para
  --    que un JSON con la misma línea repetida no burle el tope).
  FOR v_ret IN
    SELECT x.sale_item_id, SUM(x.quantity)::integer AS quantity
      FROM jsonb_to_recordset(p_returns) AS x(sale_item_id uuid, quantity integer)
     GROUP BY x.sale_item_id
  LOOP
    SELECT * INTO v_line
      FROM public.sale_items
     WHERE id = v_ret.sale_item_id AND sale_id = v_sale.id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'RETURN_LINE_NOT_FOUND';
    END IF;
    IF v_line.quantity <= 0 THEN
      RAISE EXCEPTION 'RETURN_LINE_NOT_RETURNABLE'; -- las líneas de crédito no se devuelven
    END IF;
    IF v_ret.quantity IS NULL OR v_ret.quantity < 1 THEN
      RAISE EXCEPTION 'INVALID_QUANTITY';
    END IF;

    SELECT COALESCE(-SUM(quantity), 0) INTO v_returned_so_far
      FROM public.sale_items
     WHERE source_sale_item_id = v_line.id;

    IF v_ret.quantity > v_line.quantity - v_returned_so_far THEN
      RAISE EXCEPTION 'RETURN_EXCEEDS';
    END IF;

    v_credit_unit  := ROUND(v_line.unit_price * v_ratio, 2);
    v_credit_total := v_credit_total + v_credit_unit * v_ret.quantity;
  END LOOP;

  -- 5. Productos nuevos: deben existir y estar activos; precio de lista actual.
  FOR v_new IN
    SELECT x.product_id, SUM(x.quantity)::integer AS quantity
      FROM jsonb_to_recordset(p_new_items) AS x(product_id uuid, quantity integer)
     GROUP BY x.product_id
  LOOP
    IF v_new.quantity IS NULL OR v_new.quantity < 1 THEN
      RAISE EXCEPTION 'INVALID_QUANTITY';
    END IF;

    SELECT price, is_active INTO v_price, v_is_active
      FROM public.products
     WHERE id = v_new.product_id;

    IF NOT FOUND OR COALESCE(v_is_active, false) = false THEN
      RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
    END IF;

    v_new_total := v_new_total + v_price * v_new.quantity;
  END LOOP;

  -- 6. Diferencia: nunca a favor del cliente.
  v_diff := ROUND(v_new_total - v_credit_total, 2);
  IF v_diff < 0 THEN
    RAISE EXCEPTION 'EXCHANGE_NEGATIVE';
  END IF;

  -- 7. Canje de puntos contra la diferencia (misma matemática por bloques del POS;
  --    el descuento se recalcula acá, no se confía en un monto del cliente).
  IF COALESCE(p_redeem_points, 0) > 0 THEN
    IF v_sale.customer_id IS NULL THEN
      RAISE EXCEPTION 'NO_CUSTOMER_FOR_POINTS';
    END IF;

    SELECT points_per_block, discount_per_block_usd INTO v_ppb, v_dpb
      FROM public.loyalty_settings
     WHERE store_id = v_sale.store_id;
    IF v_ppb IS NULL OR v_ppb <= 0 THEN
      v_ppb := 10; v_dpb := 10; -- mismo fallback que el POS
    END IF;

    IF p_redeem_points % v_ppb <> 0 THEN
      RAISE EXCEPTION 'INVALID_REDEMPTION';
    END IF;
    v_blocks         := p_redeem_points / v_ppb;
    v_redemption_usd := ROUND(v_blocks * v_dpb, 2);
    IF v_redemption_usd > v_diff THEN
      RAISE EXCEPTION 'INVALID_REDEMPTION';
    END IF;
  END IF;

  v_diff_net := ROUND(v_diff - v_redemption_usd, 2);

  -- 8. Recargo 5% Punto de Venta sobre lo que se paga con PDV (regla del POS).
  v_method := lower(trim(COALESCE(p_payment_method, '')));
  IF v_diff_net > 0 AND v_method = 'punto_de_venta' AND COALESCE(p_apply_pdv_surcharge, false) THEN
    v_surcharge := ROUND(v_diff_net * 0.05, 2);
  END IF;

  v_total := ROUND(v_diff_net + v_surcharge, 2);

  -- 9. Método de pago y control del monto que vio el cajero.
  IF v_total = 0 THEN
    v_method := 'cambio';
  ELSIF v_method NOT IN ('efectivo', 'zelle', 'pago_movil', 'punto_de_venta') THEN
    RAISE EXCEPTION 'INVALID_PAYMENT_METHOD';
  END IF;

  IF p_expected_total IS NULL OR ABS(v_total - p_expected_total) > 0.01 THEN
    RAISE EXCEPTION 'TOTAL_MISMATCH';
  END IF;

  -- 10. Cabecera del cambio (misma tienda y cliente que la venta origen).
  --     cashea_initial_usd queda en su default (0) sin nombrarla, para que la
  --     función también corra si db/cashea_initial.sql aún no se aplicó.
  INSERT INTO public.sales (
    store_id, cashier_id, customer_id, total_amount, bcv_rate,
    payment_method, payment_ref,
    redemption_discount_usd, redemption_points, punto_de_venta_surcharge_usd,
    kind, exchange_of_sale_id
  ) VALUES (
    v_sale.store_id, auth.uid(), v_sale.customer_id, v_total, p_bcv_rate,
    v_method::public.payment_method_type,
    NULLIF(trim(COALESCE(p_payment_ref, '')), ''),
    v_redemption_usd, COALESCE(p_redeem_points, 0), v_surcharge,
    'exchange', v_sale.id
  ) RETURNING id INTO v_exchange_id;

  -- Líneas devueltas (cantidad negativa, crédito prorrateado, enlace a la línea origen).
  FOR v_ret IN
    SELECT x.sale_item_id, SUM(x.quantity)::integer AS quantity
      FROM jsonb_to_recordset(p_returns) AS x(sale_item_id uuid, quantity integer)
     GROUP BY x.sale_item_id
  LOOP
    SELECT * INTO v_line FROM public.sale_items WHERE id = v_ret.sale_item_id;
    v_credit_unit := ROUND(v_line.unit_price * v_ratio, 2);

    INSERT INTO public.sale_items (
      sale_id, product_id, custom_name, quantity, unit_price, subtotal, source_sale_item_id
    ) VALUES (
      v_exchange_id, v_line.product_id, v_line.custom_name,
      -v_ret.quantity, v_credit_unit, ROUND(-v_ret.quantity * v_credit_unit, 2),
      v_line.id
    );
  END LOOP;

  -- Líneas nuevas (cantidad positiva, precio de lista).
  FOR v_new IN
    SELECT x.product_id, SUM(x.quantity)::integer AS quantity
      FROM jsonb_to_recordset(p_new_items) AS x(product_id uuid, quantity integer)
     GROUP BY x.product_id
  LOOP
    SELECT price INTO v_price FROM public.products WHERE id = v_new.product_id;

    INSERT INTO public.sale_items (
      sale_id, product_id, custom_name, quantity, unit_price, subtotal
    ) VALUES (
      v_exchange_id, v_new.product_id, NULL,
      v_new.quantity, v_price, ROUND(v_new.quantity * v_price, 2)
    );
  END LOOP;

  -- 11. Stock de la tienda de la venta: lo devuelto entra, lo nuevo sale.
  --     Una sola sentencia ordenada por product_id (evita deadlocks entre dos
  --     cambios simultáneos). Sin tope en 0, como el POS. Los productos
  --     rápidos (product_id NULL) no mueven stock.
  INSERT INTO public.store_stock (product_id, store_id, stock)
  SELECT product_id, v_sale.store_id, -SUM(quantity)
    FROM public.sale_items
   WHERE sale_id = v_exchange_id AND product_id IS NOT NULL
   GROUP BY product_id
   ORDER BY product_id
  ON CONFLICT (product_id, store_id)
  DO UPDATE SET stock = store_stock.stock + EXCLUDED.stock;

  -- 12. Canje: descuenta del pool global (lanza INSUFFICIENT_POINTS si no alcanza).
  IF COALESCE(p_redeem_points, 0) > 0 THEN
    PERFORM public.redeem_points_global(v_sale.customer_id, p_redeem_points);
  END IF;

  -- 13. Gasto y puntos ganados (1 pt por cada $1 del total, como una venta).
  --     Venta anónima o cliente borrado: no hay a quién acreditar.
  IF v_sale.customer_id IS NOT NULL THEN
    UPDATE public.customers
       SET total_spent   = COALESCE(total_spent, 0) + v_total,
           reward_points = COALESCE(reward_points, 0) + FLOOR(v_total)::integer
     WHERE document_id = v_sale.customer_id AND store_id = v_sale.store_id;
  END IF;

  RETURN v_exchange_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.register_exchange(uuid, jsonb, jsonb, text, text, boolean, integer, numeric, numeric) TO authenticated;


-- ----------------------------------------------------------------------------
-- 5. delete_sale_and_revert: misma lógica de siempre (revierte stock, puntos
--    ganados y canjeados, borra la venta) con tres agregados:
--      * verificación de owner dentro del SQL (antes solo la hacía el server
--        action y cualquier usuario autenticado podía llamar al RPC directo);
--      * FOR UPDATE sobre la venta (se serializa con un cambio en curso);
--      * SALE_HAS_EXCHANGES si alguna línea de esta venta fue devuelta en un
--        cambio: hay que anular ese cambio primero.
--    Sirve tanto para ventas como para cambios: en un cambio el loop de stock
--    hace stock + quantity con las líneas negativas (lo devuelto vuelve a
--    salir) y positivas (lo nuevo vuelve a entrar), y total_amount >= 0.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_sale_and_revert(p_sale_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_store_id          UUID;
  v_customer_id       VARCHAR;
  v_total_amount      NUMERIC;
  v_redemption_points INTEGER;
  v_points_to_deduct  INTEGER;
  v_item              RECORD;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = auth.uid() AND role = 'owner'
  ) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;

  SELECT store_id, customer_id, total_amount, redemption_points
    INTO v_store_id, v_customer_id, v_total_amount, v_redemption_points
    FROM sales
   WHERE id = p_sale_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venta no encontrada';
  END IF;

  -- Una venta (o un cambio) con líneas devueltas en otro cambio no se anula:
  -- primero se anula ese cambio, que revierte todo por sí mismo.
  IF EXISTS (
    SELECT 1
      FROM sale_items r
      JOIN sale_items s ON r.source_sale_item_id = s.id
     WHERE s.sale_id = p_sale_id
  ) THEN
    RAISE EXCEPTION 'SALE_HAS_EXCHANGES';
  END IF;

  -- Devolver el stock (los productos rápidos tienen product_id NULL y no aplican)
  FOR v_item IN (SELECT product_id, quantity FROM sale_items WHERE sale_id = p_sale_id) LOOP
    UPDATE store_stock
       SET stock = stock + v_item.quantity
     WHERE product_id = v_item.product_id AND store_id = v_store_id;
  END LOOP;

  IF v_customer_id IS NOT NULL THEN
    -- Puntos GANADOS por la venta (1pt/$1) que se quitan, MENOS los puntos
    -- CANJEADOS en la venta que se reintegran.
    v_points_to_deduct := FLOOR(v_total_amount);

    UPDATE customers
       SET total_spent   = GREATEST(total_spent - v_total_amount, 0),
           reward_points = GREATEST(reward_points - v_points_to_deduct + COALESCE(v_redemption_points, 0), 0)
     WHERE document_id = v_customer_id AND store_id = v_store_id;
  END IF;

  DELETE FROM sale_items WHERE sale_id = p_sale_id;
  DELETE FROM sales WHERE id = p_sale_id;
END;
$function$;


-- ----------------------------------------------------------------------------
-- 6. adjust_customer_points: el owner sube o baja puntos a mano, con motivo.
--    Devuelve el saldo GLOBAL nuevo (suma de todas las sucursales).
--      delta > 0: se suma a la fila de p_store_id (la tienda activa del owner)
--                 o, si el cliente no tiene fila ahí, a la fila con más puntos.
--      delta < 0: reutiliza redeem_points_global (drena de mayor a menor saldo
--                 y lanza INSUFFICIENT_POINTS si el saldo global no alcanza).
--    Errores: NOT_AUTHORIZED, INVALID_DELTA, REASON_REQUIRED,
--             CUSTOMER_NOT_FOUND, INSUFFICIENT_POINTS.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.adjust_customer_points(
  p_document_id varchar,
  p_store_id    uuid,
  p_delta       integer,
  p_reason      text
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count  integer;
  v_target uuid;
  v_total  integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = auth.uid() AND role = 'owner' AND COALESCE(is_active, true)
  ) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;

  IF p_delta IS NULL OR p_delta = 0 THEN
    RAISE EXCEPTION 'INVALID_DELTA';
  END IF;
  IF NULLIF(trim(COALESCE(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;

  -- Bloquea todas las filas del cliente (mismo patrón que redeem_points_global).
  PERFORM 1 FROM public.customers WHERE document_id = p_document_id FOR UPDATE;

  SELECT COUNT(*) INTO v_count FROM public.customers WHERE document_id = p_document_id;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'CUSTOMER_NOT_FOUND';
  END IF;

  IF p_delta > 0 THEN
    SELECT store_id INTO v_target
      FROM public.customers
     WHERE document_id = p_document_id AND store_id = p_store_id;

    IF v_target IS NULL THEN
      SELECT store_id INTO v_target
        FROM public.customers
       WHERE document_id = p_document_id
       ORDER BY reward_points DESC, created_at ASC
       LIMIT 1;
    END IF;

    UPDATE public.customers
       SET reward_points = COALESCE(reward_points, 0) + p_delta
     WHERE document_id = p_document_id AND store_id = v_target;
  ELSE
    PERFORM public.redeem_points_global(p_document_id, -p_delta);
  END IF;

  INSERT INTO public.customer_points_adjustments (document_id, store_id, delta, reason, created_by)
  VALUES (p_document_id, COALESCE(v_target, p_store_id), p_delta, trim(p_reason), auth.uid());

  SELECT COALESCE(SUM(reward_points), 0) INTO v_total
    FROM public.customers
   WHERE document_id = p_document_id;

  RETURN v_total;
END;
$$;

GRANT EXECUTE ON FUNCTION public.adjust_customer_points(varchar, uuid, integer, text) TO authenticated;
