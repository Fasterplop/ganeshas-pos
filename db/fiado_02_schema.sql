-- ============================================================================
-- Fiado (2 de 2): fiar desde la caja, Cuentas por cobrar, abonos y puntos.
--
-- POR QUÉ (propuesta del 22-nov-2026, docs/propuesta-historial-y-fiado.pdf y
-- docs/propuesta-fiado-permiso.pdf, aprobadas):
--   * El cliente se lleva la mercancía, deja (o no) un abono inicial y paga el
--     resto después, en uno o varios abonos.
--   * Solo fía y cobra quien Gerardo autorice: UN permiso por empleado
--     (Usuarios) habilita a la vez «Fiado» en la caja y «Cuentas por cobrar».
--   * Al fiar no se ganan ni se canjean puntos. Al terminar de pagar, se suman
--     o no según un interruptor por tienda (opción A de la propuesta).
--
-- MODELO:
--   * Una venta fiada es una fila normal de `sales` con payment_method =
--     'fiado' (db/fiado_01_enum.sql). Lo que debe es total_amount menos sus
--     abonos. Así la deuda nunca se pierde: si el abono inicial fallara, la
--     venta queda debiendo el total.
--   * fiado_payments: cada abono, por método. Un abono con dos métodos, o que
--     alcanza para varias ventas, son varias filas con el mismo batch_id. Los
--     abonos se aplican a la venta fiada más vieja primero.
--   * sales.fiado_paid_at: cuándo terminó de pagarse. sales.fiado_points_awarded:
--     los puntos que se sumaron al terminar (para poder quitarlos si se borra
--     un abono o se anula la venta).
--
-- QUÉ CREA:
--   1. profiles.can_fiar (permiso, nace en false) y profiles_perm_guard, que
--      ahora también lo protege.
--   2. store_settings.fiado_points_on_payoff (interruptor por tienda, nace en
--      true: al terminar de pagar se suman los puntos como en una venta normal).
--   3. sales.fiado_paid_at, sales.fiado_points_awarded y el trigger
--      sales_fiado_guard: no se fía sin permiso ni sin cliente, y nadie marca
--      una venta como pagada a mano.
--   4. fiado_payments (solo lectura por la API; se escribe con los RPC).
--   5. can_fiar(): ¿el usuario actual puede fiar y cobrar?
--   6. fiado_abonar(...): registra un abono (también el inicial).
--   7. fiado_borrar_abono(batch_id): solo el dueño.
--   8. delete_sale_and_revert: una venta fiada con abonos (aparte del inicial)
--      no se anula hasta borrar esos abonos; al anularla se quitan solo los
--      puntos que de verdad se sumaron.
--
-- ERRORES (RAISE EXCEPTION, el front los traduce en src/lib/fiado.ts):
--   NOT_AUTHORIZED, INVALID_ARGUMENTS, INVALID_METHOD, NOTHING_OWED,
--   AMOUNT_EXCEEDS_BALANCE, PAYMENT_NOT_FOUND, FIADO_NOT_ALLOWED,
--   FIADO_NEEDS_CUSTOMER, FIADO_INVALID, FIADO_CHANGE_NOT_ALLOWED,
--   FIADO_HAS_PAYMENTS.
--
-- CÓMO APLICAR: en el SQL Editor de Supabase, DESPUÉS de db/fiado_01_enum.sql,
-- el archivo ENTERO, con las tiendas cerradas y las pestañas de Advisors y
-- Table Editor cerradas (el trigger pide un candado breve sobre sales).
-- Antes: respaldo (node scripts/backup-db.mjs). Es idempotente.
--
-- PARA VOLVER ATRÁS (con fiados ya hechos, NO borrar la tabla: se pierden las
-- deudas). Para apagar el fiado basta con poner can_fiar = false a todos.
-- ============================================================================

SET lock_timeout = '5s';

