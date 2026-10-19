-- ============================================================================
-- Novedades (1): subir precios sin poder bajarlos, modo teléfono por cuenta,
-- Novedades del dueño y la cuenta «Anais y Karina».
--
-- POR QUÉ (propuesta del 17-oct-2026, aprobada por Gerardo):
--   * La cajera de mayor rango (reposición «Todas») tiene que poder SUBIR el
--     precio de un producto, nunca bajarlo, y el dueño tiene que enterarse.
--   * Esa misma cuenta, con un solo correo, ve todo en la computadora y en el
--     teléfono escáner solo Consultar precio y la caja.
--   * La cuenta la usan dos personas: pasa a llamarse «Anais y Karina».
--
-- QUÉ CREA:
--   1. profiles.can_raise_prices   — permiso «Subir precios» (Usuarios).
--      profiles.phone_simple_mode  — «En el teléfono: precio y caja».
--      profiles.novedades_seen_at  — hasta dónde vio el dueño sus Novedades.
--   2. price_changes: una fila por cada subida hecha por un cajero. Solo la
--      lee el dueño. Nadie la escribe desde fuera: solo el RPC de abajo.
--   3. raise_product_price(producto, precio nuevo): la ÚNICA forma en que un
--      no-dueño cambia un precio. Exige can_raise_prices y que el precio
--      nuevo sea MAYOR. El % de una oferta se aplica solo sobre el nuevo.
--   4. Trigger products_price_guard: cualquier otro cambio de precio que no
--      venga del dueño (o del SQL Editor / service role) se rechaza. Hoy
--      `products` tiene políticas USING (true): sin esto, un cajero podía
--      cambiar (y bajar) un precio desde la consola del navegador.
--      Ningún flujo de cajero escribe price hoy: el ajuste masivo y su
--      deshacer son del dueño; move_product_to_store y register_exchange no
--      tocan el precio.
--   5. Trigger profiles_perm_guard: nadie salvo el dueño (o el service role,
--      que es lo que usa la pantalla Usuarios) cambia esas dos banderas.
--   6. mark_novedades_seen(): el dueño marca sus Novedades como vistas.
--   7. La cuenta «anais de cordero» (o «Anais Cordero») pasa a «Anais y Karina» con los dos permisos
--      encendidos. Si no aparece EXACTAMENTE una cuenta con ese nombre, que
--      sea cajero con reposición «Todas», el archivo entero se deshace.
--
-- Las Novedades de transferencias leen stock_transfers, que ya existe (su
-- nota es el motivo). Este archivo no toca transfer_stock ni
-- move_product_to_store.
--
-- ERRORES (RAISE EXCEPTION, el front los traduce en src/lib/novedades.ts):
--   NOT_AUTHORIZED, INVALID_ARGUMENTS, PRODUCT_NOT_FOUND, PRODUCT_INACTIVE,
--   PRICE_NOT_HIGHER, PRICE_CHANGE_NOT_ALLOWED, PERMISSION_CHANGE_NOT_ALLOWED.
--
-- CÓMO APLICAR: en el SQL Editor de Supabase, el archivo ENTERO, con las
-- tiendas cerradas y las pestañas de Advisors y Table Editor cerradas (los
-- triggers piden un candado breve sobre products y profiles; el lock_timeout
-- hace que se rinda en vez de encolar la caja). Antes: respaldo
-- (node scripts/backup-db.mjs). Es idempotente: se puede volver a correr.
--
-- PARA VOLVER ATRÁS (sin borrar el historial):
--   DROP TRIGGER products_price_guard ON public.products;
--   DROP TRIGGER profiles_perm_guard ON public.profiles;
--   DROP FUNCTION public.raise_product_price(uuid, numeric);
--   DROP FUNCTION public.mark_novedades_seen();
--   NOTIFY pgrst, 'reload schema';
-- El nombre de la cuenta se cambia a mano si hiciera falta.
-- ============================================================================

SET lock_timeout = '5s';

-- ----------------------------------------------------------------------------
-- 1. Columnas nuevas en profiles.
-- ----------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS can_raise_prices  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS phone_simple_mode boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS novedades_seen_at timestamptz;

