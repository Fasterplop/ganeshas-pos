-- ============================================================================
-- Transferencias entre tiendas (1): tabla de historial + RPC transfer_stock.
--
-- POR QUÉ: las dos tiendas están cerca y a veces un cliente paga en una un
-- producto de la otra. Desde que la caja filtra por tienda dueña (cada tienda
-- vende solo lo suyo) el cajero solo ve "Producto no encontrado" y no tiene
-- salida. Vender igual el producto de la otra tienda —lo que pasaba antes del
-- filtro— descontaba el stock en una fila que ninguna pantalla muestra.
--
-- QUÉ ES TRANSFERIR: mover UNIDADES entre las dos filas de store_stock que
-- cada producto ya tiene (una por tienda). El producto NO cambia de tienda
-- dueña: conserva su owner_store_id, su código, su etiqueta, sus variantes y
-- sus ofertas. La caja de una tienda vende lo propio O lo que tenga unidades
-- traídas (store_stock de esa tienda > 0).
--
-- POR QUÉ UN RPC Y NO DOS UPDATE DESDE EL NAVEGADOR:
--   * Son dos filas de dos tiendas: o se mueven las dos o ninguna. Desde el
--     navegador serían dos peticiones, y si la segunda falla se pierde o se
--     duplica mercancía.
--   * El cajero solo puede escribir store_stock de SU sucursal (RLS). Una
--     transferencia toca las dos.
--   * Mueve por DELTA con las filas bloqueadas, no escribe un valor absoluto
--     leído antes: dos transferencias a la vez no se pisan.
--   * Deja registro. Hasta hoy ningún cambio de stock dejaba rastro.
--
-- QUIÉN PUEDE (decisión del dueño, 2026-10-09: "el dueño y todos los
-- cajeros"): owner o cashier con perfil activo. El cajero, solo si una de las
-- dos tiendas es la suya. El rol 'consulta' no. El bloque 1 de la función es
-- el único que habría que tocar si esa decisión cambia.
--
-- REGLA DE NEGATIVOS:
--   * La fila de la tienda NO dueña nunca queda negativa por una transferencia
--     (devolver más de lo que hay da INSUFFICIENT_STOCK). Un negativo ahí es
--     justo el descuadre invisible que esto viene a evitar.
--   * La fila de la tienda DUEÑA sí puede, pero solo con p_allow_negative: el
--     sistema nunca bloquea una venta (store_stock no tiene CHECK >= 0, el
--     cobro no tiene tope), y si el producto está en la mano del cajero el
--     conteo del sistema es el que está mal. Ese negativo SÍ se ve: sale en
--     «Agotados» del inventario de la tienda dueña.
--
-- IDEMPOTENCIA: p_request_id (lo genera la pantalla al abrir la ventana). Un
-- doble clic o un reintento por mala señal con el mismo id devuelve el
-- resultado del primero en vez de mover dos veces.
--
-- TODO ADITIVO: una tabla nueva y una función nueva. No toca store_stock,
-- products ni ninguna venta. Nada de lo que ya existe llama a esto: aplicar
-- este archivo no cambia el comportamiento de la caja ni del inventario hasta
-- que se despliegue el front que lo usa.
--
-- LO QUE NO SE TOCA: register_exchange y delete_sale_and_revert siguen
-- devolviendo el stock a la tienda DE LA VENTA. Con la regla nueva, esa unidad
-- se puede volver a vender en esa tienda o devolver a su tienda de origen
-- desde el inventario. restock_stock, etiquetas, ofertas, bulk_update_prices y
-- set_product_barcode cuelgan de owner_store_id, que no cambia.
--
-- LOS DESCUADRES VIEJOS NO SE CORRIGEN ACÁ. Las filas no dueñas que quedaron
-- en -1 por ventas cruzadas anteriores al filtro se revisan una por una desde
-- Inventario (en la tienda dueña, la fila del producto dice «-1 en la otra
-- tienda»; se corrige transfiriendo esa unidad): en el SQL Editor auth.uid()
-- es NULL (no habría autor que anotar) y no todas son ventas cruzadas de
-- verdad (alguna puede ser una ficha parecida de la propia tienda).
--
-- ORDEN DE BLOQUEO: las dos filas del producto, ordenadas por store_id.
-- register_exchange y delete_sale_and_revert bloquean filas de UNA sola
-- tienda, así que no pueden cerrar un ciclo con las dos filas de un producto.
--
-- ERRORES (RAISE EXCEPTION, el front los traduce en src/lib/transfers.ts):
--   NOT_AUTHORIZED, NOT_AUTHORIZED_STORE, INVALID_ARGUMENTS, SAME_STORE,
--   INVALID_QUANTITY, INVALID_SOURCE, STORE_NOT_AVAILABLE, PRODUCT_NOT_FOUND,
--   PRODUCT_INACTIVE, INSUFFICIENT_STOCK.
--
-- CÓMO APLICAR: en el SQL Editor de Supabase, el archivo ENTERO, con las
-- tiendas cerradas y las pestañas de Advisors y Table Editor cerradas (crear
-- una tabla con claves foráneas pide un candado breve sobre products, stores y
-- profiles; el lock_timeout hace que se rinda en vez de encolar la caja).
-- Antes: respaldo (node scripts/backup-db.mjs) y db/transfer_00_diagnostico.sql.
-- Es idempotente: se puede volver a correr.
--
-- PARA VOLVER ATRÁS (en este orden; el paso 1 importa: sin él, con el front
-- viejo las unidades que estén en la otra tienda quedan invisibles):
--
--   -- 1) Devolver a la tienda dueña todo lo que esté en la otra.
--   WITH ajenas AS (
--     SELECT s.product_id, s.store_id, s.stock, p.owner_store_id
--       FROM public.store_stock s
--       JOIN public.products p ON p.id = s.product_id
--      WHERE s.store_id <> p.owner_store_id AND s.stock > 0
--        FOR UPDATE OF s
--   ), sumar AS (
--     UPDATE public.store_stock d
--        SET stock = COALESCE(d.stock, 0) + a.stock
--       FROM ajenas a
--      WHERE d.product_id = a.product_id AND d.store_id = a.owner_store_id
--     RETURNING d.product_id
--   )
--   UPDATE public.store_stock s SET stock = 0
--     FROM ajenas a
--    WHERE s.product_id = a.product_id AND s.store_id = a.store_id;
--   -- 2) Quitar la función y la tabla (se pierde el historial).
--   DROP FUNCTION public.transfer_stock(uuid, uuid, uuid, integer, text, text, boolean, uuid);
--   DROP TABLE public.stock_transfers;
--   NOTIFY pgrst, 'reload schema';
-- ============================================================================

