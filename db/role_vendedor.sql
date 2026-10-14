-- ============================================================================
-- Rol nuevo: 'vendedor' — consulta precios y cobra en la caja. Nada más.
--
-- POR QUÉ. Hacía falta alguien que, además de decir precios con el teléfono,
-- pudiera cobrar, sin darle todo lo del cajero (inventario, clientes,
-- etiquetas, reportes). El rol 'consulta' NO se toca: sigue entrando solo a
-- /consultar-precio, con sus nueve políticas de db/role_consulta_03_rls.sql.
-- 'vendedor' es un cuarto valor del enum public.profile_role.
--
-- POR QUÉ NO ALCANZA CON AGREGAR EL VALOR. En esta base un rol sin políticas
-- propias queda, a nivel de tablas, igual que un cajero: las políticas
-- permisivas de products, customers, sales y sale_items son USING (true) para
-- cualquiera con sesión. Sin las restricciones de este archivo, un 'vendedor'
-- podría cambiar el precio de cualquier producto desde la consola del
-- navegador. Y al revés: los tres RPC de la caja tienen la lista de roles
-- escrita adentro y lo rechazarían.
--
-- QUÉ PUEDE HACER 'vendedor' (lo que hace la pantalla de la caja, y nada más):
--   customers    leer; crear y editar clientes DE SU TIENDA.
--   sales        leer; insertar ventas de SU tienda y a SU nombre (cashier_id).
--   sale_items   leer; insertar líneas de ventas que registró él.
--   store_stock  leer; insertar y actualizar el de su tienda (lo limita la
--                política permisiva de siempre, store_id = get_user_store()).
--   RPC          redeem_points_global (canje de puntos), register_exchange
--                (cambio de producto) y transfer_stock (traer un producto de
--                la otra tienda). Los dos últimos le exigen que la tienda sea
--                la suya, igual que a un cajero. set_bcv_rate ya admite a
--                cualquiera con sesión.
--   LEER queda como para un cajero: la caja muestra el nombre y los puntos del
--   cliente, y el cambio de producto busca sus ventas.
--
-- QUÉ NO PUEDE: crear, editar ni borrar productos (precios incluidos), borrar
-- stock, editar o borrar ventas y líneas, borrar clientes, escribir fuera de
-- su tienda, mark_label_printed, leer el historial de stock_transfers, ni nada
-- de lo que ya era solo del dueño. Inventario, clientes, etiquetas y reportes
-- se le cierran además con los guards de ruta.
--
-- CÓMO, SIN TOCAR A NADIE MÁS. Trece políticas RESTRICTIVE nuevas cuya
-- condición empieza por `NOT is_vendedor() OR …`: para 'owner', 'cashier' y
-- 'consulta' dan siempre true. No se modifica ni se borra ninguna política
-- existente; lo único que ya existía y cambia es la lista de roles de los tres
-- RPC, que pasa de ('owner', 'cashier') a ('owner', 'cashier', 'vendedor').
--
-- LOS TRES RPC NO SE REDEFINEN ACÁ (cada función vive en un solo archivo). El
-- paso 7 toma la función tal como está HOY en la base y le cambia únicamente
-- esa lista. Así no se pisa nada si la base y db/ difirieran, y todo entra en
-- una sola transacción con las políticas. Los archivos donde viven
-- (role_consulta_02_rpc, exchange_03_discount, transfer_01_stock_transfers) ya
-- traen la lista nueva: NO hace falta volver a correrlos.
--
-- EL VALOR DEL ENUM VA EN ESTE MISMO ARCHIVO, a diferencia de 'consulta' (que
-- tuvo su role_consulta_01_enum.sql aparte). Postgres no deja USAR un valor de
-- enum en la transacción que lo agrega, pero acá no se usa: todo compara
-- `role::text`. Y conviene que vaya junto: el rol nace con sus restricciones,
-- no existe ni un momento en que se pueda crear un 'vendedor' sin ellas.
--
-- ⚠️ UN VALOR DE ENUM NO SE PUEDE BORRAR DESPUÉS. Si algún día sobra, se deja
--    de usar (ningún perfil con ese rol), pero el valor se queda en el tipo.
--
-- CÓMO APLICAR: en el SQL Editor de Supabase, el archivo ENTERO. El editor lo
-- corre en una sola transacción: si algo falla no queda nada a medias.
--
-- ⚠️ CON LAS TIENDAS CERRADAS y sin las pestañas de Advisors ni del Table
--    Editor abiertas: CREATE POLICY pide el candado más fuerte sobre products,
--    customers, sales, sale_items y store_stock. Si da "deadlock detected" o
--    "lock timeout", volver a correrlo (ver la cabecera de role_consulta_03).
--
-- ORDEN CON EL FRONT: primero este archivo, después el deploy. Antes de este
-- archivo nadie puede tener el rol; el front que lo ofrece en /users no debe
-- llegar antes, o crear el usuario falla a mitad de camino.
--
-- Es idempotente: se puede volver a correr. El rollback está al final.
-- ============================================================================

