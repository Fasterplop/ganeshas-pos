-- ============================================================================
-- MODULO DE FINANZAS - suscripciones, abonos manuales a cuentas, y que los
-- gastos dejen de mover el saldo.
--
-- Tres cosas que pidio el dueno al usarlo:
--
-- 1) LOS GASTOS YA NO RESTAN DEL SALDO. La seccion de Gastos es para llevar la
--    cuenta de en que se va el dinero, no para mover saldos. El gasto sigue
--    preguntando con que cuenta se pago -- para tenerlo anotado -- pero ese
--    dato ya no toca el saldo de la cuenta. Las COMPRAS a proveedores si lo
--    siguen moviendo: ahi si importa saber cuanto queda en la tarjeta.
--
-- 2) ABONAR A UNA TARJETA O CUENTA (fin_account_movements). Hasta ahora la
--    unica forma de bajar la deuda de una tarjeta era editar su saldo inicial,
--    que borraba el historial. Ahora es un movimiento con su fecha y su nota.
--
-- 3) SUSCRIPCIONES (fin_subscriptions). YouTube, Spotify y compania: cada una
--    con su monto y su dia de corte. Se marcan solas en el calendario todos los
--    meses, igual que el dia de pago de una tarjeta: no son filas de gasto, son
--    una regla mensual que se proyecta sobre el mes que se mira.
--
-- !! Las dos tablas nuevas nacen con RLS por el event trigger `ensure_rls`. Sin
-- sus cuatro politicas quedarian BLOQUEADAS para todos y la app mostraria
-- listas vacias SIN ERROR. Por eso las politicas van en el mismo bloque.
--
-- Es idempotente. Aplicar en el SQL Editor de Supabase.
-- db/finanzas_01_schema.sql ya quedo actualizado a este diseno: una instalacion
-- NUEVA solo necesita el 01 y el 02.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1) Abonos y cargos manuales sobre una cuenta o tarjeta.
--
-- `kind` se lee siempre como "le meto dinero" / "le saco dinero", y el efecto
-- sobre el saldo depende de que es la cuenta:
--   - tarjeta de credito: el saldo es la DEUDA, asi que un abono la BAJA.
--   - banco / efectivo / zelle: el saldo es lo disponible, un abono lo SUBE.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fin_account_movements (
  id         uuid NOT NULL DEFAULT uuid_generate_v4(),
  account_id uuid NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('abono','cargo')),
  amount_usd numeric NOT NULL CHECK (amount_usd > 0),
  moved_at   date NOT NULL,
  note       text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fin_account_movements_pkey PRIMARY KEY (id),
  CONSTRAINT fin_account_movements_account_fkey
    FOREIGN KEY (account_id) REFERENCES public.fin_accounts(id) ON DELETE CASCADE,
  CONSTRAINT fin_account_movements_author_fkey
    FOREIGN KEY (created_by) REFERENCES public.profiles(id)
);

CREATE INDEX IF NOT EXISTS idx_fin_account_movements_account
  ON public.fin_account_movements (account_id, moved_at DESC);


-- ----------------------------------------------------------------------------
-- 2) Suscripciones recurrentes.
--
-- No generan gastos solas: son un recordatorio con monto. Si un mes se quiere
-- contar de verdad, se registra el gasto a mano en la categoria Suscripciones.
-- Asi un mes que no cobraron no deja un gasto fantasma.
--
-- billing_day es un DIA del mes (1-31), no una fecha: la suscripcion se cobra
-- todos los meses y guardar una fecha concreta obligaria a moverla cada vez.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fin_subscriptions (
  id          uuid NOT NULL DEFAULT uuid_generate_v4(),
  name        text NOT NULL,
  amount_usd  numeric NOT NULL CHECK (amount_usd > 0),
  billing_day smallint NOT NULL CHECK (billing_day BETWEEN 1 AND 31),
  account_id  uuid,
  category_id uuid,
  is_personal boolean NOT NULL DEFAULT false,
  is_active   boolean NOT NULL DEFAULT true,
  notes       text,
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fin_subscriptions_pkey PRIMARY KEY (id),
  CONSTRAINT fin_subscriptions_account_fkey
    FOREIGN KEY (account_id) REFERENCES public.fin_accounts(id) ON DELETE SET NULL,
  CONSTRAINT fin_subscriptions_category_fkey
    FOREIGN KEY (category_id) REFERENCES public.fin_categories(id) ON DELETE SET NULL,
  CONSTRAINT fin_subscriptions_author_fkey
    FOREIGN KEY (created_by) REFERENCES public.profiles(id)
);

