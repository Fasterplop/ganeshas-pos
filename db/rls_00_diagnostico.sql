-- ============================================================================
-- DIAGNÓSTICO de Row Level Security (RLS). NO cambia nada: solo consulta.
--
-- Correr esto PRIMERO, en el SQL Editor de Supabase, y guardar el resultado.
-- Es lo que hay que mirar antes de aplicar db/rls_01_activar.sql, porque ese
-- archivo solo debe correrse sobre las tablas que aquí salgan con
-- rls_activa = false. Si una tabla ya tiene políticas propias, hay que leerlas
-- antes de agregar otras: dos políticas permisivas se SUMAN (OR), así que una
-- política nueva y laxa puede aflojar una restrictiva que ya existía.
--
-- OJO: el SQL Editor de Supabase muestra SOLO el resultado del último SELECT
-- de un script. Por eso todo esto es UNA sola consulta que devuelve un JSON
-- con las cinco secciones: se copia la celda entera y se lee de corrido.
-- ============================================================================

SELECT jsonb_pretty(jsonb_build_object(

  -- 1) ¿Qué tablas de `public` tienen RLS activa?
  --    Las que salgan con rls_activa = false son EXACTAMENTE las que Supabase
  --    reporta en el correo ("Table publicly accessible / rls_disabled_in_public").
  'tablas', (
    SELECT jsonb_agg(t ORDER BY t->>'tabla')
    FROM (
      SELECT jsonb_build_object(
               'tabla',      c.relname,
               'rls_activa', c.relrowsecurity,
               'rls_forzada', c.relforcerowsecurity,
               'politicas',  (SELECT COUNT(*) FROM pg_policies p
                               WHERE p.schemaname = 'public' AND p.tablename = c.relname)
             ) AS t
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
    ) s
  ),

  -- 2) Políticas que YA existen (para no pisarlas).
  'politicas', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'tabla',      tablename,
             'politica',   policyname,
             'cmd',        cmd,
             'roles',      roles,
             'using',      qual,
             'with_check', with_check
           ) ORDER BY tablename, policyname)
    FROM pg_policies WHERE schemaname = 'public'
  ), '[]'::jsonb),

  -- 3) Quién puede hacer qué HOY a nivel de permisos de tabla.
  --    Con RLS apagada, esto es lo único que separa a la tienda de internet:
  --    si `anon` aparece con SELECT/INSERT/UPDATE/DELETE, cualquiera con la URL
  --    del proyecto y la clave anónima (ambas viajan en el JavaScript del POS,
  --    son públicas por diseño) puede leer y borrar esa tabla.
  'permisos', (
    SELECT jsonb_agg(jsonb_build_object(
             'tabla',    table_name,
             'rol',      grantee,
             'permisos', permisos
           ) ORDER BY table_name, grantee)
    FROM (
      SELECT table_name, grantee,
             string_agg(privilege_type, ', ' ORDER BY privilege_type) AS permisos
      FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
      GROUP BY table_name, grantee
    ) g
  ),

  -- 4) Funciones SECURITY DEFINER (los RPC del POS).
  --    Estas siguen funcionando igual con RLS activa: corren como su dueño y no
  --    las frena ninguna política. Por eso activar RLS no rompe el checkout,
  --    ni los canjes de puntos, ni los cambios de producto, ni la reposición.
  'funciones', (
    SELECT jsonb_agg(jsonb_build_object('funcion', p.proname, 'security_definer', p.prosecdef)
                     ORDER BY p.prosecdef DESC, p.proname)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
  ),

  -- 5) EVENT TRIGGERS. No son los mismos que los triggers de tabla y NO salen
  --    en Database > Triggers del panel de Supabase: se disparan con un
  --    CREATE TABLE, no con un INSERT. Aquí es donde aparecería algo como
  --    `rls_auto_enable` (una función que activa RLS sola en cada tabla nueva).
  'event_triggers', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'nombre',   e.evtname,
             'evento',   e.evtevent,
             'activo',   e.evtenabled,
             'funcion',  p.proname
           ) ORDER BY e.evtname)
    FROM pg_event_trigger e JOIN pg_proc p ON p.oid = e.evtfoid
  ), '[]'::jsonb)

)) AS diagnostico;


-- ----------------------------------------------------------------------------
-- Extra (correr aparte, seleccionando solo estas líneas): qué hace exactamente
-- la función rls_auto_enable, si es que existe.
-- ----------------------------------------------------------------------------
-- SELECT pg_get_functiondef(p.oid)
-- FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname = 'public' AND p.proname = 'rls_auto_enable';