SET lock_timeout = '5s';

-- ----------------------------------------------------------------------------
-- 1. Historial de transferencias. Una fila por movimiento.
--
--    from_stock_after / to_stock_after guardan cómo quedó cada tienda justo
--    después del movimiento: como no existe un libro de movimientos de stock,
--    es lo único que permite reconstruir qué pasó si un conteo no cuadra.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stock_transfers (
  id               uuid NOT NULL DEFAULT uuid_generate_v4(),
  product_id       uuid NOT NULL,
  from_store_id    uuid NOT NULL,
  to_store_id      uuid NOT NULL,
  quantity         integer NOT NULL CHECK (quantity > 0),
  from_stock_after integer NOT NULL,
  to_stock_after   integer NOT NULL,
  note             text,
  -- Desde dónde se hizo: la caja (traer para vender), el inventario, o un
  -- ajuste que corrige un descuadre viejo.
  source           text NOT NULL CHECK (source = ANY (ARRAY['pos'::text, 'inventory'::text, 'ajuste'::text])),
  request_id       uuid,
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_transfers_pkey PRIMARY KEY (id),
  CONSTRAINT stock_transfers_product_fkey FOREIGN KEY (product_id)    REFERENCES public.products(id),
  CONSTRAINT stock_transfers_from_fkey    FOREIGN KEY (from_store_id) REFERENCES public.stores(id),
  CONSTRAINT stock_transfers_to_fkey      FOREIGN KEY (to_store_id)   REFERENCES public.stores(id),
  CONSTRAINT stock_transfers_author_fkey  FOREIGN KEY (created_by)    REFERENCES public.profiles(id),
  CONSTRAINT stock_transfers_distinct_check CHECK (from_store_id <> to_store_id),
  CONSTRAINT stock_transfers_request_key UNIQUE (request_id)
);

