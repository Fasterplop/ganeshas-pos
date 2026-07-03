-- ============================================================================
-- Fase 2.1 — Puntos UNIFICADOS entre sucursales + registro del descuento
-- Aplicar en Supabase (SQL Editor). Todo aditivo, no borra nada.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Registrar el descuento por puntos aplicado en cada venta (para el historial).
--    Aditivo: las ventas existentes quedan en 0.
-- ----------------------------------------------------------------------------
ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS redemption_discount_usd numeric NOT NULL DEFAULT 0;


-- ----------------------------------------------------------------------------
-- 2. Saldo de puntos UNIFICADO (suma de TODAS las sucursales de un mismo cliente).
--    SECURITY DEFINER: los puntos ahora son un pool global, por lo que la lectura
--    debe cruzar las filas de todas las tiendas (más allá del store del cajero).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_global_points(p_document_id varchar)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count  integer;
  v_points integer;
  v_name   text;
BEGIN
  SELECT COUNT(*), COALESCE(SUM(reward_points), 0), MAX(full_name)
    INTO v_count, v_points, v_name
    FROM public.customers
   WHERE document_id = p_document_id;

  IF v_count = 0 THEN
    RETURN NULL;  -- el cliente no existe en ninguna sucursal
  END IF;

  RETURN jsonb_build_object('full_name', v_name, 'points', v_points);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_global_points(varchar) TO authenticated;


-- ----------------------------------------------------------------------------
-- 3. Canje de puntos sobre el POOL UNIFICADO (descuenta de todas las sucursales).
--    - Bloquea las filas del cliente (FOR UPDATE) para resolver carreras.
--    - Nunca deja ninguna fila negativa.
--    - Aborta (INSUFFICIENT_POINTS) si el saldo GLOBAL no alcanza.
--    - SECURITY DEFINER: necesita descontar de filas de otras sucursales, cosa
--      que la RLS por-tienda del cajero no permitiría directamente.
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
  r           RECORD;
BEGIN
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
