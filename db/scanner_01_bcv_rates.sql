-- ============================================================================
-- Tasa BCV del día, guardada en la base (para el teléfono escáner).
--
-- POR QUÉ: hasta ahora la tasa vivía SOLO en memoria (zustand `usePOSStore`,
-- sin persist) y `BcvModal` la pedía en cada recarga. En la caja eso es
-- tolerable (se abre una vez en la mañana y no se recarga), pero en el
-- teléfono de consulta de precios significaría teclear la tasa cada vez que
-- la página se refresca. Con esta tabla, el primero que la carga en el día la
-- deja puesta para cualquier dispositivo.
--
-- QUÉ NO CAMBIA: el modal bloqueante de la caja se queda exactamente igual.
-- Esta tabla la usa la pantalla nueva `/consultar-precio`; el POS no se toca.
--
-- TODO ADITIVO: tabla nueva, dos funciones nuevas. No borra ni altera nada.
--
-- OJO CON LA FECHA: la base corre en UTC. `current_date` cambiaría de día a
-- las 8 de la noche hora de Venezuela, con la tienda todavía abierta. Por eso
-- la fecha SIEMPRE se calcula como (now() AT TIME ZONE 'America/Caracas')::date
-- y la calcula el servidor, nunca el reloj del teléfono.
--
-- Aplicar en el SQL Editor de Supabase.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Tabla: una fila por día.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bcv_rates (
  rate_date  date NOT NULL,
  rate       numeric NOT NULL CHECK (rate > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT bcv_rates_pkey PRIMARY KEY (rate_date),
  CONSTRAINT bcv_rates_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.profiles(id)
);

-- ----------------------------------------------------------------------------
-- 2. Políticas ANTES del ENABLE.
--
--    El proyecto tiene un event trigger `ensure_rls` que activa RLS sola en
--    cada CREATE TABLE de public. Una tabla con RLS y CERO políticas no queda
--    "abierta": queda MUDA (PostgREST devuelve lista vacía SIN error, y el bug
--    es silencioso). Por eso las políticas van en este mismo archivo.
--
--    Leer: cualquiera logueado (la caja y el teléfono la necesitan).
--    Escribir: nadie por la API. Solo el RPC `set_bcv_rate` (SECURITY DEFINER),
--    que sella quién la puso y calcula la fecha del lado del servidor.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "bcv_rates_select_auth" ON public.bcv_rates;
CREATE POLICY "bcv_rates_select_auth" ON public.bcv_rates
  FOR SELECT TO authenticated USING (true);

ALTER TABLE public.bcv_rates ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 3. Leer la tasa de hoy. Devuelve NULL si nadie la cargó todavía.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_bcv_rate()
RETURNS numeric
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT rate
    FROM public.bcv_rates
   WHERE rate_date = (now() AT TIME ZONE 'America/Caracas')::date;
$$;

GRANT EXECUTE ON FUNCTION public.get_bcv_rate() TO authenticated;

-- ----------------------------------------------------------------------------
-- 4. Guardar / corregir la tasa de hoy.
--    Upsert: si la tasa subió otra vez el mismo día, se pisa y se re-sella.
--    Cualquier usuario autenticado puede (hoy ya puede teclearla en el modal
--    de la caja; esto no da un permiso nuevo, solo lo persiste).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_bcv_rate(p_rate numeric)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Caracas')::date;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;
  IF p_rate IS NULL OR p_rate <= 0 THEN
    RAISE EXCEPTION 'INVALID_RATE';
  END IF;

  INSERT INTO public.bcv_rates (rate_date, rate, updated_at, updated_by)
  VALUES (v_today, p_rate, now(), auth.uid())
  ON CONFLICT (rate_date) DO UPDATE
     SET rate = EXCLUDED.rate,
         updated_at = now(),
         updated_by = auth.uid();

  RETURN p_rate;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_bcv_rate(numeric) TO authenticated;

-- ============================================================================
-- VERIFICACIÓN (el SQL Editor solo muestra el último SELECT: copiar la celda).
-- Debe decir rls_activa = true, politicas = 1 y las dos funciones presentes.
-- ============================================================================
SELECT jsonb_pretty(jsonb_build_object(
  'tabla', (
    SELECT jsonb_build_object(
             'rls_activa', c.relrowsecurity,
             'politicas', (SELECT COUNT(*) FROM pg_policies p
                            WHERE p.schemaname = 'public' AND p.tablename = 'bcv_rates')
           )
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'bcv_rates'
  ),
  'funciones', (
    SELECT jsonb_agg(p.proname ORDER BY p.proname)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('get_bcv_rate', 'set_bcv_rate')
  ),
  'hoy_caracas', (now() AT TIME ZONE 'America/Caracas')::date,
  'tasa_de_hoy', public.get_bcv_rate()
));
