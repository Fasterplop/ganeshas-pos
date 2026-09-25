-- ============================================================================
-- Rol 'consulta': cerrarle los RPC que hoy dejan pasar a cualquier usuario.
--
-- CONTEXTO. Esconder un ítem del menú no protege nada: la clave anónima viaja
-- en el JavaScript del POS, así que cualquiera con una sesión iniciada puede
-- llamar a los RPC desde la consola del navegador. Las pantallas del rol
-- 'consulta' se cierran en el front con guards de ruta, pero la puerta de
-- verdad es esta.
--
-- Tres funciones no miraban el rol, y por eso el rol nuevo habría podido
-- usarlas:
--
--   * redeem_points_global — no tenía NINGÚN control: cualquier usuario
--                            autenticado podía quemarle los puntos a cualquier
--                            cliente. Esto ya era así antes del rol nuevo.
--   * register_exchange    — solo exigía perfil activo y tienda coincidente.
--                            Mueve stock, puntos y dinero.
--   * mark_label_printed   — solo exigía estar autenticado. Es el más inocuo
--                            (sella una fecha), pero se cierra igual.
--
-- set_bcv_rate NO se toca a propósito: el rol 'consulta' SÍ puede cargar y
-- corregir la tasa del día, porque /consultar-precio es donde se pide.
--
-- CÓMO SE HIZO: los tres cuerpos se sacaron de sus archivos originales y solo
-- se les insertó el bloque de autorización. Todo lo demás es idéntico carácter
-- por carácter, para no reintroducir a mano la lógica de puntos ni la de
-- cambios de producto.
--
-- TODO ADITIVO: solo reemplaza funciones (CREATE OR REPLACE). No toca tablas
-- ni datos. Para volver atrás se vuelven a correr db/loyalty_v2.sql,
-- db/product_created_and_label_printed.sql y db/scanner_04_exchange_offers.sql.
--
-- Aplicar en el SQL Editor de Supabase DESPUÉS de db/role_consulta_01_enum.sql
-- (necesita que el valor 'consulta' ya exista y esté confirmado).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Canje de puntos: solo caja y dueño.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.redeem_points_global(
  p_document_id varchar,
  p_points      integer
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total     integer;
  v_remaining integer;
  v_role      text;
  v_active    boolean;
  r           RECORD;
BEGIN
  -- Antes esta funcion no miraba NADA: cualquier usuario autenticado podia
  -- quemarle los puntos a cualquier cliente llamandola desde la consola del
  -- navegador. Con el rol 'consulta' eso deja de ser tolerable.
  SELECT role::text, is_active INTO v_role, v_active
    FROM public.profiles WHERE id = auth.uid();

  IF v_role IS NULL OR COALESCE(v_active, true) = false
     OR v_role NOT IN ('owner', 'cashier') THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;

  IF p_points IS NULL OR p_points <= 0 THEN
    RAISE EXCEPTION 'INVALID_POINTS';
  END IF;

  -- Bloquea todas las filas del cliente (no se puede FOR UPDATE con agregados).
  PERFORM 1 FROM public.customers
   WHERE document_id = p_document_id
   FOR UPDATE;

  -- Suma el saldo global ya bloqueado.
  SELECT COALESCE(SUM(reward_points), 0) INTO v_total
    FROM public.customers
   WHERE document_id = p_document_id;

  IF v_total < p_points THEN
    RAISE EXCEPTION 'INSUFFICIENT_POINTS';
  END IF;

  -- Descuenta secuencialmente (mayor saldo primero) hasta cubrir el canje.
  v_remaining := p_points;
  FOR r IN
    SELECT store_id, reward_points
      FROM public.customers
     WHERE document_id = p_document_id
       AND reward_points > 0
     ORDER BY reward_points DESC
  LOOP
    EXIT WHEN v_remaining <= 0;
    IF r.reward_points >= v_remaining THEN
      UPDATE public.customers
         SET reward_points = reward_points - v_remaining
       WHERE document_id = p_document_id AND store_id = r.store_id;
      v_remaining := 0;
    ELSE
      UPDATE public.customers
         SET reward_points = 0
       WHERE document_id = p_document_id AND store_id = r.store_id;
      v_remaining := v_remaining - r.reward_points;
    END IF;
  END LOOP;

  RETURN v_total - p_points;  -- saldo global restante
END;
$$;

GRANT EXECUTE ON FUNCTION public.redeem_points_global(varchar, integer) TO authenticated;

-- ----------------------------------------------------------------------------
-- 2. Sellar la primera impresion de etiqueta: solo caja y dueno.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_label_printed(p_product_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
BEGIN
  -- Antes bastaba con estar autenticado. Es el mas inocuo de los tres (solo
  -- sella una fecha), pero el rol 'consulta' no imprime etiquetas.
  SELECT role::text INTO v_role FROM public.profiles WHERE id = auth.uid();

  IF v_role IS NULL OR v_role NOT IN ('owner', 'cashier') THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;

  UPDATE public.products
     SET label_printed_at = now()
   WHERE id = p_product_id
     AND label_printed_at IS NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_label_printed(uuid) TO authenticated;

-- ----------------------------------------------------------------------------
-- 3. Cambio de producto: solo caja y dueno.
--    Cuerpo identico al de db/scanner_04_exchange_offers.sql salvo el bloque
--    de autorizacion que se agrega despues del chequeo de perfil activo.
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

GRANT EXECUTE ON FUNCTION public.register_exchange(uuid, jsonb, jsonb, text, text, boolean, integer, numeric, numeric) TO authenticated;

-- ============================================================================
-- VERIFICACION: las tres funciones deben mencionar el chequeo de rol.
-- Debe devolver true en las tres.
-- ============================================================================
SELECT jsonb_pretty(jsonb_object_agg(p.proname, p.prosrc LIKE '%NOT IN (''owner'', ''cashier'')%'))
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('redeem_points_global', 'mark_label_printed', 'register_exchange');