SET lock_timeout = '5s';

-- ----------------------------------------------------------------------------
-- 0. Comprobación previa. NO cambia nada.
--
--    El cobro descuenta el stock con un UPDATE desde el navegador, y ese
--    UPDATE lo deja pasar la política permisiva de store_stock, que compara
--    con get_user_store(). El cobro no revisa si ese UPDATE falló: si
--    get_user_store() no devolviera la tienda de quien cobra, la venta se
--    registraría sin bajar el inventario y nadie se enteraría.
--
--    get_user_store() se creó a mano y no está en db/. Todavía no hay ningún
--    'vendedor' con quien probarla, así que se le pregunta haciéndose pasar
--    por cada usuario activo que NO es dueño (cajeros y 'consulta'): tiene que
--    devolver su tienda asignada sin importar el rol. Si no coincide, el
--    archivo entero se detiene y no se aplica nada. La verificación del final
--    imprime además el cuerpo de la función.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  r       record;
  v_store uuid;
BEGIN
  FOR r IN
    SELECT id, role::text AS rol, assigned_store_id
      FROM public.profiles
     WHERE role::text <> 'owner'
       AND COALESCE(is_active, true)
       AND assigned_store_id IS NOT NULL
  LOOP
    PERFORM set_config('request.jwt.claim.sub', r.id::text, true);
    PERFORM set_config('request.jwt.claims',
                       jsonb_build_object('sub', r.id, 'role', 'authenticated')::text, true);

    -- Si la sesión no se deja simular desde acá, no se puede comprobar: se
    -- sigue, y queda el cuerpo de la función en la verificación para leerlo.
    CONTINUE WHEN auth.uid() IS DISTINCT FROM r.id;

    v_store := public.get_user_store();
    IF v_store IS DISTINCT FROM r.assigned_store_id THEN
      RAISE EXCEPTION 'GET_USER_STORE_DEPENDE_DEL_ROL: para un usuario % devuelve % y su tienda es %. No se aplicó nada.',
        r.rol, v_store, r.assigned_store_id;
    END IF;
  END LOOP;

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
END $$;

-- ----------------------------------------------------------------------------
-- 1. El valor nuevo del enum. No toca ninguna fila: los perfiles existentes
--    siguen con su rol.
-- ----------------------------------------------------------------------------
ALTER TYPE public.profile_role ADD VALUE IF NOT EXISTS 'vendedor';

-- ----------------------------------------------------------------------------
-- 2. ¿Quien llama es del rol 'vendedor'?
--    SECURITY DEFINER y STABLE por lo mismo que is_consulta(): la política no
--    puede depender de que el usuario tenga permiso de leer `profiles`.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_vendedor()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE p.id = auth.uid() AND p.role::text = 'vendedor'
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_vendedor() TO authenticated;

