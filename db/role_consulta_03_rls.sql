-- ============================================================================
-- Rol 'consulta': cerrarle las TABLAS, no solo las pantallas y los RPC.
--
-- QUÉ DESTAPÓ EL DIAGNÓSTICO (db/rls_00_diagnostico.sql, 2026-09-24).
-- Las políticas del núcleo del POS son, en la práctica, "cualquiera que haya
-- iniciado sesión puede hacer cualquier cosa":
--
--   products      SELECT true · INSERT true · UPDATE true   (a authenticated)
--   customers     SELECT true · INSERT true · UPDATE true   (+ una capa por
--                 sucursal que NO restringe: dos políticas permisivas se SUMAN
--                 con OR, así que manda la laxa)
--   sales         SELECT true · INSERT true
--   sale_items    SELECT true · INSERT true
--   store_stock   SELECT true · UPDATE/INSERT por sucursal
--
-- Eso ya era así para los cajeros y no lo cambia este archivo. Pero el rol
-- 'consulta' se creó para que SOLO viera precios, y con esas políticas podía,
-- desde la consola del navegador y con su propia sesión: leer y modificar
-- todos los clientes, leer todas las ventas, insertar ventas, cambiar el
-- PRECIO de cualquier producto y mover el stock de su tienda. La pantalla se
-- la cerramos con los guards y los RPC con el chequeo de rol; faltaba la
-- puerta de la base.
--
-- CÓMO SE ARREGLA SIN TOCAR LO QUE FUNCIONA.
-- Con políticas RESTRICTIVE. Las permisivas se suman con OR; las restrictivas
-- se multiplican con AND. Así no hay que reescribir ni una sola política
-- existente —que es justo lo que podría dejar a la caja sin poder vender—:
-- se agrega una condición extra que solo puede QUITAR permisos, y solo se los
-- quita a 'consulta'. Para 'owner' y 'cashier' la condición da siempre true y
-- todo sigue exactamente igual.
--
-- Los RPC `SECURITY DEFINER` (register_exchange, restock_stock, set_bcv_rate,
-- redeem_points_global…) corren como su dueño y NO pasan por estas políticas,
-- así que nada de lo que hoy funciona por RPC se ve afectado. La `service_role`
-- (server actions, n8n, el conector de ChatGPT) tampoco: ignora la RLS.
--
-- QUÉ SIGUE PUDIENDO HACER 'consulta' (lo que /consultar-precio necesita):
--   leer products, v_products_priced, product_offers, product_groups,
--   store_stock, stores, su propio profile y bcv_rates; y cargar la tasa del
--   día por el RPC set_bcv_rate.
--
-- TODO ADITIVO: solo agrega una función y cinco políticas nuevas. No modifica
-- ni borra ninguna política existente. El rollback está al final.
--
-- Aplicar en el SQL Editor de Supabase DESPUÉS de role_consulta_01 y 02.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. ¿Quien llama es del rol 'consulta'?
--
--    SECURITY DEFINER por la misma razón que `fin_is_owner()`: la política no
--    puede depender de que el usuario tenga permiso de leer `profiles`.
--    STABLE para que Postgres la evalúe una vez por consulta y no por fila.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_consulta()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE p.id = auth.uid() AND p.role::text = 'consulta'
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_consulta() TO authenticated;

-- ----------------------------------------------------------------------------
-- 2. Tablas que el rol 'consulta' no necesita NI PARA LEER.
--
--    Un empleado que solo dice precios no tiene por qué ver la cédula, el
--    teléfono y lo que gastó cada cliente, ni el historial de ventas.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "consulta_sin_acceso" ON public.customers;
CREATE POLICY "consulta_sin_acceso" ON public.customers
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT public.is_consulta())
  WITH CHECK (NOT public.is_consulta());

DROP POLICY IF EXISTS "consulta_sin_acceso" ON public.sales;
CREATE POLICY "consulta_sin_acceso" ON public.sales
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT public.is_consulta())
  WITH CHECK (NOT public.is_consulta());

DROP POLICY IF EXISTS "consulta_sin_acceso" ON public.sale_items;
CREATE POLICY "consulta_sin_acceso" ON public.sale_items
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT public.is_consulta())
  WITH CHECK (NOT public.is_consulta());

