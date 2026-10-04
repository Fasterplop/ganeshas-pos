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
-- 4. register_exchange: NO se define acá. Su única definición está en
--    db/exchange_03_discount.sql (precio con oferta, solo caja o dueño,
--    descuento manual). Cada función vive en un solo archivo para que volver
--    a correr uno viejo no pueda pisarla con una versión anterior.
-- ----------------------------------------------------------------------------


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
