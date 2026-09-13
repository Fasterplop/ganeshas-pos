-- ============================================================================
-- MODULO DE FINANZAS - los fletes de las cajas tampoco mueven el saldo.
--
-- Por que: el dueno pidio que los gastos operativos no restaran del saldo de
-- la cuenta (db/finanzas_05_suscripciones_y_abonos.sql). La vista quedo con
-- `e.kind <> 'gasto'`, que excluye los gastos pero SIGUE contando los fletes
-- (kind = 'envio'). Resultado: al ponerle un flete pagado a una caja, se
-- descontaba de la cuenta o tarjeta elegida, que es justo lo que no quiere.
--
-- Que hace: rehace fin_v_account_balance para que SOLO las compras a
-- proveedores (kind = 'compra') muevan el saldo. Los fletes, igual que los
-- gastos, guardan con que cuenta se pagaron como informacion, pero no tocan el
-- saldo. Los abonos y cargos manuales siguen moviendolo.
--
-- Se usa `= 'compra'` y no `NOT IN ('gasto','envio')` a proposito: si algun
-- dia aparece un tipo de egreso nuevo, por defecto NO mueve saldos hasta que
-- se decida lo contrario. Es el error barato.
--
-- Efecto sobre lo ya cargado: inmediato y sin borrar nada. Los fletes siguen
-- registrados, con su cuenta, su monto y su estado de pago; simplemente dejan
-- de restar, y el saldo de esas cuentas se corrige solo porque se deriva.
--
-- Va con DROP antes del CREATE, como en el 05: las columnas no cambian, pero
-- asi no hay forma de tropezar con el 42P16 si la vista quedo distinta.
--
-- Es idempotente. Aplicar en el SQL Editor de Supabase.
-- db/finanzas_01_schema.sql ya quedo actualizado: una instalacion NUEVA solo
-- necesita el 01 y el 02.
-- ============================================================================

DROP VIEW IF EXISTS public.fin_v_account_balance;

-- security_invoker = on es OBLIGATORIO: sin eso la vista corre con los
-- permisos de quien la creo y se salta la RLS de las tablas base.
CREATE VIEW public.fin_v_account_balance
WITH (security_invoker = on) AS
WITH pagos AS (
  -- Solo las compras a proveedores mueven el saldo. Gastos y fletes no.
  SELECT p.account_id, SUM(p.amount_usd) AS total
    FROM public.fin_payments p
    JOIN public.fin_expenses e ON e.id = p.expense_id
   WHERE e.kind = 'compra'
   GROUP BY p.account_id
), manuales AS (
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
              THEN a.opening_balance_usd + COALESCE(p.total, 0)
                   + COALESCE(m.cargos, 0) - COALESCE(m.abonos, 0)
              -- En una cuenta es lo disponible: un abono lo sube.
              ELSE a.opening_balance_usd - COALESCE(p.total, 0)
                   + COALESCE(m.abonos, 0) - COALESCE(m.cargos, 0)
         END AS balance_usd
    FROM public.fin_accounts a
    LEFT JOIN pagos    p ON p.account_id = a.id
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
-- `fletes_que_dejan_de_restar` lista, por cuenta, cuanto le restaban los
-- fletes y el saldo que muestra ahora (ya corregido). Si no hay fletes
-- pagados, sale [].
-- ----------------------------------------------------------------------------
SELECT jsonb_pretty(jsonb_build_object(
  'opciones_vista', (
    SELECT COALESCE(array_to_string(c.reloptions, ','), '')
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'fin_v_account_balance'
  ),
  'fletes_que_dejan_de_restar', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'cuenta', x.name,
             'ya_no_resta', x.total,
             'saldo_ahora', x.balance_usd
           )), '[]'::jsonb)
      FROM (
        SELECT a.name, SUM(p.amount_usd) AS total, b.balance_usd
          FROM public.fin_payments p
          JOIN public.fin_expenses e ON e.id = p.expense_id AND e.kind = 'envio'
          JOIN public.fin_accounts a ON a.id = p.account_id
          JOIN public.fin_v_account_balance b ON b.account_id = a.id
         GROUP BY a.name, b.balance_usd
      ) x
  )
));