CREATE INDEX IF NOT EXISTS idx_stock_transfers_created ON public.stock_transfers (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_product ON public.stock_transfers (product_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- 2. Políticas ANTES del ENABLE (trampa de ensure_rls: una tabla con RLS y
--    cero políticas no queda abierta, queda muda y sin error).
--
--    Leer: dueño y cajeros (el historial se abre desde Inventario).
--    Escribir: NADIE por la API. La única que escribe es transfer_stock, que
--    es SECURITY DEFINER y no pasa por las políticas. Por eso desde el sistema
--    el historial no se puede editar ni borrar.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "stock_transfers_select_staff" ON public.stock_transfers;

CREATE POLICY "stock_transfers_select_staff" ON public.stock_transfers
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles p
             WHERE p.id = auth.uid() AND p.role::text IN ('owner', 'cashier'))
  );

ALTER TABLE public.stock_transfers ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 3. Mover unidades de una tienda a la otra.
--    Devuelve jsonb: { transfer_id, product_id, from_store_id, to_store_id,
--                      quantity, from_stock, to_stock, replayed }.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.transfer_stock(
  p_product_id     uuid,
  p_from_store_id  uuid,
  p_to_store_id    uuid,
  p_quantity       integer,
  p_note           text    DEFAULT NULL,
  p_source         text    DEFAULT 'inventory',  -- pos | inventory | ajuste
  p_allow_negative boolean DEFAULT false,        -- solo aplica a la fila de la tienda DUEÑA
  p_request_id     uuid    DEFAULT NULL          -- idempotencia (doble clic / reintento)
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role        text;
  v_assigned    uuid;
  v_active      boolean;
  v_owner       uuid;
  v_prod_active boolean;
  v_from        integer;
  v_to          integer;
  v_id          uuid;
  v_prev        public.stock_transfers%ROWTYPE;
  v_source      text := lower(trim(COALESCE(p_source, '')));
BEGIN
  -- 1. Autorización: perfil activo, caja o dueño. La comprobación va aquí
  --    dentro (no solo en el front) porque la clave anónima viaja en el
  --    navegador: cualquiera podría llamar al RPC desde la consola.
  SELECT role::text, assigned_store_id, is_active
    INTO v_role, v_assigned, v_active
    FROM public.profiles
   WHERE id = auth.uid();

  IF v_role IS NULL OR COALESCE(v_active, false) = false THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;
  IF v_role NOT IN ('owner', 'cashier') THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;

  -- 2. Argumentos.
  IF p_product_id IS NULL OR p_from_store_id IS NULL OR p_to_store_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS';
  END IF;
  IF p_from_store_id = p_to_store_id THEN
    RAISE EXCEPTION 'SAME_STORE';
  END IF;
  -- Tope de cordura: un dedazo no puede mover miles de unidades.
  IF p_quantity IS NULL OR p_quantity < 1 OR p_quantity > 999 THEN
    RAISE EXCEPTION 'INVALID_QUANTITY';
  END IF;
  IF v_source NOT IN ('pos', 'inventory', 'ajuste') THEN
    RAISE EXCEPTION 'INVALID_SOURCE';
  END IF;

  -- 3. El cajero solo mueve desde o hacia su propia tienda.
  IF v_role <> 'owner' AND (v_assigned IS NULL OR v_assigned NOT IN (p_from_store_id, p_to_store_id)) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED_STORE';
  END IF;

  -- 4. Las dos tiendas existen y están activas.
  IF (SELECT COUNT(*) FROM public.stores
       WHERE id IN (p_from_store_id, p_to_store_id) AND COALESCE(is_active, false)) <> 2 THEN
    RAISE EXCEPTION 'STORE_NOT_AVAILABLE';
  END IF;

  -- 5. Producto activo. Lectura simple, sin FOR UPDATE: no hay por qué frenar
  --    una edición de precio mientras se mueve stock. Un producto eliminado
  --    (borrado lógico) no se transfiere.
  SELECT owner_store_id, COALESCE(is_active, false)
    INTO v_owner, v_prod_active
    FROM public.products
   WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
  END IF;
  IF NOT v_prod_active THEN
    RAISE EXCEPTION 'PRODUCT_INACTIVE';
  END IF;

  -- 6. Asegurar las dos filas (el trigger de alta ya las crea; esto cubre un
  --    producto que por lo que sea no las tenga) y bloquearlas en orden fijo.
  INSERT INTO public.store_stock (product_id, store_id, stock)
  VALUES (p_product_id, p_from_store_id, 0), (p_product_id, p_to_store_id, 0)
  ON CONFLICT (product_id, store_id) DO NOTHING;

  PERFORM 1
     FROM public.store_stock
    WHERE product_id = p_product_id
      AND store_id IN (p_from_store_id, p_to_store_id)
    ORDER BY store_id
      FOR UPDATE;

  -- 7. Idempotencia, DESPUÉS del bloqueo: un reintento que llega mientras el
  --    primero sigue en curso espera el candado y aquí ya lo ve confirmado.
  IF p_request_id IS NOT NULL THEN
    SELECT * INTO v_prev FROM public.stock_transfers WHERE request_id = p_request_id;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'transfer_id',   v_prev.id,
        'product_id',    v_prev.product_id,
        'from_store_id', v_prev.from_store_id,
        'to_store_id',   v_prev.to_store_id,
        'quantity',      v_prev.quantity,
        'from_stock',    v_prev.from_stock_after,
        'to_stock',      v_prev.to_stock_after,
        'replayed',      true
      );
    END IF;
  END IF;

  -- 8. Regla de negativos (ver cabecera): la fila NO dueña nunca; la dueña
  --    solo con permiso explícito.
  SELECT COALESCE(stock, 0) INTO v_from
    FROM public.store_stock
   WHERE product_id = p_product_id AND store_id = p_from_store_id;

  IF v_from - p_quantity < 0
     AND (p_from_store_id IS DISTINCT FROM v_owner OR NOT COALESCE(p_allow_negative, false)) THEN
    RAISE EXCEPTION 'INSUFFICIENT_STOCK';
  END IF;

  -- 9. Mover por DELTA.
  UPDATE public.store_stock
     SET stock = COALESCE(stock, 0) - p_quantity
   WHERE product_id = p_product_id AND store_id = p_from_store_id
  RETURNING stock INTO v_from;

  UPDATE public.store_stock
     SET stock = COALESCE(stock, 0) + p_quantity
   WHERE product_id = p_product_id AND store_id = p_to_store_id
  RETURNING stock INTO v_to;

  -- 10. Registro.
  INSERT INTO public.stock_transfers (
    product_id, from_store_id, to_store_id, quantity,
    from_stock_after, to_stock_after, note, source, request_id, created_by
  ) VALUES (
    p_product_id, p_from_store_id, p_to_store_id, p_quantity,
    v_from, v_to, NULLIF(trim(COALESCE(p_note, '')), ''), v_source, p_request_id, auth.uid()
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'transfer_id',   v_id,
    'product_id',    p_product_id,
    'from_store_id', p_from_store_id,
    'to_store_id',   p_to_store_id,
    'quantity',      p_quantity,
    'from_stock',    v_from,
    'to_stock',      v_to,
    'replayed',      false
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.transfer_stock(uuid, uuid, uuid, integer, text, text, boolean, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- VERIFICACIÓN. Tiene que dar:
--   tabla.rls_activa = true, tabla.politicas = 1,
--   versiones = 1, parametros = 8, security_definer = true, ejecutable = true,
--   transferencias = 0 (la primera vez),
--   suma_stock_total = el mismo número que dio db/transfer_00_diagnostico.sql.
-- ============================================================================
SELECT jsonb_pretty(jsonb_build_object(
  'tabla', (
    SELECT jsonb_build_object(
             'rls_activa', c.relrowsecurity,
             'politicas', (SELECT COUNT(*) FROM pg_policies p
                            WHERE p.schemaname = 'public' AND p.tablename = 'stock_transfers'))
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'stock_transfers'
  ),
  'versiones', (
    SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'transfer_stock'
  ),
  'parametros', (
    SELECT MAX(p.pronargs) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'transfer_stock'
  ),
  'security_definer', (
    SELECT bool_and(p.prosecdef) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'transfer_stock'
  ),
  'ejecutable', has_function_privilege(
    'authenticated', 'public.transfer_stock(uuid, uuid, uuid, integer, text, text, boolean, uuid)', 'EXECUTE'
  ),
  'transferencias', (SELECT COUNT(*) FROM public.stock_transfers),
  'suma_stock_total', (SELECT SUM(stock) FROM public.store_stock)
));
