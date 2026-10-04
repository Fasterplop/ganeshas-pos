-- ============================================================================
-- Fase 2.1 — Puntos UNIFICADOS entre sucursales + registro del descuento
-- Aplicar en Supabase (SQL Editor). Todo aditivo, no borra nada.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Registrar el descuento por puntos aplicado en cada venta (para el historial).
--    Aditivo: las ventas existentes quedan en 0.
-- ----------------------------------------------------------------------------
ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS redemption_discount_usd numeric NOT NULL DEFAULT 0;


-- ----------------------------------------------------------------------------
-- 2. Saldo de puntos UNIFICADO (suma de TODAS las sucursales de un cliente):
--    get_global_points se define en db/whatsapp_marketing_optin.sql.
-- 3. Canje sobre el pool unificado: redeem_points_global se define en
--    db/role_consulta_02_rpc.sql (misma lógica, exige caja o dueño).
--    Cada función vive en un solo archivo, el de su versión vigente.
-- ----------------------------------------------------------------------------
