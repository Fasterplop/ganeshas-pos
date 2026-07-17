-- ============================================================================
-- WhatsApp marketing: consentimiento (opt-in) y baja (opt-out) del cliente.
--
-- La plantilla post-venta quedó categorizada por Meta como MARKETING (por el
-- botón de Instagram y el quick reply "Cancelar promociones"). La política de
-- Meta exige consentimiento explícito para marketing: el aviso presencial solo
-- cubre mensajes de utilidad. Enviar marketing sin opt-in => bloqueos/reportes
-- => baja el quality rating => Meta pausa la plantilla o degrada el número.
--
-- Aditivo y NO destructivo: agrega 2 columnas a public.customers.
--   - wa_marketing_opt_in : el cliente aceptó recibir promociones (default FALSE:
--                           por seguridad, los clientes existentes NO reciben
--                           nada hasta que acepten explícitamente en caja).
--   - wa_opt_out_at       : timestamp de la baja (botón "Cancelar promociones").
--                           Si NO es NULL, nunca más se le envía marketing,
--                           aunque wa_marketing_opt_in siga en true.
--
-- El opt-in/opt-out es del CLIENTE (persona), no de la sucursal: se replica en
-- todas las filas del mismo document_id (la PK es (document_id, store_id)).
-- Aplicar en el SQL Editor de Supabase.
-- ============================================================================

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS wa_marketing_opt_in boolean NOT NULL DEFAULT false;

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS wa_opt_out_at timestamptz;


-- ----------------------------------------------------------------------------
-- Registrar la BAJA de marketing en TODAS las sucursales del cliente.
-- La ejecuta n8n (service role) al recibir el quick reply "Cancelar
-- promociones" desde el webhook de eventos de Meta.
--
-- Busca por teléfono normalizado: customers.phone es texto libre
-- ('0414-123.45.67', '+58 414 1234567'...) mientras que Meta envía el número
-- en formato 584141234567. Comparamos solo los últimos 10 dígitos de ambos,
-- que es la parte estable del móvil venezolano (4XX + 7 dígitos).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wa_opt_out_by_phone(p_wa_phone text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_digits text;
  v_tail   text;
  v_count  integer;
BEGIN
  v_digits := regexp_replace(COALESCE(p_wa_phone, ''), '\D', '', 'g');
  IF length(v_digits) < 10 THEN
    RETURN 0;
  END IF;
  v_tail := right(v_digits, 10);

  UPDATE public.customers
     SET wa_opt_out_at = now(),
         wa_marketing_opt_in = false
   WHERE right(regexp_replace(COALESCE(phone, ''), '\D', '', 'g'), 10) = v_tail
     AND phone IS NOT NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Solo el service role (n8n) la ejecuta; ningún rol de la app la necesita.
REVOKE ALL ON FUNCTION public.wa_opt_out_by_phone(text) FROM PUBLIC;


-- ----------------------------------------------------------------------------
-- get_global_points: se EXTIENDE de forma aditiva para devolver también el
-- estado de consentimiento GLOBAL del cliente, así la caja puede mostrar el
-- checkbox ya marcado si el cliente aceptó antes (en cualquier sucursal).
-- Las claves 'full_name' y 'points' se mantienen idénticas: el único consumidor
-- (src/app/(dashboard)/pos/page.tsx) sigue funcionando igual.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_global_points(p_document_id varchar)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count   integer;
  v_points  integer;
  v_name    text;
  v_opt_in  boolean;
  v_opt_out timestamptz;
BEGIN
  SELECT COUNT(*), COALESCE(SUM(reward_points), 0), MAX(full_name),
         COALESCE(bool_or(wa_marketing_opt_in), false), MAX(wa_opt_out_at)
    INTO v_count, v_points, v_name, v_opt_in, v_opt_out
    FROM public.customers
   WHERE document_id = p_document_id;

  IF v_count = 0 THEN
    RETURN NULL;  -- el cliente no existe en ninguna sucursal
  END IF;

  RETURN jsonb_build_object(
    'full_name', v_name,
    'points', v_points,
    -- Una baja anula el consentimiento aunque alguna fila siga en true.
    'wa_opt_in', (v_opt_in AND v_opt_out IS NULL),
    'wa_opt_out', (v_opt_out IS NOT NULL)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_global_points(varchar) TO authenticated;