-- ----------------------------------------------------------------------------
-- 3. Tablas que SÍ necesita leer, pero nunca escribir.
--
--    Van tres políticas por tabla (INSERT / UPDATE / DELETE) y no un FOR ALL,
--    porque un FOR ALL restrictivo también le cortaría el SELECT, que es
--    exactamente lo que la pantalla necesita.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "consulta_no_inserta" ON public.products;
CREATE POLICY "consulta_no_inserta" ON public.products
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_consulta());

DROP POLICY IF EXISTS "consulta_no_actualiza" ON public.products;
CREATE POLICY "consulta_no_actualiza" ON public.products
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_consulta())
  WITH CHECK (NOT public.is_consulta());

DROP POLICY IF EXISTS "consulta_no_borra" ON public.products;
CREATE POLICY "consulta_no_borra" ON public.products
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_consulta());

DROP POLICY IF EXISTS "consulta_no_inserta" ON public.store_stock;
CREATE POLICY "consulta_no_inserta" ON public.store_stock
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_consulta());

DROP POLICY IF EXISTS "consulta_no_actualiza" ON public.store_stock;
CREATE POLICY "consulta_no_actualiza" ON public.store_stock
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_consulta())
  WITH CHECK (NOT public.is_consulta());

DROP POLICY IF EXISTS "consulta_no_borra" ON public.store_stock;
CREATE POLICY "consulta_no_borra" ON public.store_stock
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_consulta());

-- ============================================================================
-- PROBAR DESPUÉS DE APLICAR
--
-- 1) Con la sesión del DUEÑO y con la de un CAJERO, en el POS de verdad:
--    registrar una venta, cobrarla, editar un cliente, reponer stock y
--    cambiar un precio. TIENE QUE FUNCIONAR IGUAL QUE ANTES. Si algo falla,
--    correr el rollback de abajo: estas políticas no arreglan nada urgente,
--    y dejar la caja sin vender es mucho peor.
--
-- 2) Con la sesión de un usuario 'consulta', desde la consola del navegador:
--      await supabase.from('customers').select('*')        -> []
--      await supabase.from('sales').select('*')            -> []
--      await supabase.from('products').update({price: 1}).eq('id', '<uuid>')
--                                                          -> 0 filas / error
--      await supabase.from('products').select('*').limit(1)-> SÍ devuelve
--    Ojo: una LECTURA bloqueada por RLS no da error, viene como lista vacía.
--
-- 3) /consultar-precio con ese mismo usuario: tiene que seguir mostrando
--    precio, stock y variantes.
-- ============================================================================

-- ============================================================================
-- VERIFICACIÓN
-- ============================================================================
SELECT jsonb_pretty(jsonb_build_object(
  'funcion_is_consulta', EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'is_consulta'
  ),
  'politicas_restrictivas', (
    SELECT jsonb_agg(jsonb_build_object('tabla', tablename, 'politica', policyname, 'cmd', cmd)
                     ORDER BY tablename, policyname)
      FROM pg_policies
     WHERE schemaname = 'public' AND permissive = 'RESTRICTIVE'
  ),
  'deben_ser_9', (
    SELECT COUNT(*) FROM pg_policies
     WHERE schemaname = 'public' AND permissive = 'RESTRICTIVE'
  )
));

-- ============================================================================
-- ROLLBACK (correr solo si algo se rompió)
--
--   DROP POLICY IF EXISTS "consulta_sin_acceso"   ON public.customers;
--   DROP POLICY IF EXISTS "consulta_sin_acceso"   ON public.sales;
--   DROP POLICY IF EXISTS "consulta_sin_acceso"   ON public.sale_items;
--   DROP POLICY IF EXISTS "consulta_no_inserta"   ON public.products;
--   DROP POLICY IF EXISTS "consulta_no_actualiza" ON public.products;
--   DROP POLICY IF EXISTS "consulta_no_borra"     ON public.products;
--   DROP POLICY IF EXISTS "consulta_no_inserta"   ON public.store_stock;
--   DROP POLICY IF EXISTS "consulta_no_actualiza" ON public.store_stock;
--   DROP POLICY IF EXISTS "consulta_no_borra"     ON public.store_stock;
--   DROP FUNCTION IF EXISTS public.is_consulta();
-- ============================================================================
