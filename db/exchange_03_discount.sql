-- ============================================================================
-- Cambios de producto (3): descuento manual sobre la diferencia.
--
-- POR QUÉ: en una venta del POS el cajero puede aplicar un descuento manual;
-- en un cambio de producto no había forma. register_exchange recalcula el
-- total en el servidor y rechaza con TOTAL_MISMATCH cualquier monto que no
-- cuadre, así que el descuento tiene que entrar por el RPC: no alcanza con
-- restarlo en la pantalla.
--
-- QUÉ CAMBIA respecto al cuerpo vigente (el de db/role_consulta_02_rpc.sql):
--
--   1. Parámetro nuevo al final: p_discount_usd numeric DEFAULT 0. Es un MONTO
--      en USD (el porcentaje lo convierte la pantalla). Se resta de la
--      diferencia ANTES del canje de puntos y del recargo de Punto de Venta,
--      el mismo orden que usa el POS. No puede ser negativo ni mayor que la
--      diferencia (INVALID_DISCOUNT): un cambio nunca queda a favor del
--      cliente. Con 0 —o sin mandarlo— la función hace lo mismo de siempre.
--
--   2. El descuento NO se guarda en una columna. Queda implícito en
--      total_amount, igual que el descuento manual de una venta del POS:
--      descuento = Σ subtotal - (total - recargo PDV + canje).
--      Por eso este archivo no toca ninguna tabla.
--
--   3. Fórmula del crédito (paso 3). Antes:
--        r = (total - recargo + canje) / Σ subtotal de TODAS las líneas
--      Ahora:
--        r = (total - recargo + canje + crédito de las líneas devueltas)
--            / Σ subtotal de las líneas POSITIVAS
--      * Venta normal: no tiene líneas devueltas -> exactamente lo mismo.
--      * Cambio sin descuento: da 1 -> exactamente lo mismo.
--      * Cambio CON descuento (no existía hasta hoy): da
--        (nuevos - descuento) / nuevos. La fórmula vieja dividía entre la
--        diferencia: si a un cambio se le perdonaba la diferencia entera, un
--        cambio posterior sobre esos productos les daba crédito $0.
--      La consulta de VERIFICACIÓN del final cuenta cuántas ventas existentes
--      cambian de resultado con la fórmula nueva: tiene que dar 0.
--
--   Todo lo demás —autorización (owner/cashier, cajero solo en su tienda),
--   tope de devolución, precio efectivo con oferta, canje de puntos, recargo
--   de punto de venta, movimiento de stock, puntos ganados— es idéntico,
--   carácter por carácter.
--
-- POR QUÉ HAY UN DROP: agregar un parámetro cambia la firma, y CREATE OR
-- REPLACE con otra firma NO reemplaza: crea una SEGUNDA función con el mismo
-- nombre. Con las dos vivas PostgREST no sabe a cuál llamar y todo cambio de
-- producto falla (PGRST203). El DROP y el CREATE van en este mismo script: el
-- SQL Editor lo corre en UNA transacción, así que la caja nunca ve la función
-- a medio cambiar. CORRER EL ARCHIVO ENTERO, no por partes.
--
-- COMPATIBLE CON EL POS YA DESPLEGADO: el front viejo llama con los 9
-- parámetros de siempre y el décimo toma su default (0). El front nuevo solo
-- manda p_discount_usd cuando hay descuento, así que también funciona si se
-- despliega ANTES de aplicar este archivo (pedir un descuento avisa que falta
-- la migración; un cambio sin descuento se registra normal).
--
-- OJO, NO VOLVER A CORRER db/exchange_02_schema_and_rpc.sql,
-- db/scanner_04_exchange_offers.sql NI db/role_consulta_02_rpc.sql después de
-- este archivo: los tres recrean la versión de 9 parámetros AL LADO de esta y
-- dejan las dos vivas (el PGRST203 de arriba). Si pasara, se arregla volviendo
-- a correr este archivo.
--
-- PARA VOLVER ATRÁS:
--   DROP FUNCTION public.register_exchange(uuid, jsonb, jsonb, text, text, boolean, integer, numeric, numeric, numeric);
--   y después correr SOLO la sección 3 de db/role_consulta_02_rpc.sql.
--   (Si ya se registraron cambios con descuento, la fórmula vieja del crédito
--   vuelve a quedar corta para esos cambios: anularlos antes o no volver atrás.)
--
-- Aplicar en el SQL Editor de Supabase. No toca tablas ni datos.
-- ============================================================================