-- ----------------------------------------------------------------------------
-- 2. Historial de subidas de precio. Las políticas van ANTES del ENABLE: el
--    event trigger ensure_rls activa la RLS en cada CREATE TABLE y una tabla
--    con RLS y sin políticas queda muda (lista vacía, sin error).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.price_changes (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  uuid        NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  old_price   numeric     NOT NULL,
  new_price   numeric     NOT NULL CHECK (new_price > old_price),
  changed_by  uuid        NOT NULL REFERENCES public.profiles(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS price_changes_created_at_idx ON public.price_changes (created_at DESC);

DROP POLICY IF EXISTS "price_changes_select_owner" ON public.price_changes;
CREATE POLICY "price_changes_select_owner" ON public.price_changes
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles p
             WHERE p.id = auth.uid() AND p.role::text = 'owner')
  );

ALTER TABLE public.price_changes ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 3. Subir un precio. Devuelve jsonb: { product_id, old_price, new_price }.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.raise_product_price(
  p_product_id uuid,
  p_new_price  numeric
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role      text;
  v_active    boolean;
  v_can_raise boolean;
  v_old       numeric;
  v_p_active  boolean;
  v_new       numeric := round(p_new_price, 2);
BEGIN
  -- 1. Autorización: el dueño, o un cajero activo con el permiso. Va aquí
  --    dentro porque la clave anónima viaja en el navegador.
  SELECT role::text, is_active, can_raise_prices
    INTO v_role, v_active, v_can_raise
    FROM public.profiles
   WHERE id = auth.uid();

  IF v_role IS NULL OR COALESCE(v_active, false) = false THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;
  IF NOT (v_role = 'owner' OR (v_role = 'cashier' AND COALESCE(v_can_raise, false))) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;

  -- 2. Argumentos (tope de cordura contra un dedazo de ceros de más).
  IF p_product_id IS NULL OR v_new IS NULL OR v_new <= 0 OR v_new > 100000 THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS';
  END IF;

  -- 3. El producto, bloqueado: dos subidas a la vez no pisan el "antes".
  SELECT price, COALESCE(is_active, false)
    INTO v_old, v_p_active
    FROM public.products
   WHERE id = p_product_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
  END IF;
  IF NOT v_p_active THEN
    RAISE EXCEPTION 'PRODUCT_INACTIVE';
  END IF;

  -- 4. Solo hacia arriba.
  IF v_new <= v_old THEN
    RAISE EXCEPTION 'PRICE_NOT_HIGHER';
  END IF;

  -- 5. La bandera (local a esta transacción) deja pasar este UPDATE por el
  --    trigger products_price_guard.
  PERFORM set_config('app.price_raise', '1', true);
  UPDATE public.products SET price = v_new WHERE id = p_product_id;
  PERFORM set_config('app.price_raise', '', true);

  -- Las subidas del dueño no van a sus propias Novedades.
  IF v_role <> 'owner' THEN
    INSERT INTO public.price_changes (product_id, old_price, new_price, changed_by)
    VALUES (p_product_id, v_old, v_new, auth.uid());
  END IF;

  RETURN jsonb_build_object('product_id', p_product_id, 'old_price', v_old, 'new_price', v_new);
END;
$$;

REVOKE ALL ON FUNCTION public.raise_product_price(uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.raise_product_price(uuid, numeric) TO authenticated;

-- ----------------------------------------------------------------------------
-- 4. Ningún cambio de precio fuera del dueño o del RPC de arriba.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.products_price_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- SQL Editor y service role: sin usuario de la app.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF current_setting('app.price_raise', true) = '1' THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role::text = 'owner') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PRICE_CHANGE_NOT_ALLOWED';
END;
$$;

DROP TRIGGER IF EXISTS products_price_guard ON public.products;
CREATE TRIGGER products_price_guard
  BEFORE UPDATE OF price ON public.products
  FOR EACH ROW
  WHEN (NEW.price IS DISTINCT FROM OLD.price)
  EXECUTE FUNCTION public.products_price_guard();

-- ----------------------------------------------------------------------------
-- 5. Nadie se da a sí mismo los permisos nuevos.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.profiles_perm_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.can_raise_prices IS NOT DISTINCT FROM OLD.can_raise_prices
     AND NEW.phone_simple_mode IS NOT DISTINCT FROM OLD.phone_simple_mode THEN
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
-- 6. El dueño marca sus Novedades como vistas. Devuelve la hora guardada.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_novedades_seen()
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
BEGIN
  UPDATE public.profiles
     SET novedades_seen_at = v_now
   WHERE id = auth.uid() AND role::text = 'owner';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;
  RETURN v_now;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_novedades_seen() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_novedades_seen() TO authenticated;

-- ----------------------------------------------------------------------------
-- 7. «anais de cordero» (así está en producción el 2026-10-18) → «Anais y Karina», con los dos permisos. Solo esa
--    cuenta: los demás cajeros quedan como estaban (las columnas nacen en
--    false). Si ya se renombró en una corrida anterior, no hace nada.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_count integer;
  v_id    uuid;
BEGIN
  SELECT COUNT(*), MIN(id::text)::uuid
    INTO v_count, v_id
    FROM public.profiles
   WHERE trim(full_name) ILIKE 'ana_s cordero' OR trim(full_name) ILIKE 'ana_s de cordero';

  IF v_count = 0 THEN
    IF EXISTS (SELECT 1 FROM public.profiles WHERE full_name = 'Anais y Karina') THEN
      RAISE NOTICE 'La cuenta ya se llama «Anais y Karina»: no se toca.';
      RETURN;
    END IF;
    RAISE EXCEPTION 'No hay ninguna cuenta llamada «Anais Cordero». No se aplicó nada: revisar el nombre exacto en profiles.';
  END IF;
  IF v_count > 1 THEN
    RAISE EXCEPTION 'Hay % cuentas llamadas «Anais Cordero». No se aplicó nada.', v_count;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.profiles
                  WHERE id = v_id AND role::text = 'cashier' AND can_restock_all) THEN
    RAISE EXCEPTION '«Anais Cordero» no es cajero con reposición «Todas». No se aplicó nada.';
  END IF;

  UPDATE public.profiles
     SET full_name = 'Anais y Karina',
         can_raise_prices = true,
         phone_simple_mode = true
   WHERE id = v_id;
