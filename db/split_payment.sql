-- ============================================================================
-- Pago dividido: permite registrar una venta con hasta 2 métodos de pago.
-- Aditivo y NO destructivo: agrega 3 columnas nullable a public.sales.
--   - payment_method_2 : segundo método (MISMO tipo enum que payment_method)
--   - payment_amount_1 : monto en USD cubierto por el método 1
--   - payment_amount_2 : monto en USD cubierto por el método 2
-- Las ventas existentes quedan con estos campos en NULL => pago simple.
-- Aplicar en el SQL Editor de Supabase.
-- ============================================================================

-- payment_method_2 usa EXACTAMENTE el mismo tipo (enum) que la columna
-- payment_method, sin necesidad de conocer el nombre del enum.
DO $$
DECLARE
  v_type text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.sales'::regclass
      AND attname  = 'payment_method_2'
      AND NOT attisdropped
  ) THEN
    SELECT format_type(atttypid, atttypmod) INTO v_type
    FROM pg_attribute
    WHERE attrelid = 'public.sales'::regclass
      AND attname  = 'payment_method'
      AND NOT attisdropped;
    EXECUTE format('ALTER TABLE public.sales ADD COLUMN payment_method_2 %s', v_type);
  END IF;
END $$;

ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS payment_amount_1 numeric;
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS payment_amount_2 numeric;
