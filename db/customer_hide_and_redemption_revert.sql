-- ============================================================================
-- Cambios:
--  1) Ocultar clientes en /customers (soft-delete visual, owner).
--  2) Guardar los puntos canjeados por venta, para poder reintegrarlos al anular.
--  3) delete_sale_and_revert: al anular, reintegra los puntos canjeados de la venta.
-- Aplicar en el SQL Editor de Supabase. Todo aditivo, no borra nada.
-- ============================================================================

-- 1. Bandera para ocultar clientes de la lista (los datos se conservan).
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS is_hidden boolean NOT NULL DEFAULT false;

-- 2. Puntos consumidos por canje en cada venta (0 si no hubo canje).
ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS redemption_points integer NOT NULL DEFAULT 0;

-- 3. Anulación de venta: delete_sale_and_revert se define en
--    db/exchange_02_schema_and_rpc.sql (reintegra los puntos canjeados, exige
--    owner y rechaza anular una venta con cambios).
