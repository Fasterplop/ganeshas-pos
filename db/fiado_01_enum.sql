-- ============================================================================
-- Fiado (1 de 2): el método de pago 'fiado'.
--
-- Va en un archivo aparte porque Postgres no deja USAR un valor nuevo de un
-- enum en la misma transacción que lo crea, y db/fiado_02_schema.sql lo usa
-- (índice parcial, CHECK y funciones).
--
-- CÓMO APLICAR: en el SQL Editor de Supabase, ESTE archivo primero y solo, y
-- después db/fiado_02_schema.sql. Es idempotente.
-- Verificar: SELECT enum_range(NULL::public.payment_method_type);
-- ============================================================================

ALTER TYPE public.payment_method_type ADD VALUE IF NOT EXISTS 'fiado';

NOTIFY pgrst, 'reload schema';
