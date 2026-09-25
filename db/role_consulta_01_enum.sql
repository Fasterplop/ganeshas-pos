-- ============================================================================
-- Rol nuevo: 'consulta' — solo puede entrar a /consultar-precio.
--
-- POR QUÉ: la persona que anda con el teléfono escáner en el piso de venta no
-- necesita (ni debería tener) la caja, el inventario, los clientes ni los
-- reportes. Hasta ahora solo existían 'owner' y 'cashier', y un empleado de
-- piso tenía que entrar como cajero, con acceso a todo lo del cajero.
--
-- El tipo se llama `public.profile_role` y hoy vale ('owner','cashier'). No se
-- creó desde este repo (venía de antes), por eso no hay ningún CREATE TYPE en
-- db/: esto solo le AGREGA un valor.
--
-- ⚠️ ESTE ARCHIVO VA SOLO, EN SU PROPIA EJECUCIÓN.
--    Postgres no deja USAR un valor de enum en la misma transacción en la que
--    se agrega. Por eso este script no hace nada más, y el endurecimiento de
--    los RPC va aparte, en db/role_consulta_02_rpc.sql. Es la misma razón por
--    la que db/exchange_01_payment_method_cambio.sql también va solo.
--
-- ⚠️ UN VALOR DE ENUM NO SE PUEDE BORRAR DESPUÉS. Si algún día sobra, se deja
--    de usar (ningún perfil con ese rol), pero el valor se queda en el tipo.
--
-- TODO ADITIVO: no toca ninguna fila. Los perfiles existentes siguen siendo
-- 'owner' o 'cashier' y se comportan exactamente igual.
--
-- Aplicar en el SQL Editor de Supabase, SOLO este archivo, y después
-- db/role_consulta_02_rpc.sql.
-- ============================================================================

ALTER TYPE public.profile_role ADD VALUE IF NOT EXISTS 'consulta';

-- ============================================================================
-- VERIFICACIÓN: debe listar owner, cashier y consulta.
-- ============================================================================
SELECT jsonb_pretty(jsonb_build_object(
  'tipo', 'public.profile_role',
  'valores', (
    SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder)
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' AND t.typname = 'profile_role'
  ),
  'perfiles_por_rol', (
    SELECT jsonb_object_agg(rol, cuantos)
      FROM (SELECT role::text AS rol, COUNT(*) AS cuantos
              FROM public.profiles GROUP BY 1) s
  )
));
