-- ============================================================================
-- Ofertas: % de descuento con fecha de fin, guardado en el sistema.
--
-- POR QUÉ: hasta hoy el descuento se escribía al imprimir el lote de etiquetas
-- y moría en el papel (el precio anterior tachado y el nuevo). Con la etiqueta
-- sin precio esa información ya no tiene dónde vivir, así que pasa a la base:
-- el teléfono la muestra y la caja la cobra sola. Si el empleado y la caja
-- leyeran el descuento de fuentes distintas, tarde o temprano se separan.
--
-- ALCANCE de una oferta: un producto, un modelo con todas sus tallas (grupo de
-- variantes) o una categoría completa, opcionalmente acotada a una tienda.
--
-- PRECEDENCIA: producto > modelo > categoría. Si dos ofertas empatan en el
-- mismo nivel, gana el PORCENTAJE MÁS ALTO (determinista, y a favor del
-- cliente); si también empata el porcentaje, la más reciente.
--
-- LA FECHA SE CALCULA EN 'America/Caracas', NUNCA con current_date. La base
-- corre en UTC: una oferta que vence "hoy" se apagaría a las 8 de la noche
-- hora local, con la tienda abierta y el cliente en caja.
--
-- EL PRECIO CON OFERTA LO CALCULA SIEMPRE EL SQL, nunca el navegador: la vista
-- v_products_priced y la función effective_product_price usan la misma
-- expresión, así que lo que ve el teléfono, lo que cobra la caja y lo que
-- valida register_exchange son el mismo número por construcción.
--
-- TODO ADITIVO: una tabla nueva, una vista nueva y una función nueva. No toca
-- products.price ni ninguna venta. Desactivar todas las ofertas devuelve el
-- sistema exactamente al comportamiento anterior.
--
-- LO QUE NO SE VE AFECTADO: bulk_update_prices sigue operando sobre
-- products.price y, como la oferta es un porcentaje, se recalcula sola sobre
-- el precio nuevo; revert_price_adjustment compara products.price y tampoco
-- cambia; los puntos siguen siendo FLOOR(total) sobre el neto cobrado.
--
-- Aplicar en el SQL Editor de Supabase DESPUÉS de scanner_01 y scanner_02, y
-- ANTES de scanner_04 (que actualiza register_exchange y necesita la función
-- de precio efectivo que se crea acá).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Tabla de ofertas.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.product_offers (
  id         uuid NOT NULL DEFAULT uuid_generate_v4(),
  scope      text NOT NULL CHECK (scope = ANY (ARRAY['product'::text, 'group'::text, 'category'::text])),
  product_id uuid,
  group_id   uuid,
  category   public.product_category_v2,
  store_id   uuid,
  percent    numeric NOT NULL CHECK (percent > 0 AND percent < 100),
  starts_at  date NOT NULL DEFAULT (now() AT TIME ZONE 'America/Caracas')::date,
  ends_at    date,
  is_active  boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_offers_pkey PRIMARY KEY (id),
  CONSTRAINT product_offers_product_fkey FOREIGN KEY (product_id) REFERENCES public.products(id),
  CONSTRAINT product_offers_group_fkey   FOREIGN KEY (group_id)   REFERENCES public.product_groups(id),
  CONSTRAINT product_offers_store_fkey   FOREIGN KEY (store_id)   REFERENCES public.stores(id),
  CONSTRAINT product_offers_author_fkey  FOREIGN KEY (created_by) REFERENCES public.profiles(id),
  -- El objetivo tiene que corresponder al alcance, y los otros dos en NULL.
  CONSTRAINT product_offers_target_check CHECK (
       (scope = 'product'  AND product_id IS NOT NULL AND group_id IS NULL AND category IS NULL)
    OR (scope = 'group'    AND group_id   IS NOT NULL AND product_id IS NULL AND category IS NULL)
    OR (scope = 'category' AND category   IS NOT NULL AND product_id IS NULL AND group_id IS NULL)
  ),
  CONSTRAINT product_offers_dates_check CHECK (ends_at IS NULL OR ends_at >= starts_at)
);

CREATE INDEX IF NOT EXISTS idx_product_offers_product  ON public.product_offers(product_id) WHERE product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_product_offers_group    ON public.product_offers(group_id)   WHERE group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_product_offers_category ON public.product_offers(category, store_id) WHERE category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_product_offers_vigencia ON public.product_offers(is_active, starts_at, ends_at);

-- ----------------------------------------------------------------------------
-- 2. Políticas ANTES del ENABLE (trampa de ensure_rls: una tabla con RLS y
--    cero políticas no queda abierta, queda muda y sin error).
--
--    Leer: cualquiera logueado. La caja y el teléfono LO NECESITAN para poder
--    mostrar y cobrar el precio con oferta.
--    Escribir: solo el owner, mismo criterio que el ajuste masivo de precios.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "product_offers_select_auth"  ON public.product_offers;
DROP POLICY IF EXISTS "product_offers_insert_owner" ON public.product_offers;
DROP POLICY IF EXISTS "product_offers_update_owner" ON public.product_offers;
DROP POLICY IF EXISTS "product_offers_delete_owner" ON public.product_offers;

CREATE POLICY "product_offers_select_auth" ON public.product_offers
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "product_offers_insert_owner" ON public.product_offers
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role::text = 'owner')
  );

