-- ============================================================================
-- Inicial de Cashea con su método de pago.
--
-- POR QUÉ (pedido de Gerardo, 11-nov-2026, docs/propuesta-inicial-cashea.pdf):
--   La caja guarda CUÁNTO se pagó de inicial (sales.cashea_initial_usd) pero
--   no CÓMO: las cajeras lo escribían a mano en «Referencia». Ahora la caja
--   pregunta «¿Cómo pagó la inicial?» con los métodos de siempre y Reportes
--   la suma en ese método del desglose (Pago Móvil, Punto de Venta…).
--   La inicial se puede dividir en dos métodos (p. ej. $20 Pago Móvil + $8
--   Efectivo), igual que el pago dividido de la venta.
--
-- QUÉ AGREGA (3 columnas en public.sales, todas NULL en las ventas viejas):
--   cashea_initial_method    método de la inicial (o el 1º si se dividió)
--   cashea_initial_method_2  2º método, solo si se dividió
--   cashea_initial_amount_2  monto en USD del 2º método
--     Monto del 1º método = cashea_initial_usd - COALESCE(cashea_initial_amount_2, 0)
--
-- Un CHECK que se cumple con NULL (así las ventas viejas y cualquier UPDATE
-- sobre ellas siguen funcionando): solo los 4 métodos de la caja, el 2º
-- método va con su monto, es distinto del 1º y 0 < monto 2 < inicial.
-- «Si hay inicial, hay método» lo exige la caja, NO la base: en la base
-- rompería los UPDATE sobre las ventas de antes (no tienen método).
--
-- Mismo tipo que payment_method (public.payment_method_type). El enum también
-- tiene 'cashea' y 'cambio': el CHECK los deja fuera.
--
-- No toca políticas, funciones ni datos. El POS, Reportes y Finanzas
-- degradan si estas columnas todavía no existen (reintentan sin ellas).
--
-- CÓMO APLICARLO: respaldo primero (node scripts/backup-db.mjs). Después el
-- archivo ENTERO en el SQL Editor de Supabase, con las tiendas cerradas y
-- las pestañas Advisors y Table Editor cerradas (ALTER TABLE pide un candado
-- exclusivo sobre sales; con lock_timeout se rinde en vez de trabar la caja).
-- ============================================================================

SET lock_timeout = '5s';

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS cashea_initial_method   public.payment_method_type,
  ADD COLUMN IF NOT EXISTS cashea_initial_method_2 public.payment_method_type,
  ADD COLUMN IF NOT EXISTS cashea_initial_amount_2 numeric;

ALTER TABLE public.sales DROP CONSTRAINT IF EXISTS sales_cashea_initial_method_check;
ALTER TABLE public.sales ADD CONSTRAINT sales_cashea_initial_method_check CHECK (
  (cashea_initial_method IS NULL
    OR cashea_initial_method::text IN ('efectivo', 'punto_de_venta', 'zelle', 'pago_movil'))
  AND (cashea_initial_method_2 IS NULL
    OR (cashea_initial_method_2::text IN ('efectivo', 'punto_de_venta', 'zelle', 'pago_movil')
        AND cashea_initial_method IS NOT NULL
        AND cashea_initial_method_2 <> cashea_initial_method))
  AND ((cashea_initial_method_2 IS NULL) = (cashea_initial_amount_2 IS NULL))
  AND (cashea_initial_amount_2 IS NULL
    OR (cashea_initial_amount_2 > 0 AND cashea_initial_amount_2 < cashea_initial_usd))
);

NOTIFY pgrst, 'reload schema';

-- ----------------------------------------------------------------------------
-- Verificación. Esperado: columnas = 3, check = true, ventas_con_metodo = 0,
-- y total_ventas igual (o mayor, si se vendió algo después) a las 1374 del
-- respaldo backups/2026-11-12T01-21-26.
-- ----------------------------------------------------------------------------
SELECT
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales'
      AND column_name IN ('cashea_initial_method', 'cashea_initial_method_2', 'cashea_initial_amount_2')) AS columnas,
  EXISTS (SELECT 1 FROM pg_constraint
           WHERE conrelid = 'public.sales'::regclass
             AND conname = 'sales_cashea_initial_method_check')                                         AS "check",
  (SELECT COUNT(*) FROM public.sales WHERE cashea_initial_method IS NOT NULL)                            AS ventas_con_metodo,
  (SELECT COUNT(*) FROM public.sales)                                                                    AS total_ventas;
