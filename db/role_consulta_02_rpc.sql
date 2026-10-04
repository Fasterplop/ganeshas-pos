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
-- ni datos.
--
-- HOY ESTE ARCHIVO DEFINE DOS: redeem_points_global y mark_label_printed.
-- register_exchange se mudó a db/exchange_03_discount.sql (conserva el mismo
-- chequeo de rol). Las versiones anteriores de las tres, sin el chequeo, ya no
-- están en db/: quedaron en el historial de git.
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
--    register_exchange NO se define aca. Su unica definicion esta en
--    db/exchange_03_discount.sql, que conserva este mismo chequeo de rol
--    (la verificacion de abajo lo sigue comprobando).
-- ----------------------------------------------------------------------------

-- ============================================================================
-- VERIFICACION: las tres funciones deben mencionar el chequeo de rol.
-- Debe devolver true en las tres.
-- ============================================================================
SELECT jsonb_pretty(jsonb_object_agg(p.proname, p.prosrc LIKE '%NOT IN (''owner'', ''cashier'')%'))
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('redeem_points_global', 'mark_label_printed', 'register_exchange');