CREATE INDEX IF NOT EXISTS idx_fin_subscriptions_activas
  ON public.fin_subscriptions (billing_day) WHERE is_active;


-- ----------------------------------------------------------------------------
-- 3) RLS de las dos tablas nuevas. Solo el owner, los cuatro verbos.
-- ----------------------------------------------------------------------------
DO $rls$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fin_account_movements', 'fin_subscriptions'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select_owner', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.fin_is_owner())',
      t || '_select_owner', t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_insert_owner', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (public.fin_is_owner())',
      t || '_insert_owner', t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_update_owner', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (public.fin_is_owner()) WITH CHECK (public.fin_is_owner())',
      t || '_update_owner', t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_delete_owner', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (public.fin_is_owner())',
      t || '_delete_owner', t);

    -- Recien ahora, con las cuatro politicas ya puestas.
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END
$rls$;


-- ----------------------------------------------------------------------------
-- 4) El saldo de una cuenta, con las dos reglas nuevas.
--
--   - Los pagos de GASTOS ya no cuentan (e.kind <> 'gasto'). Quedan guardados
--     como informacion de con que se pago, pero no mueven el saldo.
--   - Se suman los abonos y cargos manuales.
--
-- security_invoker = on sigue siendo obligatorio: sin eso la vista corre con
-- los permisos de quien la creo y se salta la RLS de las tablas base.
-- ----------------------------------------------------------------------------
-- OJO: va un DROP antes del CREATE, no basta con CREATE OR REPLACE.
-- Postgres solo deja "reemplazar" una vista si las columnas quedan con el
-- mismo nombre y en el mismo orden, y aqui se agregan abonos_usd y cargos_usd
-- en medio. Sin el DROP falla con:
--   42P16: cannot change name of view column "balance_usd" to "abonos_usd"
-- Borrarla es seguro: ninguna otra vista ni funcion depende de ella, solo la
-- app, que la consulta por nombre.
DROP VIEW IF EXISTS public.fin_v_account_balance;

CREATE OR REPLACE VIEW public.fin_v_account_balance
WITH (security_invoker = on) AS
WITH pagos AS (
  -- Solo lo que de verdad mueve el saldo: compras a proveedores y fletes.
  SELECT p.account_id, SUM(p.amount_usd) AS total
    FROM public.fin_payments p
    JOIN public.fin_expenses e ON e.id = p.expense_id
   WHERE e.kind <> 'gasto'
   GROUP BY p.account_id
), manuales AS (
  SELECT account_id,
         COALESCE(SUM(amount_usd) FILTER (WHERE kind = 'abono'), 0) AS abonos,
         COALESCE(SUM(amount_usd) FILTER (WHERE kind = 'cargo'), 0) AS cargos
    FROM public.fin_account_movements
   GROUP BY account_id
), calculo AS (
  SELECT a.*,
         COALESCE(p.total, 0)    AS moved_usd,
         COALESCE(m.abonos, 0)   AS abonos_usd,
         COALESCE(m.cargos, 0)   AS cargos_usd,
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
-- Las dos tablas nuevas deben salir con rls_activa = true y politicas = 4. Si
-- alguna sale en 0, esa tabla queda muda: la app no mostraria ni una fila y no
-- daria ningun error.
--
-- PROBAR DESPUES:
--   - /finanzas/cuentas -> "Abonar" en una tarjeta: la deuda tiene que bajar.
--   - /finanzas/gastos  -> registrar un gasto pagado: el saldo de la cuenta NO
--     debe moverse.
--   - /finanzas/gastos  -> agregar una suscripcion y verla en el calendario en
--     su dia de corte.
-- ----------------------------------------------------------------------------
SELECT jsonb_pretty(jsonb_agg(t ORDER BY t->>'tabla'))
FROM (
  SELECT jsonb_build_object(
           'tabla',      c.relname,
           'rls_activa', c.relrowsecurity,
           'politicas',  (SELECT COUNT(*) FROM pg_policies p
                           WHERE p.schemaname = 'public' AND p.tablename = c.relname)
         ) AS t
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND c.relname IN ('fin_account_movements', 'fin_subscriptions')
) s;
