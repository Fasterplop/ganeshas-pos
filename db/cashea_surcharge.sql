-- ============================================================================
-- Recargo del 5% por uso de Cashea (cobrado sobre el monto que va en Cashea,
-- activo por default en el POS pero el cajero puede desmarcarlo).
-- Guarda el monto en USD ya cobrado (0 si no aplicó) para que el historial,
-- el dashboard y el export a Excel puedan mostrarlo/auditarlo.
-- total_amount YA incluye este recargo (es lo que realmente pagó el cliente).
-- Aplicar en el SQL Editor de Supabase. Aditivo, no destructivo.
-- ============================================================================
ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS cashea_surcharge_usd numeric NOT NULL DEFAULT 0;
