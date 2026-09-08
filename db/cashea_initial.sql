-- ============================================================================
-- Inicial (en tienda) de Cashea: monto en USD que el cliente paga en el
-- mostrador como cuota inicial cuando la venta va (total o parcialmente) por
-- Cashea. Cashea le paga al comercio el resto.
--
-- El monto del método Cashea sigue guardando su valor COMPLETO (total_amount
-- en pago simple, payment_amount_1/2 en pago dividido); esta columna solo
-- indica cuánto de ese monto ya entró en caja. 0 = no aplica (las ventas
-- anteriores a esta migración quedan en 0 sin reescribir la tabla).
--   Restante por Cashea (lo que Cashea procesa) = monto Cashea - cashea_initial_usd
--
-- El POS y el dashboard degradan si la columna todavía no existe (reintentan
-- sin ella), pero mientras no se aplique, la inicial de esas ventas se pierde.
-- Aplicar en el SQL Editor de Supabase. Aditivo, no destructivo.
-- ============================================================================
ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS cashea_initial_usd numeric NOT NULL DEFAULT 0;
