-- ============================================================================
-- Correccion: el recargo del 5% no era para Cashea, sino para Punto de Venta.
-- Renombra la columna agregada en db/cashea_surcharge.sql (mismo significado:
-- monto en USD del recargo ya cobrado, 0 si no aplico). Verificado antes de
-- aplicar este cambio que NINGUNA venta real todavia tenia ese campo > 0,
-- asi que no hay datos que reinterpretar.
-- Aplicar en el SQL Editor de Supabase. Renombrado, no destructivo.
-- ============================================================================
ALTER TABLE public.sales
  RENAME COLUMN cashea_surcharge_usd TO punto_de_venta_surcharge_usd;
