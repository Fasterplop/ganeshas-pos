-- ============================================================================
-- ROLLBACK de db/rls_01_activar.sql. Deja la base como estaba antes de correrlo.
--
-- Correr esto SOLO si algo de la app deja de funcionar y hace falta que la
-- tienda siga vendiendo mientras se ajustan las políticas. Cada bloque se
-- deshace por separado: si solo falla una pantalla, correr únicamente el
-- bloque correspondiente y dejar los otros.
--
-- OJO: esto NO apaga la RLS de las demás tablas. La RLS del proyecto es previa
-- y correcta; rls_01 solo agregó lo que faltaba. Apagarla en bloque dejaría la
-- base abierta a internet.
-- ============================================================================


-- --- Deshacer BLOQUE A (product_groups) ------------------------------------
-- Vuelve al estado que dejó db/product_variants.sql: RLS apagada.
-- Con esto la tabla queda otra vez accesible con la clave anónima.
ALTER TABLE public.product_groups DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS product_groups_select_auth   ON public.product_groups;
DROP POLICY IF EXISTS product_groups_insert_manage ON public.product_groups;
DROP POLICY IF EXISTS product_groups_update_manage ON public.product_groups;


-- --- Deshacer BLOQUE B (customer_points_adjustments) ------------------------
-- Quitar esta política devuelve el bug: el historial de ajustes de puntos
-- vuelve a salir vacío en /customers. Casi nunca es lo que se quiere.
DROP POLICY IF EXISTS cpa_select_owner ON public.customer_points_adjustments;


-- --- Deshacer BLOQUE C (borrado real de productos) --------------------------
-- Devuelve a cualquier usuario logueado el permiso de BORRAR productos por API.
DROP POLICY IF EXISTS "Permitir eliminar productos" ON public.products;
CREATE POLICY "Permitir eliminar productos" ON public.products
  FOR DELETE TO authenticated
  USING (true);