-- ----------------------------------------------------------------------------
-- 3. Productos: los lee, nunca los escribe. (Tres políticas y no un FOR ALL,
--    porque un FOR ALL restrictivo también le cortaría el SELECT.)
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "vendedor_no_inserta" ON public.products;
CREATE POLICY "vendedor_no_inserta" ON public.products
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_vendedor());

DROP POLICY IF EXISTS "vendedor_no_actualiza" ON public.products;
CREATE POLICY "vendedor_no_actualiza" ON public.products
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_vendedor())
  WITH CHECK (NOT public.is_vendedor());

DROP POLICY IF EXISTS "vendedor_no_borra" ON public.products;
CREATE POLICY "vendedor_no_borra" ON public.products
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_vendedor());

-- ----------------------------------------------------------------------------
-- 4. Stock: no lo borra. Insertarlo y actualizarlo sí (el cobro descuenta), y
--    solo el de su tienda: eso ya lo hace la política permisiva de siempre.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "vendedor_no_borra" ON public.store_stock;
CREATE POLICY "vendedor_no_borra" ON public.store_stock
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_vendedor());

-- ----------------------------------------------------------------------------
-- 5. Clientes: leer como un cajero; crear y editar solo los de su tienda.
--    (El saldo de puntos unificado lo da get_global_points, que es un RPC.)
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "vendedor_inserta_en_su_tienda" ON public.customers;
CREATE POLICY "vendedor_inserta_en_su_tienda" ON public.customers
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_vendedor() OR store_id = public.get_user_store());

DROP POLICY IF EXISTS "vendedor_actualiza_en_su_tienda" ON public.customers;
CREATE POLICY "vendedor_actualiza_en_su_tienda" ON public.customers
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_vendedor() OR store_id = public.get_user_store())
  WITH CHECK (NOT public.is_vendedor() OR store_id = public.get_user_store());

DROP POLICY IF EXISTS "vendedor_no_borra" ON public.customers;
CREATE POLICY "vendedor_no_borra" ON public.customers
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_vendedor());

-- ----------------------------------------------------------------------------
-- 6. Ventas y sus líneas: leer como un cajero; insertar solo ventas de su
--    tienda y a su nombre, y líneas solo en ventas suyas. Una venta no se
--    edita ni se borra desde el navegador (anular es un RPC del dueño).
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "vendedor_inserta_lo_suyo" ON public.sales;
CREATE POLICY "vendedor_inserta_lo_suyo" ON public.sales
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (
    NOT public.is_vendedor()
    OR (store_id = public.get_user_store() AND cashier_id = auth.uid())
  );

DROP POLICY IF EXISTS "vendedor_no_actualiza" ON public.sales;
CREATE POLICY "vendedor_no_actualiza" ON public.sales
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_vendedor())
  WITH CHECK (NOT public.is_vendedor());

DROP POLICY IF EXISTS "vendedor_no_borra" ON public.sales;
CREATE POLICY "vendedor_no_borra" ON public.sales
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_vendedor());

DROP POLICY IF EXISTS "vendedor_inserta_lo_suyo" ON public.sale_items;
CREATE POLICY "vendedor_inserta_lo_suyo" ON public.sale_items
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (
    NOT public.is_vendedor()
    OR EXISTS (
      SELECT 1 FROM public.sales s
       WHERE s.id = sale_items.sale_id AND s.cashier_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "vendedor_no_actualiza" ON public.sale_items;
CREATE POLICY "vendedor_no_actualiza" ON public.sale_items
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_vendedor())
  WITH CHECK (NOT public.is_vendedor());

DROP POLICY IF EXISTS "vendedor_no_borra" ON public.sale_items;
CREATE POLICY "vendedor_no_borra" ON public.sale_items
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_vendedor());

