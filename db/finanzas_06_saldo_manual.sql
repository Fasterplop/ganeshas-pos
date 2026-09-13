-- ============================================================================
-- MODULO DE FINANZAS - el saldo de las cuentas es 100% manual.
--
-- Por que: el dueno lleva el saldo de sus cuentas y tarjetas a mano. No quiere
-- que ningun registro lo mueva solo: ni los gastos (db/finanzas_05), ni los
-- fletes de las cajas, ni las compras a proveedores. El saldo cambia
-- UNICAMENTE con el saldo inicial y con los abonos y cargos que el mismo
-- registra en Cuentas (fin_account_movements).
--
-- Reemplaza a una version anterior de este mismo 06 que solo sacaba los fletes
-- y dejaba las compras moviendo el saldo. Esa version nunca se aplico.
--
-- Que hace: rehace fin_v_account_balance para que el saldo sea
--   tarjeta de credito: saldo_inicial + cargos - abonos   (es la DEUDA)
--   banco/zelle/efectivo: saldo_inicial + abonos - cargos (es lo disponible)
-- Los pagos (fin_payments) ya NO entran en ese calculo.
--
-- Que NO cambia:
--   - Los pagos se siguen registrando con su cuenta, y siguen marcando cada
--     compra, gasto o flete como pagado, parcial o pendiente.
--   - La deuda con cada proveedor y el calendario de pagos no dependen del
--     saldo de las cuentas: siguen exactamente igual.
--   - No se borra ningun dato.
--
-- moved_usd se conserva, pero pasa a ser INFORMATIVO: cuanto se ha pagado con
-- esa cuenta, de cualquier tipo. No entra en el saldo. Queda con el mismo
-- nombre y en la misma posicion para que la vista tenga exactamente las mismas
-- columnas que antes: asi, si esta migracion se corre antes de desplegar la
-- app nueva, la que esta en produccion no se rompe.
--
-- OJO con lo ya cargado: si una cuenta tenia compras o fletes pagados, su
-- saldo mostrado cambia en ese monto (en una cuenta SUBE; en una tarjeta la
-- deuda BAJA), porque ya no se descuenta solo. La verificacion del final lista
-- exactamente que cuentas cambian y cuanto. Si el saldo no coincide con el
-- real, se corrige con un abono o un cargo desde Cuentas.
--
-- Va con DROP antes del CREATE (leccion del 42P16 del 05).
-- Es idempotente. Aplicar en el SQL Editor de Supabase.
-- db/finanzas_01_schema.sql ya quedo actualizado: una instalacion NUEVA solo
-- necesita el 01 y el 02.
-- ============================================================================

DROP VIEW IF EXISTS public.fin_v_account_balance;

-- security_invoker = on es OBLIGATORIO: sin eso la vista corre con los
-- permisos de quien la creo y se salta la RLS de las tablas base.
CREATE VIEW public.fin_v_account_balance
WITH (security_invoker = on) AS
WITH pagados AS (
  -- INFORMATIVO: cuanto se ha pagado con cada cuenta. No entra en el saldo.
  SELECT account_id, SUM(amount_usd) AS total
    FROM public.fin_payments
   GROUP BY account_id
), manuales AS (
  -- Lo UNICO que mueve el saldo, ademas del saldo inicial.
  SELECT account_id,
         COALESCE(SUM(amount_usd) FILTER (WHERE kind = 'abono'), 0) AS abonos,
         COALESCE(SUM(amount_usd) FILTER (WHERE kind = 'cargo'), 0) AS cargos
    FROM public.fin_account_movements
   GROUP BY account_id
), calculo AS (
  SELECT a.*,
         COALESCE(p.total, 0)  AS moved_usd,
         COALESCE(m.abonos, 0) AS abonos_usd,
         COALESCE(m.cargos, 0) AS cargos_usd,
         CASE WHEN a.kind = 'tarjeta_credito'
              -- El saldo de una tarjeta es la DEUDA: un abono la baja.
              THEN a.opening_balance_usd + COALESCE(m.cargos, 0) - COALESCE(m.abonos, 0)
              -- En una cuenta es lo disponible: un abono lo sube.
              ELSE a.opening_balance_usd + COALESCE(m.abonos, 0) - COALESCE(m.cargos, 0)
         END AS balance_usd
    FROM public.fin_accounts a
    LEFT JOIN pagados  p ON p.account_id = a.id
    LEFT JOIN manuales m ON m.account_id = a.id
)
SELECT id AS account_id,
       name,
       kind,
       bank_name,
       last4,
       is_personal,
       is_active,
       credit_limit_usd,
       statement_day,
       due_day,
       opening_balance_usd,
       moved_usd,
       abonos_usd,
       cargos_usd,
       balance_usd,
       CASE WHEN kind = 'tarjeta_credito' AND credit_limit_usd IS NOT NULL
            THEN credit_limit_usd - balance_usd
            ELSE NULL
       END AS available_usd
  FROM calculo;


-- ----------------------------------------------------------------------------
-- VERIFICACION.
--
-- `opciones_vista` debe incluir security_invoker. Si sale vacio, la vista se
-- estaria saltando la RLS: NO seguir usando la app y avisar.
--
-- `cuentas_que_cambian` lista las cuentas a las que antes de esta migracion
-- se les descontaban compras o fletes pagados (lo que hacia la vista del 05:
-- todo menos gastos), cuanto era, y el saldo que muestran ahora. Si sale [],
-- ningun saldo cambio.
-- ----------------------------------------------------------------------------
SELECT jsonb_pretty(jsonb_build_object(
  'opciones_vista', (
    SELECT COALESCE(array_to_string(c.reloptions, ','), '')
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'fin_v_account_balance'
  ),
  'cuentas_que_cambian', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'cuenta', x.name,
             'tipo', x.kind,
             'pagos_que_ya_no_descuentan', x.total,
             'saldo_ahora', x.balance_usd
           ) ORDER BY x.name), '[]'::jsonb)
      FROM (
        SELECT a.name, a.kind, SUM(p.amount_usd) AS total, b.balance_usd
          FROM public.fin_payments p
          JOIN public.fin_expenses e ON e.id = p.expense_id AND e.kind <> 'gasto'
          JOIN public.fin_accounts a ON a.id = p.account_id
          JOIN public.fin_v_account_balance b ON b.account_id = a.id
         GROUP BY a.name, a.kind, b.balance_usd
      ) x
  )
));
