-- ============================================================================
-- Ajuste MASIVO de precios por porcentaje, con DESHACER (solo el owner).
--
-- Por qué un RPC y no un update desde el cliente: el precio nuevo depende del
-- precio viejo de CADA fila (price * factor), y PostgREST no sabe expresar eso
-- en un solo update. Hacerlo fila por fila serían 1000+ peticiones HTTP (la
-- tienda ya pasó los 1000 productos) y, si el navegador se corta a la mitad,
-- media tienda queda con el precio nuevo y la otra media con el viejo.
-- Aquí es UNA sentencia, atómica: o cambian todos o no cambia ninguno.
--
-- Por qué se guarda el precio viejo de cada producto y no solo el porcentaje:
-- el redondeo PIERDE información. Con redondeo a $1, $141.60 → $142; deshacer
-- con el porcentaje inverso daría $129.09, no $141.60. La única forma de que
-- "Deshacer" devuelva exactamente lo que había es haber anotado cada precio.
--
-- Alcance: los productos ACTIVOS cuya tienda dueña es p_store_id. Los
-- inactivos son borrados lógicos y no se tocan.
--
-- Aplicar en el SQL Editor de Supabase. Es idempotente: si ya corriste una
-- versión anterior de este archivo, vuelve a correrlo entero (reemplaza la
-- función y agrega las tablas de historial que faltan).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1) Historial de ajustes: la cabecera (qué se hizo) y el detalle (qué precio
--    tenía cada producto antes). El detalle es lo que hace posible deshacer.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.price_adjustments (
  id             uuid NOT NULL DEFAULT uuid_generate_v4(),
  store_id       uuid NOT NULL,
  percent        numeric NOT NULL,
  round_to       numeric NOT NULL,
  products_count integer NOT NULL DEFAULT 0,
  created_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  reverted_at    timestamptz,
  reverted_by    uuid,
  CONSTRAINT price_adjustments_pkey PRIMARY KEY (id),
  CONSTRAINT price_adjustments_store_fkey FOREIGN KEY (store_id) REFERENCES public.stores(id),
  CONSTRAINT price_adjustments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id),
  CONSTRAINT price_adjustments_reverted_by_fkey FOREIGN KEY (reverted_by) REFERENCES public.profiles(id)
);

-- Un solo detalle para productos y para grupos de variantes: `kind` dice cuál.
CREATE TABLE IF NOT EXISTS public.price_adjustment_items (
  adjustment_id uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('product', 'group')),
  target_id     uuid NOT NULL,
  old_price     numeric NOT NULL,
  new_price     numeric NOT NULL,
  CONSTRAINT price_adjustment_items_pkey PRIMARY KEY (adjustment_id, kind, target_id),
  CONSTRAINT price_adjustment_items_adjustment_fkey
    FOREIGN KEY (adjustment_id) REFERENCES public.price_adjustments(id) ON DELETE CASCADE
);

-- "El último ajuste sin deshacer de esta tienda" es la consulta que hace la app
-- cada vez que abre el modal.
CREATE INDEX IF NOT EXISTS idx_price_adjustments_store_pending
  ON public.price_adjustments (store_id, created_at DESC)
  WHERE reverted_at IS NULL;

-- Estas dos tablas SÍ nacen con RLS: solo el owner las lee, y nadie las
-- escribe por la API (los dos RPC de abajo son SECURITY DEFINER y no pasan por
-- las políticas). No dependen de db/rls_01_activar.sql.
ALTER TABLE public.price_adjustments      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.price_adjustment_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS price_adjustments_select_owner ON public.price_adjustments;
CREATE POLICY price_adjustments_select_owner ON public.price_adjustments
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role::text = 'owner'
  ));

DROP POLICY IF EXISTS price_adjustment_items_select_owner ON public.price_adjustment_items;
CREATE POLICY price_adjustment_items_select_owner ON public.price_adjustment_items
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role::text = 'owner'
  ));


-- ----------------------------------------------------------------------------
-- 2) Aplicar el ajuste.
--    Devuelve jsonb: { "adjustment_id": uuid, "products": n }.
--    (La versión anterior devolvía integer; por eso el DROP.)
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.bulk_update_prices(uuid, numeric, numeric);