-- ----------------------------------------------------------------------------
-- 1. Permiso por empleado.
-- ----------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS can_fiar boolean NOT NULL DEFAULT false;

-- Nadie se da a sí mismo los permisos. (Antes vivía en
-- db/novedades_01_precios_y_telefono.sql; esta es la versión vigente.)
CREATE OR REPLACE FUNCTION public.profiles_perm_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.can_raise_prices IS NOT DISTINCT FROM OLD.can_raise_prices
     AND NEW.phone_simple_mode IS NOT DISTINCT FROM OLD.phone_simple_mode
     AND NEW.can_fiar IS NOT DISTINCT FROM OLD.can_fiar THEN
    RETURN NEW;
  END IF;
  -- Usuarios (service role) y SQL Editor.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role::text = 'owner') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PERMISSION_CHANGE_NOT_ALLOWED';
END;
$$;

DROP TRIGGER IF EXISTS profiles_perm_guard ON public.profiles;
CREATE TRIGGER profiles_perm_guard
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.profiles_perm_guard();

-- ----------------------------------------------------------------------------
-- 2. Puntos al terminar de pagar: un interruptor por tienda.
-- ----------------------------------------------------------------------------
ALTER TABLE public.store_settings
  ADD COLUMN IF NOT EXISTS fiado_points_on_payoff boolean NOT NULL DEFAULT true;

INSERT INTO public.store_settings (store_id)
SELECT id FROM public.stores
ON CONFLICT (store_id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 3. La venta fiada.
-- ----------------------------------------------------------------------------
ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS fiado_paid_at        timestamptz,
  ADD COLUMN IF NOT EXISTS fiado_points_awarded integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS sales_fiado_open_idx
  ON public.sales (store_id, customer_id, created_at)
  WHERE payment_method = 'fiado' AND fiado_paid_at IS NULL;

-- ¿El usuario actual puede fiar y cobrar? El dueño siempre; los demás, si
-- tienen el permiso y la cuenta está activa.
CREATE OR REPLACE FUNCTION public.can_fiar()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = auth.uid()
       AND is_active
       AND (role::text = 'owner' OR can_fiar)
  );
$$;

REVOKE ALL ON FUNCTION public.can_fiar() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_fiar() TO authenticated;

-- La caja inserta la venta directo en `sales`: este trigger es lo que impide
-- fiar sin permiso o sin cliente (también desde la consola del navegador), y
-- que alguien marque una venta como pagada o le cambie el método a/desde
-- 'fiado' sin pasar por los RPC de abajo (que encienden app.fiado_rpc).
CREATE OR REPLACE FUNCTION public.sales_fiado_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.payment_method_2::text = 'fiado' THEN
      RAISE EXCEPTION 'FIADO_INVALID';
    END IF;
    IF NEW.payment_method::text = 'fiado' THEN
      IF auth.uid() IS NOT NULL AND NOT public.can_fiar() THEN
        RAISE EXCEPTION 'FIADO_NOT_ALLOWED';
      END IF;
      IF NEW.customer_id IS NULL OR btrim(NEW.customer_id) = '' THEN
        RAISE EXCEPTION 'FIADO_NEEDS_CUSTOMER';
      END IF;
      IF NEW.payment_method_2 IS NOT NULL OR COALESCE(NEW.total_amount, 0) <= 0 THEN
        RAISE EXCEPTION 'FIADO_INVALID';
      END IF;
    END IF;
    -- Ninguna venta nace pagada ni con puntos de fiado.
    NEW.fiado_paid_at := NULL;
    NEW.fiado_points_awarded := 0;
    RETURN NEW;
  END IF;

  IF (NEW.payment_method IS DISTINCT FROM OLD.payment_method
        AND (NEW.payment_method::text = 'fiado' OR OLD.payment_method::text = 'fiado'))
     OR NEW.fiado_paid_at IS DISTINCT FROM OLD.fiado_paid_at
     OR NEW.fiado_points_awarded IS DISTINCT FROM OLD.fiado_points_awarded THEN
    IF auth.uid() IS NOT NULL
       AND COALESCE(current_setting('app.fiado_rpc', true), '') <> '1' THEN
      RAISE EXCEPTION 'FIADO_CHANGE_NOT_ALLOWED';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sales_fiado_guard ON public.sales;
