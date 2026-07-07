-- ============================================================================
-- Borrado REAL de cliente (reemplaza el ocultado con is_hidden).
--  - Elimina los datos y puntos del cliente en TODAS las sucursales.
--  - CONSERVA las ventas: solo las desvincula (customer_id -> NULL) para no
--    romper la FK sales -> customers y mantener el histórico de facturación.
--  - Solo el owner puede ejecutarlo (SECURITY DEFINER + verificación de rol).
-- Aplicar en el SQL Editor de Supabase. No borra ninguna venta.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.delete_customer_global(p_document_id varchar)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Solo el owner puede borrar clientes.
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = auth.uid() AND role = 'owner'
  ) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;

  -- 1. Conservar las ventas: se desvinculan del cliente en todas las
  --    sucursales antes de borrar (respeta la FK sales -> customers).
  UPDATE public.sales
     SET customer_id = NULL
   WHERE customer_id = p_document_id;

  -- 2. Borrar los datos y puntos del cliente en todas las sucursales.
  DELETE FROM public.customers
   WHERE document_id = p_document_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_customer_global(varchar) TO authenticated;