END;
$$;

NOTIFY pgrst, 'reload schema';

-- ----------------------------------------------------------------------------
-- 8. Verificación. Esperado: columnas = 3, rls_activa = true,
--    politicas_price_changes = 1, los 2 RPC y los 2 triggers en true,
--    con_subir_precios = 1, con_modo_telefono = 1, cuentas_anais_y_karina = 1.
--    politicas_de_profiles es solo para leerla (no está en db/).
-- ----------------------------------------------------------------------------
SELECT
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles'
      AND column_name IN ('can_raise_prices', 'phone_simple_mode', 'novedades_seen_at'))       AS columnas,
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.price_changes'::regclass)          AS rls_activa,
  (SELECT COUNT(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'price_changes') AS politicas_price_changes,
  (SELECT prosecdef FROM pg_proc WHERE oid = 'public.raise_product_price(uuid, numeric)'::regprocedure) AS rpc_subir_precio,
  (SELECT prosecdef FROM pg_proc WHERE oid = 'public.mark_novedades_seen()'::regprocedure)   AS rpc_novedades_vistas,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'products_price_guard' AND NOT tgisinternal) AS trigger_precios,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'profiles_perm_guard' AND NOT tgisinternal)  AS trigger_permisos,
  (SELECT COUNT(*) FROM public.profiles WHERE can_raise_prices)                               AS con_subir_precios,
  (SELECT COUNT(*) FROM public.profiles WHERE phone_simple_mode)                              AS con_modo_telefono,
  (SELECT COUNT(*) FROM public.profiles WHERE full_name = 'Anais y Karina')                   AS cuentas_anais_y_karina,
  (SELECT string_agg(policyname || ' [' || cmd || '] ' || COALESCE(qual, '') || ' / ' || COALESCE(with_check, ''), E'\n')
     FROM pg_policies WHERE schemaname = 'public' AND tablename = 'profiles')                 AS politicas_de_profiles;