-- ----------------------------------------------------------------------------
-- 7. Los tres RPC de la caja: sumar 'vendedor' a la lista de roles.
--
--    Se parte de la función que está en la base (pg_get_functiondef) y se
--    cambia solo ese texto. Si una función no tiene el chequeo exactamente
--    una vez —o no son tres funciones— se detiene todo sin aplicar nada.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  r     record;
  v_old CONSTANT text := 'NOT IN (''owner'', ''cashier'')';
  v_new CONSTANT text := 'NOT IN (''owner'', ''cashier'', ''vendedor'')';
  v_n   integer := 0;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, p.prosrc
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('redeem_points_global', 'register_exchange', 'transfer_stock')
  LOOP
    v_n := v_n + 1;

    -- Ya la tiene (el archivo se corrió antes, o se corrió el de la función).
    CONTINUE WHEN position(v_new IN r.prosrc) > 0;

    IF (length(r.prosrc) - length(replace(r.prosrc, v_old, ''))) / length(v_old) <> 1 THEN
      RAISE EXCEPTION 'CHEQUEO_DE_ROL_INESPERADO: % no tiene el chequeo de rol una sola vez. No se aplicó nada.', r.proname;
    END IF;

    EXECUTE replace(pg_get_functiondef(r.oid), v_old, v_new);
  END LOOP;

  IF v_n <> 3 THEN
    RAISE EXCEPTION 'FUNCIONES_INESPERADAS: se esperaban 3 funciones y hay %. No se aplicó nada.', v_n;
  END IF;
END $$;

-- ============================================================================
-- PROBAR DESPUÉS DE APLICAR (con el front que ofrece el rol ya desplegado)
--
-- 1) Con un CAJERO y con el DUEÑO: una venta normal, como siempre. Con el
--    usuario 'consulta': sigue viendo solo Consultar precio.
--
-- 2) Crear un usuario Vendedor en /users y, con él, hacer en la caja una
--    venta con cliente (cédula y nombre). Después mirar, con otro usuario,
--    en Inventario que el producto bajó una unidad y en Clientes que sumó
--    los puntos. ESTE PASO IMPORTA: es la única prueba de get_user_store()
--    con un 'vendedor' de verdad.
--
-- 3) Con el Vendedor: /inventory, /customers, /dashboard y /labels escritos
--    a mano en la barra lo devuelven a /consultar-precio.
-- ============================================================================

-- ============================================================================
-- VERIFICACIÓN. Tiene que dar:
--   valores_del_rol                 incluye "vendedor"
--   politicas_de_vendedor_son_13  = 13
--   politicas_de_consulta_son_9   = 9    (no se tocaron)
--   rpc_abiertos_a_vendedor       = las tres en true
--   etiquetas_sigue_cerrada       = true
-- El resto deja constancia de cómo está la base: perfiles por rol, las
-- políticas permisivas de las cinco tablas y get_user_store (no están en db/).
-- ============================================================================
SELECT jsonb_pretty(jsonb_build_object(
  'valores_del_rol', (
    SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder)
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' AND t.typname = 'profile_role'
  ),
  'politicas_de_vendedor_son_13', (
    SELECT COUNT(*) FROM pg_policies
     WHERE schemaname = 'public' AND permissive = 'RESTRICTIVE' AND policyname LIKE 'vendedor\_%'
  ),
  'politicas_de_consulta_son_9', (
    SELECT COUNT(*) FROM pg_policies
     WHERE schemaname = 'public' AND permissive = 'RESTRICTIVE' AND policyname LIKE 'consulta\_%'
  ),
  'restrictivas', (
    SELECT jsonb_agg(tablename || ' · ' || cmd || ' · ' || policyname ORDER BY tablename, cmd, policyname)
      FROM pg_policies
     WHERE schemaname = 'public' AND permissive = 'RESTRICTIVE'
  ),
  'rpc_abiertos_a_vendedor', (
    SELECT jsonb_object_agg(p.proname, p.prosrc LIKE '%NOT IN (''owner'', ''cashier'', ''vendedor'')%')
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('redeem_points_global', 'register_exchange', 'transfer_stock')
  ),
  'etiquetas_sigue_cerrada', (
    SELECT bool_and(p.prosrc LIKE '%NOT IN (''owner'', ''cashier'')%')
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'mark_label_printed'
  ),
  'perfiles_por_rol', (
    SELECT jsonb_object_agg(rol, cuantos)
      FROM (SELECT role::text AS rol, COUNT(*) AS cuantos
              FROM public.profiles GROUP BY 1) s
  ),
  'permisivas', (
    SELECT jsonb_agg(tablename || ' · ' || cmd || ' · ' || policyname
                     || ' · USING ' || COALESCE(qual, '—')
                     || ' · CHECK ' || COALESCE(with_check, '—')
                     ORDER BY tablename, cmd, policyname)
      FROM pg_policies
     WHERE schemaname = 'public' AND permissive = 'PERMISSIVE'
       AND tablename IN ('products', 'customers', 'sales', 'sale_items', 'store_stock')
  ),
  'get_user_store', (
    SELECT jsonb_agg(jsonb_build_object('security_definer', p.prosecdef, 'cuerpo', btrim(p.prosrc)))
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'get_user_store'
  )
));

