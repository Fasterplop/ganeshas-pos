-- ============================================================================
-- Fase 2 — Canje de puntos en el Smart Checkout (enfoque mínimo / aditivo)
-- Aplicar en Supabase (SQL Editor) EN ESTE ORDEN.
-- Todo es aditivo: no borra ni altera tablas/columnas existentes.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Tabla de configuración de lealtad, POR SUCURSAL (editable por el owner).
--    Default: 10 puntos = $10 de descuento.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.loyalty_settings (
  store_id               uuid PRIMARY KEY REFERENCES public.stores(id) ON DELETE CASCADE,
  points_per_block       integer NOT NULL DEFAULT 10 CHECK (points_per_block > 0),
  discount_per_block_usd numeric NOT NULL DEFAULT 10 CHECK (discount_per_block_usd > 0),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid REFERENCES public.profiles(id)  -- mismo patrón que sales.cashier_id
);

-- Semilla: crea la config por defecto para cada tienda existente.
INSERT INTO public.loyalty_settings (store_id)
SELECT id FROM public.stores
ON CONFLICT (store_id) DO NOTHING;

-- RLS
ALTER TABLE public.loyalty_settings ENABLE ROW LEVEL SECURITY;

-- Lectura: owner (todas) o cajero (su sucursal asignada).
DROP POLICY IF EXISTS loyalty_settings_select ON public.loyalty_settings;
CREATE POLICY loyalty_settings_select ON public.loyalty_settings
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND (p.role = 'owner' OR p.assigned_store_id = loyalty_settings.store_id)
    )
  );

-- Escritura (insert/update/delete): solo owner.
DROP POLICY IF EXISTS loyalty_settings_write ON public.loyalty_settings;
CREATE POLICY loyalty_settings_write ON public.loyalty_settings
  FOR ALL TO authenticated
  USING      (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'owner'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'owner'));


-- ----------------------------------------------------------------------------
-- 2. Función de resta atómica de puntos (único objeto que toca reward_points).
--    - Nunca deja el saldo negativo.
--    - Resuelve carreras: el UPDATE condicional toma lock de fila; si dos
--      canjes concurrentes compiten, el segundo ve el saldo ya reducido.
--    - SECURITY INVOKER: corre bajo la sesión del cajero (respeta RLS, igual
--      que el UPDATE de acumulación que ya funciona hoy).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.redeem_points(
  p_document_id varchar,
  p_store_id    uuid,
  p_points      integer
) RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_remaining integer;
BEGIN
  IF p_points IS NULL OR p_points <= 0 THEN
    RAISE EXCEPTION 'INVALID_POINTS';
  END IF;

  UPDATE public.customers
     SET reward_points = reward_points - p_points
   WHERE document_id = p_document_id
     AND store_id    = p_store_id
     AND reward_points >= p_points
   RETURNING reward_points INTO v_remaining;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INSUFFICIENT_POINTS';  -- saldo insuficiente o carrera perdida
  END IF;

  RETURN v_remaining;  -- saldo restante
END;
$$;

-- Permitir que los usuarios autenticados (cajeros/owner) invoquen la función.
GRANT EXECUTE ON FUNCTION public.redeem_points(varchar, uuid, integer) TO authenticated;
