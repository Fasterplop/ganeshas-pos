-- ============================================================================
-- RLS: cerrar los huecos que quedan. (Diagnóstico del 2026-09-09.)
--
-- CORRECCIÓN IMPORTANTE sobre lo que se creía antes: la base **sí** tiene RLS.
-- Está activa en 11 de las 12 tablas de `public`, con políticas puestas hace
-- tiempo. El motivo es el event trigger `ensure_rls` → `rls_auto_enable()`:
-- se dispara en cada `CREATE TABLE` de `public` y activa RLS sola. Por eso NO
-- hace falta activar RLS "en todas las tablas": ya lo está.
--
-- El diagnóstico dejó tres cosas concretas:
--
--   A) `product_groups` es la ÚNICA tabla con RLS apagada, y es exactamente la
--      que reporta el correo de Supabase. Quedó así a propósito:
--      db/product_variants.sql corre un `DISABLE ROW LEVEL SECURITY` explícito
--      justo después de crearla, deshaciendo lo que hizo el event trigger.
--      Como `anon` tiene todos los permisos de tabla (default de Supabase),
--      hoy cualquiera con la clave anónima puede leer, insertar, modificar y
--      borrar los grupos de variantes sin iniciar sesión.
--
--   B) `customer_points_adjustments` tiene RLS activa y CERO políticas. Eso no
--      es "abierto", es lo contrario: nadie puede leerla desde la API. El
--      historial de ajustes de puntos en /customers viene vacío SIEMPRE, y sin
--      error visible (`fetchAdjustments` guarda [] y no muestra nada). Es un
--      bug en producción desde que se creó la tabla el 2026-09-08: el event
--      trigger le activó RLS y la migración nunca le puso políticas.
--
--   C) `products` tiene una política `DELETE ... USING (true)` para
--      `authenticated`: cualquier cajero logueado puede BORRAR productos de
--      verdad desde la API. La app solo hace borrado lógico (is_active=false)
--      y no ejecuta un solo `.delete()` sobre products.
--
-- Los bloques A y B son necesarios (uno tapa un hueco, el otro arregla un bug).
-- El C es endurecimiento: cambia permisos que hoy están de más.
--
-- Aplicar en el SQL Editor de Supabase, un bloque a la vez, probando la app
-- entre uno y otro. db/rls_02_rollback.sql deshace exactamente esto.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- BLOQUE A — product_groups: cerrar el acceso anónimo.  [NECESARIO]
--
-- Ojo con el orden: activar RLS sin políticas dejaría la tabla como
-- customer_points_adjustments (bloqueada para todos) y rompería las variantes
-- del inventario, que se leen y se escriben desde el navegador. Por eso las
-- políticas van ANTES del ENABLE, en la misma corrida.
--
-- Criterio: leer, cualquiera logueado (igual que `products`, el POS necesita
-- el catálogo completo). Escribir, solo quien ya puede gestionar inventario:
-- el owner o un cajero con permiso de reposición.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS product_groups_select_auth ON public.product_groups;
CREATE POLICY product_groups_select_auth ON public.product_groups
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS product_groups_insert_manage ON public.product_groups;
CREATE POLICY product_groups_insert_manage ON public.product_groups
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE p.id = auth.uid()
       AND (p.role::text = 'owner'
            OR COALESCE(p.can_restock_all, false)
            OR COALESCE(p.can_restock_local, false))
  ));

DROP POLICY IF EXISTS product_groups_update_manage ON public.product_groups;
CREATE POLICY product_groups_update_manage ON public.product_groups
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE p.id = auth.uid()
       AND (p.role::text = 'owner'
            OR COALESCE(p.can_restock_all, false)
            OR COALESCE(p.can_restock_local, false))
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE p.id = auth.uid()
       AND (p.role::text = 'owner'
            OR COALESCE(p.can_restock_all, false)
            OR COALESCE(p.can_restock_local, false))
  ));

-- Recién ahora. Sin política de DELETE: los grupos se dan de baja con
-- is_active = false (un UPDATE), igual que los productos.
ALTER TABLE public.product_groups ENABLE ROW LEVEL SECURITY;

-- PROBAR DESPUÉS DE ESTE BLOQUE: /inventory → ver un producto con variantes,
-- vincular un producto a un padre, renombrar un padre, crear un producto nuevo
-- con variantes. Y en /pos, buscar y vender una variante.


-- ----------------------------------------------------------------------------
-- BLOQUE B — customer_points_adjustments: destrabar la lectura.  [NECESARIO]
--
-- La tabla ya tiene RLS activa; lo que falta es la política. Solo el owner:
-- es quien ve ese historial en /customers (la app ni siquiera lo consulta para
-- un cajero). Escribir sigue siendo exclusivo del RPC adjust_customer_points,
-- que es SECURITY DEFINER y no pasa por estas políticas.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS cpa_select_owner ON public.customer_points_adjustments;
CREATE POLICY cpa_select_owner ON public.customer_points_adjustments
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE p.id = auth.uid() AND p.role::text = 'owner'
  ));

-- PROBAR DESPUÉS DE ESTE BLOQUE: /customers como owner → abrir un cliente que
-- tenga ajustes manuales de puntos. El historial ahora debe aparecer (antes
-- salía vacío siempre). Si el cliente nunca tuvo ajustes, hacer uno de +1 y
-- verificar que se liste.


-- ----------------------------------------------------------------------------
-- BLOQUE C — quitarle a los cajeros el borrado real de productos. [RECOMENDADO]
--
-- Hoy existe `products: Permitir eliminar productos — DELETE, authenticated,
-- USING (true)`. La app nunca borra un producto: lo desactiva. Con esa política
-- puesta, un cajero logueado puede vaciar el catálogo con una llamada a la API.
-- Quitarla no cambia nada de lo que hace el POS.
--
-- (Se puede aplicar aparte, más tarde. No es lo que reporta Supabase.)
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Permitir eliminar productos" ON public.products;

-- PROBAR DESPUÉS DE ESTE BLOQUE: /inventory → eliminar un producto (debe
-- seguir funcionando: es un UPDATE is_active=false, no un DELETE).


-- ----------------------------------------------------------------------------
-- VERIFICACIÓN. Devuelve una sola celda JSON (el editor de Supabase solo
-- muestra el último SELECT). `product_groups` debe quedar en rls_activa=true
-- con 3 políticas, y `customer_points_adjustments` con 1.
-- ----------------------------------------------------------------------------
SELECT jsonb_pretty(jsonb_agg(t ORDER BY t->>'tabla'))
FROM (
  SELECT jsonb_build_object(
           'tabla',      c.relname,
           'rls_activa', c.relrowsecurity,
           'politicas',  (SELECT COUNT(*) FROM pg_policies p
                           WHERE p.schemaname = 'public' AND p.tablename = c.relname)
         ) AS t
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
) s;