-- ============================================================================
-- ROLLBACK (correr solo si hay que retirar el rol). El valor 'vendedor' se
-- queda en el enum: no se puede borrar.
--
-- ⚠️ El paso 1 va PRIMERO y no es opcional: sin sus políticas, un 'vendedor'
-- queda a nivel de tablas igual que un cajero (podría cambiar precios). Por
-- eso antes se pasa a 'consulta' —solo ve precios— a quien tenga el rol.
--
--   -- 1) Nadie se queda con el rol.
--   UPDATE public.profiles SET role = 'consulta' WHERE role::text = 'vendedor';
--
--   -- 2) Las trece políticas y la función.
--   DROP POLICY IF EXISTS "vendedor_no_inserta"             ON public.products;
--   DROP POLICY IF EXISTS "vendedor_no_actualiza"           ON public.products;
--   DROP POLICY IF EXISTS "vendedor_no_borra"               ON public.products;
--   DROP POLICY IF EXISTS "vendedor_no_borra"               ON public.store_stock;
--   DROP POLICY IF EXISTS "vendedor_inserta_en_su_tienda"   ON public.customers;
--   DROP POLICY IF EXISTS "vendedor_actualiza_en_su_tienda" ON public.customers;
--   DROP POLICY IF EXISTS "vendedor_no_borra"               ON public.customers;
--   DROP POLICY IF EXISTS "vendedor_inserta_lo_suyo"        ON public.sales;
--   DROP POLICY IF EXISTS "vendedor_no_actualiza"           ON public.sales;
--   DROP POLICY IF EXISTS "vendedor_no_borra"               ON public.sales;
--   DROP POLICY IF EXISTS "vendedor_inserta_lo_suyo"        ON public.sale_items;
--   DROP POLICY IF EXISTS "vendedor_no_actualiza"           ON public.sale_items;
--   DROP POLICY IF EXISTS "vendedor_no_borra"               ON public.sale_items;
--   DROP FUNCTION IF EXISTS public.is_vendedor();
--
--   -- 3) Los tres RPC, otra vez solo caja y dueño.
--   DO $$
--   DECLARE r record;
--   BEGIN
--     FOR r IN
--       SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--        WHERE n.nspname = 'public'
--          AND p.proname IN ('redeem_points_global', 'register_exchange', 'transfer_stock')
--     LOOP
--       EXECUTE replace(pg_get_functiondef(r.oid),
--                       'NOT IN (''owner'', ''cashier'', ''vendedor'')',
--                       'NOT IN (''owner'', ''cashier'')');
--     END LOOP;
--   END $$;
-- ============================================================================