CREATE OR REPLACE FUNCTION public.bulk_update_prices(
  p_store_id uuid,
  p_percent  numeric,           -- +10 sube 10%, -10 baja 10%
  p_round_to numeric DEFAULT 1  -- 1 = precios sin decimales ($141.60 -> $142)
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   text;
  v_factor numeric;
  v_step   numeric;
  v_adj_id uuid;
  v_count  integer;
BEGIN
  -- Solo el owner. La comprobación va aquí dentro (no solo en el front) porque
  -- la clave anónima viaja en el navegador: cualquiera podría llamar al RPC.
  SELECT role::text INTO v_role FROM public.profiles WHERE id = auth.uid();
  IF v_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;

  IF p_store_id IS NULL THEN
    RAISE EXCEPTION 'STORE_REQUIRED';
  END IF;

  -- Tope de cordura: un dedazo (1000 en vez de 10) no puede multiplicar por 11
  -- el catálogo entero. -90% / +300% cubre cualquier ajuste real de tienda.
  IF p_percent IS NULL OR p_percent < -90 OR p_percent > 300 THEN
    RAISE EXCEPTION 'PERCENT_OUT_OF_RANGE';
  END IF;

  IF p_percent = 0 THEN
    RAISE EXCEPTION 'PERCENT_ZERO';
  END IF;

  v_factor := 1 + (p_percent / 100.0);
  v_step   := COALESCE(p_round_to, 1);
  IF v_step <= 0 THEN v_step := 0.01; END IF;

  INSERT INTO public.price_adjustments (store_id, percent, round_to, created_by)
  VALUES (p_store_id, p_percent, v_step, auth.uid())
  RETURNING id INTO v_adj_id;

  -- Un solo statement: leer el precio viejo, escribir el nuevo y anotar ambos.
  -- GREATEST(..., v_step): con una bajada fuerte, un producto barato no puede
  -- terminar en $0.00 (quedaría regalado en el POS).
  WITH antes AS (
    SELECT id, price AS old_price
      FROM public.products
     WHERE owner_store_id = p_store_id
       AND is_active = true
  ), cambio AS (
    UPDATE public.products p
       SET price = GREATEST(ROUND(a.old_price * v_factor / v_step) * v_step, v_step)
      FROM antes a
     WHERE p.id = a.id
    RETURNING p.id, a.old_price, p.price AS new_price
  )
  INSERT INTO public.price_adjustment_items (adjustment_id, kind, target_id, old_price, new_price)
  SELECT v_adj_id, 'product', id, old_price, new_price FROM cambio;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- El "producto padre" (grupo de variantes) guarda un precio de referencia:
  -- si no se mueve con sus hijas, queda desfasado y confunde al crear variantes.
  WITH antes AS (
    SELECT id, default_price AS old_price
      FROM public.product_groups
     WHERE owner_store_id = p_store_id
       AND is_active = true
  ), cambio AS (
    UPDATE public.product_groups g
       SET default_price = GREATEST(ROUND(a.old_price * v_factor / v_step) * v_step, v_step)
      FROM antes a
     WHERE g.id = a.id
    RETURNING g.id, a.old_price, g.default_price AS new_price
  )
  INSERT INTO public.price_adjustment_items (adjustment_id, kind, target_id, old_price, new_price)
  SELECT v_adj_id, 'group', id, old_price, new_price FROM cambio;

  UPDATE public.price_adjustments SET products_count = v_count WHERE id = v_adj_id;

  RETURN jsonb_build_object('adjustment_id', v_adj_id, 'products', v_count);
END;
$$;

GRANT EXECUTE ON FUNCTION public.bulk_update_prices(uuid, numeric, numeric) TO authenticated;


-- ----------------------------------------------------------------------------
-- 3) Deshacer un ajuste: devuelve a cada producto el precio EXACTO que tenía.
--    Devuelve jsonb: { "restored": n, "skipped": n }.
--
--    Dos reglas de seguridad:
--      - Solo se puede deshacer el ÚLTIMO ajuste pendiente de esa tienda. Si no,
--        deshacer uno viejo pisaría los ajustes posteriores.
--      - Solo se restaura el producto cuyo precio SIGUE siendo el que dejó el
--        ajuste. Si el owner le cambió el precio a mano después, ese cambio
--        manual se respeta y el producto se cuenta en "skipped".
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revert_price_adjustment(
  p_adjustment_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role     text;
  v_adj      public.price_adjustments%ROWTYPE;
  v_restored integer;
  v_total    integer;
BEGIN
  SELECT role::text INTO v_role FROM public.profiles WHERE id = auth.uid();
  IF v_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;

  SELECT * INTO v_adj FROM public.price_adjustments WHERE id = p_adjustment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ADJUSTMENT_NOT_FOUND';
  END IF;
  IF v_adj.reverted_at IS NOT NULL THEN
    RAISE EXCEPTION 'ALREADY_REVERTED';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.price_adjustments
     WHERE store_id = v_adj.store_id
       AND reverted_at IS NULL
       AND created_at > v_adj.created_at
  ) THEN
    RAISE EXCEPTION 'NOT_LATEST';
  END IF;

  WITH it AS (
    SELECT target_id, old_price, new_price
      FROM public.price_adjustment_items
     WHERE adjustment_id = p_adjustment_id AND kind = 'product'
  ), vuelta AS (
    UPDATE public.products p
       SET price = it.old_price
      FROM it
     WHERE p.id = it.target_id
       AND p.price = it.new_price   -- nadie lo tocó a mano después
    RETURNING p.id
  )
  SELECT COUNT(*) INTO v_restored FROM vuelta;

  WITH it AS (
    SELECT target_id, old_price, new_price
      FROM public.price_adjustment_items
     WHERE adjustment_id = p_adjustment_id AND kind = 'group'
  )
  UPDATE public.product_groups g
     SET default_price = it.old_price
    FROM it
   WHERE g.id = it.target_id
     AND g.default_price = it.new_price;

  SELECT COUNT(*) INTO v_total
    FROM public.price_adjustment_items
   WHERE adjustment_id = p_adjustment_id AND kind = 'product';

  UPDATE public.price_adjustments
     SET reverted_at = now(), reverted_by = auth.uid()
   WHERE id = p_adjustment_id;

  RETURN jsonb_build_object('restored', v_restored, 'skipped', v_total - v_restored);
END;
$$;

GRANT EXECUTE ON FUNCTION public.revert_price_adjustment(uuid) TO authenticated;