CREATE TRIGGER sales_fiado_guard
  BEFORE INSERT OR UPDATE ON public.sales
  FOR EACH ROW
  EXECUTE FUNCTION public.sales_fiado_guard();

-- ----------------------------------------------------------------------------
-- 4. Abonos. Las políticas van ANTES del ENABLE: el event trigger ensure_rls
--    activa la RLS en cada CREATE TABLE y una tabla con RLS y sin políticas
--    queda muda (lista vacía, sin error).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fiado_payments (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id       uuid        NOT NULL,
  sale_id        uuid        NOT NULL REFERENCES public.sales(id) ON DELETE CASCADE,
  store_id       uuid        NOT NULL REFERENCES public.stores(id),
  customer_id    varchar     NOT NULL,
  amount_usd     numeric(12,2) NOT NULL CHECK (amount_usd > 0),
  payment_method public.payment_method_type NOT NULL
                 CHECK (payment_method::text IN ('efectivo', 'zelle', 'pago_movil', 'punto_de_venta')),
  payment_ref    text,
  bcv_rate       numeric,
  is_initial     boolean     NOT NULL DEFAULT false,
  created_by     uuid        NOT NULL REFERENCES public.profiles(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fiado_payments_sale_idx     ON public.fiado_payments (sale_id);
CREATE INDEX IF NOT EXISTS fiado_payments_store_day_idx ON public.fiado_payments (store_id, created_at);
CREATE INDEX IF NOT EXISTS fiado_payments_batch_idx    ON public.fiado_payments (batch_id);
CREATE INDEX IF NOT EXISTS fiado_payments_customer_idx ON public.fiado_payments (store_id, customer_id);

-- La leen los mismos que leen ventas (Reportes suma los abonos del día en su
-- método). Nadie la escribe por la API: solo los RPC de abajo.
DROP POLICY IF EXISTS "fiado_payments_select" ON public.fiado_payments;
CREATE POLICY "fiado_payments_select" ON public.fiado_payments
  FOR SELECT TO authenticated
  USING (NOT public.is_consulta());

ALTER TABLE public.fiado_payments ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.fiado_payments FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.fiado_payments FROM authenticated;
GRANT SELECT ON public.fiado_payments TO authenticated;

-- ----------------------------------------------------------------------------
-- 6. Registrar un abono. Devuelve lo que el cliente sigue debiendo en esa
--    tienda (todas sus ventas fiadas abiertas).
--      p_sale_id NULL  -> abono normal: se aplica a la venta fiada más vieja
--                         primero, y si sobra, a la siguiente.
--      p_sale_id dado  -> abono inicial de esa venta (desde la caja).
--    Dos métodos: p_method/p_amount y p_method_2/p_amount_2.
--    Al quedar una venta en $0: fiado_paid_at = now() y, si el interruptor de
--    la tienda está encendido, se suman floor(total) puntos al cliente.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fiado_abonar(
  p_store_id    uuid,
  p_customer_id varchar,
  p_amount      numeric,
  p_method      public.payment_method_type,
  p_ref         text DEFAULT NULL,
  p_method_2    public.payment_method_type DEFAULT NULL,
  p_amount_2    numeric DEFAULT NULL,
  p_bcv_rate    numeric DEFAULT NULL,
  p_sale_id     uuid DEFAULT NULL
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch     uuid := gen_random_uuid();
  v_methods   public.payment_method_type[];
  v_amounts   numeric[];
  v_n         int;
  v_i         int := 1;
  v_left      numeric;
  v_due       numeric;
  v_take      numeric;
  v_balance   numeric;
  v_points_on boolean;
  v_pts       int;
  v_sale      record;
BEGIN
  IF NOT public.can_fiar() THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;

  p_amount   := round(p_amount, 2);
  p_amount_2 := round(p_amount_2, 2);
  IF p_store_id IS NULL OR p_customer_id IS NULL OR p_method IS NULL
     OR p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS';
  END IF;
  IF p_method::text NOT IN ('efectivo', 'zelle', 'pago_movil', 'punto_de_venta') THEN
    RAISE EXCEPTION 'INVALID_METHOD';
  END IF;
  IF p_method_2 IS NOT NULL THEN
    IF p_method_2::text NOT IN ('efectivo', 'zelle', 'pago_movil', 'punto_de_venta')
       OR p_method_2 = p_method THEN
      RAISE EXCEPTION 'INVALID_METHOD';
    END IF;
    IF p_amount_2 IS NULL OR p_amount_2 <= 0 THEN
      RAISE EXCEPTION 'INVALID_ARGUMENTS';
    END IF;
    v_methods := ARRAY[p_method, p_method_2];
    v_amounts := ARRAY[p_amount, p_amount_2];
  ELSE
    v_methods := ARRAY[p_method];
    v_amounts := ARRAY[p_amount];
  END IF;
  v_n := array_length(v_amounts, 1);

  PERFORM set_config('app.fiado_rpc', '1', true);

  -- Bloquea las ventas fiadas abiertas del cliente: dos abonos a la vez no
  -- pueden pagar dos veces lo mismo.
  PERFORM 1
     FROM public.sales s
    WHERE s.store_id = p_store_id
      AND s.customer_id = p_customer_id
      AND s.payment_method = 'fiado'
      AND s.fiado_paid_at IS NULL
      AND (p_sale_id IS NULL OR s.id = p_sale_id)
    FOR UPDATE;

  SELECT COALESCE(sum(s.total_amount - COALESCE(p.paid, 0)), 0)
    INTO v_balance
    FROM public.sales s
    LEFT JOIN (SELECT sale_id, sum(amount_usd) AS paid
                 FROM public.fiado_payments GROUP BY sale_id) p ON p.sale_id = s.id
   WHERE s.store_id = p_store_id
     AND s.customer_id = p_customer_id
     AND s.payment_method = 'fiado'
     AND s.fiado_paid_at IS NULL
     AND (p_sale_id IS NULL OR s.id = p_sale_id);

  IF round(v_balance, 2) <= 0 THEN
    RAISE EXCEPTION 'NOTHING_OWED';
  END IF;
  IF p_amount + COALESCE(p_amount_2, 0) > round(v_balance, 2) + 0.005 THEN
    RAISE EXCEPTION 'AMOUNT_EXCEEDS_BALANCE';
  END IF;

  -- Repartir: la venta más vieja primero; cada método se gasta completo antes
  -- de pasar al siguiente.
  v_left := v_amounts[1];
  FOR v_sale IN
    SELECT s.id,
           round(s.total_amount - COALESCE((SELECT sum(fp.amount_usd)
                                              FROM public.fiado_payments fp
                                             WHERE fp.sale_id = s.id), 0), 2) AS due
      FROM public.sales s
     WHERE s.store_id = p_store_id
       AND s.customer_id = p_customer_id
       AND s.payment_method = 'fiado'
       AND s.fiado_paid_at IS NULL
       AND (p_sale_id IS NULL OR s.id = p_sale_id)
     ORDER BY s.created_at, s.id
  LOOP
    v_due := v_sale.due;
    WHILE v_due > 0 AND v_i <= v_n LOOP
      v_take := LEAST(v_left, v_due);
      IF v_take > 0 THEN
        INSERT INTO public.fiado_payments
          (batch_id, sale_id, store_id, customer_id, amount_usd, payment_method,
           payment_ref, bcv_rate, is_initial, created_by)
        VALUES
          (v_batch, v_sale.id, p_store_id, p_customer_id, v_take, v_methods[v_i],
           NULLIF(btrim(p_ref), ''), p_bcv_rate, p_sale_id IS NOT NULL, auth.uid());
      END IF;
      v_due  := v_due - v_take;
      v_left := v_left - v_take;
      IF v_left <= 0 THEN
        v_i := v_i + 1;
        IF v_i <= v_n THEN
          v_left := v_amounts[v_i];
        END IF;
      END IF;
    END LOOP;
    EXIT WHEN v_i > v_n;
  END LOOP;

  -- Las ventas que quedaron en $0 terminan de pagarse.
  SELECT COALESCE((SELECT ss.fiado_points_on_payoff
                     FROM public.store_settings ss
                    WHERE ss.store_id = p_store_id), true)
    INTO v_points_on;

  FOR v_sale IN
    SELECT s.id, s.total_amount
      FROM public.sales s
     WHERE s.store_id = p_store_id
       AND s.customer_id = p_customer_id
       AND s.payment_method = 'fiado'
       AND s.fiado_paid_at IS NULL
       AND s.total_amount - COALESCE((SELECT sum(fp.amount_usd)
                                        FROM public.fiado_payments fp
                                       WHERE fp.sale_id = s.id), 0) <= 0.005
  LOOP
    v_pts := CASE WHEN v_points_on THEN floor(v_sale.total_amount)::int ELSE 0 END;
    UPDATE public.sales
       SET fiado_paid_at = now(),
           fiado_points_awarded = v_pts
     WHERE id = v_sale.id;
    IF v_pts > 0 THEN
      UPDATE public.customers
         SET reward_points = COALESCE(reward_points, 0) + v_pts
       WHERE document_id = p_customer_id AND store_id = p_store_id;
    END IF;
  END LOOP;

  SELECT COALESCE(sum(s.total_amount - COALESCE(p.paid, 0)), 0)
    INTO v_balance
    FROM public.sales s
    LEFT JOIN (SELECT sale_id, sum(amount_usd) AS paid
                 FROM public.fiado_payments GROUP BY sale_id) p ON p.sale_id = s.id
   WHERE s.store_id = p_store_id
     AND s.customer_id = p_customer_id
     AND s.payment_method = 'fiado'
     AND s.fiado_paid_at IS NULL;

  RETURN round(GREATEST(v_balance, 0), 2);
END;
$$;

REVOKE ALL ON FUNCTION public.fiado_abonar(uuid, varchar, numeric, public.payment_method_type, text, public.payment_method_type, numeric, numeric, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fiado_abonar(uuid, varchar, numeric, public.payment_method_type, text, public.payment_method_type, numeric, numeric, uuid) TO authenticated;

-- ----------------------------------------------------------------------------
-- 7. Borrar un abono mal anotado (todas sus filas): solo el dueño. Si una
--    venta vuelve a deber, se reabre y se le quitan los puntos que sumó.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fiado_borrar_abono(p_batch_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ids  uuid[];
  v_sale record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role::text = 'owner'
  ) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;

  SELECT array_agg(DISTINCT sale_id) INTO v_ids
    FROM public.fiado_payments WHERE batch_id = p_batch_id;
  IF v_ids IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_NOT_FOUND';
  END IF;

  PERFORM set_config('app.fiado_rpc', '1', true);
  PERFORM 1 FROM public.sales WHERE id = ANY (v_ids) FOR UPDATE;

  DELETE FROM public.fiado_payments WHERE batch_id = p_batch_id;

  FOR v_sale IN
    SELECT id, store_id, customer_id, fiado_points_awarded
      FROM public.sales
     WHERE id = ANY (v_ids) AND fiado_paid_at IS NOT NULL
  LOOP
    IF v_sale.fiado_points_awarded > 0 THEN
      UPDATE public.customers
         SET reward_points = GREATEST(COALESCE(reward_points, 0) - v_sale.fiado_points_awarded, 0)
       WHERE document_id = v_sale.customer_id AND store_id = v_sale.store_id;
    END IF;
    UPDATE public.sales
       SET fiado_paid_at = NULL, fiado_points_awarded = 0
     WHERE id = v_sale.id;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.fiado_borrar_abono(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fiado_borrar_abono(uuid) TO authenticated;

-- ----------------------------------------------------------------------------
-- 8. Anular una venta (versión vigente; antes vivía en
--    db/exchange_02_schema_and_rpc.sql). Igual que antes, más el fiado:
--      * FIADO_HAS_PAYMENTS si la venta fiada tiene abonos aparte del inicial:
--        primero se borran esos abonos en Cuentas por cobrar. El abono inicial
--        se va con la venta (ON DELETE CASCADE), como el efectivo de una venta
--        anulada.
--      * A una venta fiada se le quitan solo los puntos que sumó al terminar
--        de pagar (fiado_points_awarded), no floor(total).
--    Errores: NOT_AUTHORIZED, SALE_HAS_EXCHANGES, FIADO_HAS_PAYMENTS.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_sale_and_revert(p_sale_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_store_id          UUID;
  v_customer_id       VARCHAR;
  v_total_amount      NUMERIC;
  v_redemption_points INTEGER;
  v_method            TEXT;
  v_fiado_points      INTEGER;
  v_points_to_deduct  INTEGER;
  v_item              RECORD;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = auth.uid() AND role = 'owner'
  ) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;

  SELECT store_id, customer_id, total_amount, redemption_points,
         payment_method::text, fiado_points_awarded
    INTO v_store_id, v_customer_id, v_total_amount, v_redemption_points,
         v_method, v_fiado_points
    FROM sales
   WHERE id = p_sale_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venta no encontrada';
  END IF;

  -- Una venta (o un cambio) con líneas devueltas en otro cambio no se anula:
  -- primero se anula ese cambio, que revierte todo por sí mismo.
  IF EXISTS (
    SELECT 1
      FROM sale_items r
      JOIN sale_items s ON r.source_sale_item_id = s.id
     WHERE s.sale_id = p_sale_id
  ) THEN
    RAISE EXCEPTION 'SALE_HAS_EXCHANGES';
  END IF;

  IF v_method = 'fiado' AND EXISTS (
    SELECT 1 FROM fiado_payments WHERE sale_id = p_sale_id AND NOT is_initial
  ) THEN
    RAISE EXCEPTION 'FIADO_HAS_PAYMENTS';
  END IF;

  -- Devolver el stock (los productos rápidos tienen product_id NULL y no aplican)
  FOR v_item IN (SELECT product_id, quantity FROM sale_items WHERE sale_id = p_sale_id) LOOP
    UPDATE store_stock
       SET stock = stock + v_item.quantity
     WHERE product_id = v_item.product_id AND store_id = v_store_id;
  END LOOP;

  IF v_customer_id IS NOT NULL THEN
    -- Puntos GANADOS por la venta (1pt/$1) que se quitan, MENOS los puntos
    -- CANJEADOS en la venta que se reintegran. Un fiado solo ganó puntos si
    -- terminó de pagarse con el interruptor encendido.
    v_points_to_deduct := CASE WHEN v_method = 'fiado'
                               THEN COALESCE(v_fiado_points, 0)
                               ELSE FLOOR(v_total_amount) END;

    UPDATE customers
       SET total_spent   = GREATEST(total_spent - v_total_amount, 0),
           reward_points = GREATEST(reward_points - v_points_to_deduct + COALESCE(v_redemption_points, 0), 0)
     WHERE document_id = v_customer_id AND store_id = v_store_id;
  END IF;

  DELETE FROM sale_items WHERE sale_id = p_sale_id;
  DELETE FROM sales WHERE id = p_sale_id;
END;
$function$;

NOTIFY pgrst, 'reload schema';
