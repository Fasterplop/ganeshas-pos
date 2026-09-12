-- ============================================================================
-- MODULO DE FINANZAS - quitar la sucursal: el modulo pasa a ser DEL NEGOCIO.
--
-- Por que: el dueno quiere ver las mismas finanzas este parado en la tienda que
-- este. Un filtro por sucursal ahi no ayuda, estorba: la Amex paga para
-- cualquier tienda, LC Lizette le vende al negocio y una caja que viene en
-- camino es la misma caja desde donde se mire. Los maestros (proveedores,
-- cuentas, categorias) ya eran globales; esto alinea el resto.
--
-- Que hace: quita `store_id` de fin_expenses, fin_shipments y fin_budgets, y
-- rehace los indices, la clave unica y la vista que dependian de esa columna.
--
-- Que se pierde: la etiqueta de sucursal de las compras, cajas y presupuestos
-- ya cargados. Nada mas: ningun monto, ninguna fecha, ningun enlace. El gasto,
-- los abonos y el contenido de las cajas quedan intactos.
--
-- Que NO toca: ni una sola tabla del POS.
--
-- IMPORTANTE: db/finanzas_01_schema.sql ya quedo actualizado a este diseno, asi
-- que una instalacion NUEVA solo necesita el 01. Este archivo es unicamente
-- para la base que ya corrio la version anterior.
--
-- Es idempotente. Aplicar en el SQL Editor de Supabase.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1) Lo que depende de store_id, fuera primero.
--
-- La vista se borra explicitamente en vez de dejar que caiga con un CASCADE:
-- asi queda a la vista que se esta rehaciendo, y no se lleva por delante nada
-- que no estemos mirando.
-- ----------------------------------------------------------------------------
DROP VIEW  IF EXISTS public.fin_v_budget_vs_actual;

DROP INDEX IF EXISTS public.idx_fin_shipments_number_uniq;
DROP INDEX IF EXISTS public.idx_fin_shipments_incoming;
DROP INDEX IF EXISTS public.idx_fin_expenses_store_date;
DROP INDEX IF EXISTS public.idx_fin_budgets_lookup;

ALTER TABLE public.fin_budgets DROP CONSTRAINT IF EXISTS fin_budgets_uniq;


-- ----------------------------------------------------------------------------
-- 2) Quitar la columna. Los FK hacia stores(id) se van con ella.
-- ----------------------------------------------------------------------------
ALTER TABLE public.fin_expenses  DROP COLUMN IF EXISTS store_id;
ALTER TABLE public.fin_shipments DROP COLUMN IF EXISTS store_id;
ALTER TABLE public.fin_budgets   DROP COLUMN IF EXISTS store_id;


-- ----------------------------------------------------------------------------
-- 3) Rehacer indices y clave unica, ahora a nivel de negocio.
--
-- El numero de caja pasa a ser unico en TODO el negocio. Es lo correcto ahora:
-- si dos sucursales pudieran tener cada una su "Caja 14", al verlas juntas no
-- habria forma de distinguirlas.
-- ----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_fin_shipments_number_uniq
  ON public.fin_shipments (lower(box_number));

CREATE INDEX IF NOT EXISTS idx_fin_shipments_incoming
  ON public.fin_shipments (eta_date)
  WHERE status IN ('enviada','en_transito');

CREATE INDEX IF NOT EXISTS idx_fin_expenses_date
  ON public.fin_expenses (expense_date DESC);

CREATE INDEX IF NOT EXISTS idx_fin_budgets_lookup
  ON public.fin_budgets (period_month);

-- Un presupuesto por categoria y mes para todo el negocio.
DO $uniq$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fin_budgets_uniq') THEN
    ALTER TABLE public.fin_budgets
      ADD CONSTRAINT fin_budgets_uniq UNIQUE (category_id, period_month);
  END IF;
END
$uniq$;


-- ----------------------------------------------------------------------------
-- 4) La vista de presupuesto, sin sucursal.
--
-- security_invoker = on sigue siendo obligatorio: sin eso la vista corre con
-- los permisos de quien la creo y se salta la RLS de las tablas base.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.fin_v_budget_vs_actual
WITH (security_invoker = on) AS
SELECT b.category_id,
       c.name                                   AS category_name,
       b.period_month,
       b.amount_usd                             AS budget_usd,
       COALESCE(g.spent_usd, 0)                 AS spent_usd,
       b.amount_usd - COALESCE(g.spent_usd, 0)  AS remaining_usd,
       CASE WHEN b.amount_usd > 0
            THEN ROUND(COALESCE(g.spent_usd, 0) / b.amount_usd * 100, 1)
            ELSE NULL
       END                                      AS pct_used
  FROM public.fin_budgets b
  JOIN public.fin_categories c ON c.id = b.category_id
  LEFT JOIN LATERAL (
    SELECT SUM(e.amount_usd) AS spent_usd
      FROM public.fin_expenses e
     WHERE e.category_id = b.category_id
       AND e.is_personal = false
       AND date_trunc('month', e.expense_date)::date = b.period_month
  ) g ON true;


-- ----------------------------------------------------------------------------
-- VERIFICACION. store_id debe salir en 0 tablas, y las 9 tablas fin_* deben
-- conservar su RLS y sus 4 politicas (quitar una columna no las toca, pero mas
-- vale mirarlo).
--
-- PROBAR DESPUES: /finanzas como owner. Las cajas y las compras cargadas deben
-- seguir ahi, con sus montos y su contenido, y ya sin selector de tienda.
-- ----------------------------------------------------------------------------
SELECT jsonb_pretty(jsonb_build_object(
  'tablas_con_store_id', (
    SELECT COALESCE(jsonb_agg(table_name ORDER BY table_name), '[]'::jsonb)
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND column_name  = 'store_id'
       AND table_name LIKE 'fin\_%'
  ),
  'rls', (
    SELECT jsonb_agg(t ORDER BY t->>'tabla')
      FROM (
        SELECT jsonb_build_object(
                 'tabla',      c.relname,
                 'rls_activa', c.relrowsecurity,
                 'politicas',  (SELECT COUNT(*) FROM pg_policies p
                                 WHERE p.schemaname = 'public' AND p.tablename = c.relname)
               ) AS t
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'fin\_%'
      ) s
  ),
  'vistas', (
    SELECT COALESCE(jsonb_agg(viewname ORDER BY viewname), '[]'::jsonb)
      FROM pg_views WHERE schemaname = 'public' AND viewname LIKE 'fin\_v\_%'
  )
));