CREATE POLICY "product_offers_update_owner" ON public.product_offers
  FOR UPDATE TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role::text = 'owner')
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role::text = 'owner')
  );

CREATE POLICY "product_offers_delete_owner" ON public.product_offers
  FOR DELETE TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role::text = 'owner')
  );

ALTER TABLE public.product_offers ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 3. Vista con el precio efectivo.
--
--    security_invoker = on es OBLIGATORIO: sin eso la vista corre con los
--    permisos de quien la creó y se salta la RLS de las tablas base.
--
--    Trae p.*, así que cualquier consulta que hoy hace .from("products")
--    puede pasar a .from("v_products_priced") sin perder columnas.
-- ----------------------------------------------------------------------------
DROP VIEW IF EXISTS public.v_products_priced;
CREATE VIEW public.v_products_priced
WITH (security_invoker = on) AS
SELECT
  p.*,
  o.id      AS offer_id,
  o.percent AS offer_percent,
  o.ends_at AS offer_ends_at,
  COALESCE(ROUND(p.price * (100 - o.percent) / 100.0, 2), p.price) AS effective_price
FROM public.products p
LEFT JOIN LATERAL (
  SELECT f.id, f.percent, f.ends_at
    FROM public.product_offers f
   WHERE f.is_active
     AND (now() AT TIME ZONE 'America/Caracas')::date >= f.starts_at
     AND (now() AT TIME ZONE 'America/Caracas')::date <= COALESCE(f.ends_at, 'infinity'::date)
     AND (f.store_id IS NULL OR f.store_id = p.owner_store_id)
     AND (
          (f.scope = 'product'  AND f.product_id = p.id)
       OR (f.scope = 'group'    AND p.parent_group_id IS NOT NULL AND f.group_id = p.parent_group_id)
       OR (f.scope = 'category' AND f.category = p.category)
     )
   -- Precedencia: producto > modelo > categoría; luego el % más alto; luego la más reciente.
   ORDER BY CASE f.scope WHEN 'product' THEN 0 WHEN 'group' THEN 1 ELSE 2 END,
            f.percent DESC,
            f.created_at DESC
   LIMIT 1
) o ON true;

GRANT SELECT ON public.v_products_priced TO authenticated;

-- ----------------------------------------------------------------------------
-- 4. Misma cuenta, para un solo producto, usable desde otros RPC.
--    SECURITY DEFINER porque la llama register_exchange, que ya lo es.
--    LA EXPRESIÓN ES IDÉNTICA A LA DE LA VISTA: si se cambia una, se cambia
--    la otra, o el cliente y el servidor empiezan a calcular distinto y
--    register_exchange rechazará cambios legítimos con TOTAL_MISMATCH.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.effective_product_price(p_product_id uuid)
RETURNS numeric
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(ROUND(p.price * (100 - o.percent) / 100.0, 2), p.price)
    FROM public.products p
    LEFT JOIN LATERAL (
      SELECT f.percent
        FROM public.product_offers f
       WHERE f.is_active
         AND (now() AT TIME ZONE 'America/Caracas')::date >= f.starts_at
         AND (now() AT TIME ZONE 'America/Caracas')::date <= COALESCE(f.ends_at, 'infinity'::date)
         AND (f.store_id IS NULL OR f.store_id = p.owner_store_id)
         AND (
              (f.scope = 'product'  AND f.product_id = p.id)
           OR (f.scope = 'group'    AND p.parent_group_id IS NOT NULL AND f.group_id = p.parent_group_id)
           OR (f.scope = 'category' AND f.category = p.category)
         )
       ORDER BY CASE f.scope WHEN 'product' THEN 0 WHEN 'group' THEN 1 ELSE 2 END,
                f.percent DESC,
                f.created_at DESC
       LIMIT 1
    ) o ON true
   WHERE p.id = p_product_id;
$$;

GRANT EXECUTE ON FUNCTION public.effective_product_price(uuid) TO authenticated;

-- ============================================================================
-- PROBAR DESPUÉS DE ESTE BLOQUE, antes de seguir con scanner_04:
--
--   -- sin ofertas cargadas, effective_price debe ser IGUAL a price en todo:
--   SELECT count(*) AS descuadres
--     FROM public.v_products_priced
--    WHERE effective_price <> price;         -- debe dar 0
--
--   -- y la función debe coincidir con la vista producto por producto:
--   SELECT count(*) AS descuadres
--     FROM public.v_products_priced v
--    WHERE v.effective_price <> public.effective_product_price(v.id);  -- 0
-- ============================================================================

-- ============================================================================
-- VERIFICACIÓN
-- ============================================================================
SELECT jsonb_pretty(jsonb_build_object(
  'tabla', (
    SELECT jsonb_build_object(
             'rls_activa', c.relrowsecurity,
             'politicas', (SELECT COUNT(*) FROM pg_policies p
                            WHERE p.schemaname = 'public' AND p.tablename = 'product_offers')
           )
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'product_offers'
  ),
  'vista_reloptions', (
    SELECT to_jsonb(c.reloptions)
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'v_products_priced'
  ),
  'funcion_precio', EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'effective_product_price'
  ),
  'productos_con_oferta_vigente', (
    SELECT COUNT(*) FROM public.v_products_priced WHERE offer_id IS NOT NULL
  ),
  'descuadres_vista_vs_funcion', (
    SELECT COUNT(*) FROM public.v_products_priced v
     WHERE v.effective_price <> public.effective_product_price(v.id)
  )
));