DROP FUNCTION IF EXISTS public.register_exchange(uuid, jsonb, jsonb, text, text, boolean, integer, numeric, numeric);

CREATE OR REPLACE FUNCTION public.register_exchange(
  p_source_sale_id      uuid,
  p_returns             jsonb,    -- [{"sale_item_id": uuid, "quantity": int}]
  p_new_items           jsonb,    -- [{"product_id": uuid, "quantity": int}]
  p_payment_method      text,     -- efectivo|zelle|pago_movil|punto_de_venta (ignorado si total = 0)
  p_payment_ref         text,
  p_apply_pdv_surcharge boolean,
  p_redeem_points       integer,  -- 0 = sin canje; múltiplo de points_per_block
  p_expected_total      numeric,  -- lo que el cajero vio en pantalla
  p_bcv_rate            numeric,
  p_discount_usd        numeric DEFAULT 0  -- descuento manual sobre la diferencia, en USD (0 = sin descuento)
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
  v_sum_credit      numeric;
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
  v_discount        numeric := 0;
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

  -- Un cambio de producto mueve stock, puntos y dinero. Antes bastaba con
  -- tener un perfil activo y la tienda correcta: el rol no se miraba. Con el
  -- rol 'consulta' (el telefono del piso de venta, que solo mira precios) eso
  -- deja de ser aceptable, porque podria registrar cambios llamando al RPC
  -- desde la consola del navegador. Ahora se exige caja o dueno.
  IF v_role NOT IN ('owner', 'cashier') THEN
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
  --    r = (total - recargo PDV + canje + crédito de sus líneas devueltas)
  --        / Σ subtotal de sus líneas positivas, acotado a [0, 1].
  --    Una venta normal no tiene líneas devueltas: es la fórmula de siempre,
  --    (total - recargo PDV + canje) / Σ subtotal.
  --    Si la venta no tiene líneas (existe una real así) r = 1.
  --    Para una fila 'exchange' sin descuento la fórmula da 1; con descuento da
  --    (nuevos - descuento) / nuevos: lo que el cliente puso por esos productos
  --    es lo que valía lo que devolvió más lo que pagó de diferencia.
  SELECT COALESCE(SUM(subtotal) FILTER (WHERE quantity > 0), 0),
         COALESCE(-SUM(subtotal) FILTER (WHERE quantity < 0), 0)
    INTO v_sum_subtotal, v_sum_credit
    FROM public.sale_items
   WHERE sale_id = v_sale.id;

  IF v_sum_subtotal <= 0 THEN
    v_ratio := 1;
  ELSE
    v_ratio := (v_sale.total_amount
                - COALESCE(v_sale.punto_de_venta_surcharge_usd, 0)
                + COALESCE(v_sale.redemption_discount_usd, 0)
                + v_sum_credit) / v_sum_subtotal;
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

  -- 5. Productos nuevos: deben existir y estar activos; precio EFECTIVO actual.
  FOR v_new IN
    SELECT x.product_id, SUM(x.quantity)::integer AS quantity
      FROM jsonb_to_recordset(p_new_items) AS x(product_id uuid, quantity integer)
     GROUP BY x.product_id
  LOOP
    IF v_new.quantity IS NULL OR v_new.quantity < 1 THEN
      RAISE EXCEPTION 'INVALID_QUANTITY';
    END IF;

    -- Precio EFECTIVO (con la oferta vigente aplicada), no el de lista: es
    -- exactamente el mismo numero que la vista v_products_priced le mostro al
    -- cajero, por eso p_expected_total cuadra y no salta TOTAL_MISMATCH.
    SELECT public.effective_product_price(id), is_active INTO v_price, v_is_active
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

  -- 6b. Descuento manual sobre la diferencia (opcional). Llega como monto en
  --     USD; nunca negativo ni mayor que la diferencia. De acá en adelante
  --     v_diff es la diferencia YA con el descuento, así que el canje de
  --     puntos y el recargo de Punto de Venta se calculan sobre lo que queda,
  --     igual que en el POS. No se guarda en una columna: queda implícito en
  --     total_amount, como el descuento manual de una venta.
  v_discount := ROUND(COALESCE(p_discount_usd, 0), 2);
  IF v_discount < 0 OR v_discount > v_diff THEN
    RAISE EXCEPTION 'INVALID_DISCOUNT';
  END IF;
  v_diff := ROUND(v_diff - v_discount, 2);

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

  -- Líneas nuevas (cantidad positiva, precio efectivo con oferta).
  FOR v_new IN
    SELECT x.product_id, SUM(x.quantity)::integer AS quantity
      FROM jsonb_to_recordset(p_new_items) AS x(product_id uuid, quantity integer)
     GROUP BY x.product_id
  LOOP
    SELECT public.effective_product_price(id) INTO v_price FROM public.products WHERE id = v_new.product_id;

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

GRANT EXECUTE ON FUNCTION public.register_exchange(uuid, jsonb, jsonb, text, text, boolean, integer, numeric, numeric, numeric) TO authenticated;

-- PostgREST guarda las firmas en caché: que la recargue ya.
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- VERIFICACIÓN. Tiene que devolver:
--   versiones_de_la_funcion      = 1   (2 = quedaron las dos firmas vivas)
--   parametros                   = 10
--   valida_descuento             = true
--   exige_caja_o_dueno           = true
--   usa_precio_efectivo          = 2
--   ventas_que_cambian_de_credito = 0  (la fórmula nueva del paso 3 da el
--                                       mismo resultado que la vieja en todas
--                                       las ventas y cambios que ya existen;
--                                       si el archivo se vuelve a correr más
--                                       adelante, acá aparecen los cambios con
--                                       descuento: es lo esperado)
-- ============================================================================
SELECT jsonb_pretty(jsonb_build_object(
  'versiones_de_la_funcion', (
    SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'register_exchange'
  ),
  'parametros', (
    SELECT MAX(p.pronargs) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'register_exchange'
  ),
  'valida_descuento', (
    SELECT bool_and(p.prosrc LIKE '%INVALID_DISCOUNT%')
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'register_exchange'
  ),
  'exige_caja_o_dueno', (
    SELECT bool_and(p.prosrc LIKE '%NOT IN (''owner'', ''cashier'')%')
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'register_exchange'
  ),
  'usa_precio_efectivo', (
    SELECT MAX((length(p.prosrc) - length(replace(p.prosrc, 'effective_product_price', ''))) / length('effective_product_price'))
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'register_exchange'
  ),
  'ventas_que_cambian_de_credito', (
    SELECT COUNT(*)
      FROM (
        SELECT s.id,
               s.total_amount
                 - COALESCE(s.punto_de_venta_surcharge_usd, 0)
                 + COALESCE(s.redemption_discount_usd, 0)                 AS pagado,
               COALESCE(SUM(i.subtotal), 0)                               AS sum_todas,
               COALESCE(SUM(i.subtotal) FILTER (WHERE i.quantity > 0), 0) AS sum_positivas,
               COALESCE(-SUM(i.subtotal) FILTER (WHERE i.quantity < 0), 0) AS sum_credito
          FROM public.sales s
          LEFT JOIN public.sale_items i ON i.sale_id = s.id
         GROUP BY s.id
      ) t
     WHERE ROUND(CASE WHEN t.sum_todas <= 0 THEN 1
                      ELSE LEAST(1, GREATEST(0, t.pagado / t.sum_todas)) END, 6)
        <> ROUND(CASE WHEN t.sum_positivas <= 0 THEN 1
                      ELSE LEAST(1, GREATEST(0, (t.pagado + t.sum_credito) / t.sum_positivas)) END, 6)
  )
));
