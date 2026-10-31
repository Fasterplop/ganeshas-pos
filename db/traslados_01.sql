-- ============================================================================
-- Traslados (1): envíos en lote de una tienda a la otra, y el «gemelo» de cada
-- pieza en la tienda que la recibe.
--
-- POR QUÉ (propuesta «Cashea + Traslados» v2, aprobada por Gerardo el
-- 2026-10-30): con el botón ⇄ del inventario la cajera decidía cinco cosas por
-- pieza, la otra tienda no se enteraba y lo enviado llegaba SUELTO, fuera de
-- su producto padre. Traslados es una sección aparte: se pistolean las piezas,
-- cada una dice a qué producto llega en la otra tienda, se envía todo junto y
-- la otra tienda confirma «Todo llegó» o «Falta algo».
--
-- LA DIFERENCIA CON transfer_stock (db/transfer_01): aquel mueve unidades
-- entre las dos filas de store_stock de UN mismo producto, que sigue siendo de
-- su tienda dueña. Aquí la pieza puede llegar a OTRO producto: su gemelo en la
-- tienda destino (la «Cartera Polo · Negra» de Juguetes recibe la «Cartera
-- Polo · Negra» de Ropa). sku_barcode es UNIQUE global y cada producto es una
-- sola fila, así que el gemelo es otra fila y hace falta recordar el par.
--
-- A QUÉ PRODUCTO LLEGA CADA PIEZA (en este orden; lo decide send_shipment):
--   1. «vuelve»:   la pieza es de la tienda destino (se la habían traído):
--                  vuelve a su mismo producto. Esto reemplaza al «Devolver».
--   2. «elegido» / «mismo» / «parecido»: la pantalla manda el producto o el
--                  modelo (product_groups) de la tienda destino que se eligió
--                  (nombre igual, nombre parecido confirmado con un toque, o
--                  elegido a mano). Con un modelo, la variante se busca por
--                  talla y color; si no existe se CREA en ese modelo, con el
--                  precio de la tienda destino («variante nueva»).
--   3. «enlazado»: no se mandó nada y ya hay un enlace guardado de una vez
--                  anterior (de la pieza o de su modelo).
--   4. «origen»:   la tienda destino no lo tiene (o la cajera eligió «que
--                  llegue con su padre», origin = true, aunque haya enlace):
--                  la unidad queda como hoy, del mismo producto (stock
--                  ajeno), y el inventario la muestra dentro de su padre de
--                  origen, no suelta.
-- Lo elegido en 2 se guarda en product_twins / group_twins para la próxima.
--
-- CÓDIGOS CON VARIAS TALLAS (filas de Juguetes del tipo «S, M, L»): la
-- pantalla manda una línea por talla anotada (size). Esa talla reemplaza a la
-- del producto para buscar o crear la variante, y en esas líneas NO se usa ni
-- se guarda el enlace de la pieza (un código con tres tallas no tiene un solo
-- gemelo); el del modelo sí.
--
-- EL STOCK SE MUEVE AL ENVIAR. Recibir solo confirma. Mientras el envío está
-- «pendiente» se puede deshacer desde la tienda que envió; después, solo el
-- dueño. «Falta algo» devuelve a la tienda de origen lo que no llegó.
--
-- REGLA DE NEGATIVOS (la misma de transfer_stock):
--   * En el ORIGEN, la fila de un producto ajeno nunca queda negativa
--     (INSUFFICIENT_STOCK). La del producto propio sí puede: la pieza está en
--     la mano de la cajera, el conteo del sistema es el que está mal, y la
--     pantalla lo avisa antes («el sistema tenía 0, revisar»).
--   * Al DESHACER o con «Falta algo», el destino no puede quedar por debajo de
--     donde estaba antes del envío (SOLD_IN_DESTINATION: ya se vendió algo;
--     se envía de vuelta con un traslado nuevo).
--
-- TODO O NADA: si una línea falla, la transacción entera se deshace (también
-- las variantes y los enlaces que se hubieran creado) y el error dice el
-- código de esa pieza: 'INSUFFICIENT_STOCK:ROP-1182'.
--
-- QUIÉN PUEDE:
--   * Enviar: el dueño desde cualquier tienda; el cajero solo desde la suya.
--   * Recibir, «Falta algo» y enlazar al recibir: el dueño o un cajero de la
--     tienda destino.
--   * Deshacer: pendiente, el dueño o un cajero de la tienda que envió;
--     recibido, solo el dueño.
--   * Leer: el dueño todo; el cajero, los envíos donde está su tienda. Los
--     enlaces los leen también los vendedores: la caja los usa para que la
--     etiqueta de la otra tienda encuentre su gemelo.
--   El vendedor y el rol consulta no envían ni reciben.
--
-- IDEMPOTENCIA: p_request_id (lo genera la pantalla al abrir el envío). Un
-- doble clic o un reintento con el mismo id devuelve el envío ya hecho.
--
-- ORDEN DE BLOQUEO: los modelos que pueden recibir variantes (por id), luego
-- las filas de store_stock (por producto y tienda). move_product_to_store
-- bloquea modelo → producto → stock y transfer_stock solo stock por tienda:
-- ninguno cierra un ciclo con esto.
--
-- TODO ADITIVO: 4 tablas nuevas y funciones nuevas. No toca stock_transfers,
-- transfer_stock ni move_product_to_store (la caja sigue trayendo productos de
-- la otra tienda como hoy). Aplicar este archivo no cambia nada visible hasta
-- desplegar el front de Traslados.
--
-- ERRORES (RAISE EXCEPTION, el front los traduce en src/lib/traslados.ts):
--   NOT_AUTHORIZED, NOT_AUTHORIZED_STORE, INVALID_ARGUMENTS, SAME_STORE,
--   STORE_NOT_AVAILABLE, NOTE_REQUIRED, EMPTY_SHIPMENT, TOO_MANY_LINES,
--   INVALID_QUANTITY, PRODUCT_NOT_FOUND, PRODUCT_INACTIVE:<código>,
--   TARGET_INVALID:<código>, INSUFFICIENT_STOCK:<código>,
--   SKU_GENERATION_FAILED, SHIPMENT_NOT_FOUND, SHIPMENT_NOT_PENDING,
--   ALREADY_UNDONE, ONLY_OWNER_AFTER_RECEIVED, MISSING_INVALID,
--   SOLD_IN_DESTINATION:<código>, ITEM_NOT_RELINKABLE.
--
-- CÓMO APLICAR: en el SQL Editor de Supabase, el archivo ENTERO, con las
-- tiendas cerradas y las pestañas de Advisors y Table Editor cerradas (las
-- claves foráneas piden un candado breve sobre products, product_groups,
-- stores y profiles; el lock_timeout hace que se rinda en vez de encolar la
-- caja). Antes: respaldo (node scripts/backup-db.mjs). Se puede volver a
-- correr.
--
-- PARA VOLVER ATRÁS: lo enviado ya es stock real de cada tienda y se queda
-- donde está (el gemelo es un producto normal de la tienda destino). Para
-- quitar las funciones y las tablas (se pierde el historial de envíos y los
-- enlaces guardados):
--   DROP FUNCTION public.send_shipment(uuid, uuid, text, jsonb, uuid);
--   DROP FUNCTION public.receive_shipment(uuid, jsonb);
--   DROP FUNCTION public.undo_shipment(uuid);
--   DROP FUNCTION public.relink_shipment_item(uuid, uuid, uuid);
--   DROP FUNCTION public._traslado_variant_in_group(uuid, uuid, text);
--   DROP FUNCTION public._traslado_link_products(uuid, uuid, uuid);
--   DROP FUNCTION public._traslado_link_groups(uuid, uuid, uuid);
--   DROP FUNCTION public._traslado_cleanup_variant(uuid);
--   DROP FUNCTION public.traslado_norm(text);
--   DROP TABLE public.store_shipment_items, public.store_shipments,
--              public.product_twins, public.group_twins;
--   NOTIFY pgrst, 'reload schema';
-- ============================================================================

SET lock_timeout = '5s';

-- ----------------------------------------------------------------------------
-- 1. Tablas.
--
--    store_ y no shipments a secas: fin_shipments ya existe (las cajas que
--    llegan de los proveedores, en Finanzas).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.store_shipments (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  from_store_id uuid NOT NULL,
  to_store_id   uuid NOT NULL,
  -- Un motivo para todo el envío (obligatorio en la pantalla).
  note          text NOT NULL CHECK (btrim(note) <> ''),
  status        text NOT NULL DEFAULT 'pendiente'
                CHECK (status = ANY (ARRAY['pendiente'::text, 'recibido'::text, 'incompleto'::text, 'deshecho'::text])),
  pieces        integer NOT NULL CHECK (pieces > 0),
  request_id    uuid,
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  received_by   uuid,
  received_at   timestamptz,
  undone_by     uuid,
  undone_at     timestamptz,
  CONSTRAINT store_shipments_pkey PRIMARY KEY (id),
  CONSTRAINT store_shipments_from_fkey     FOREIGN KEY (from_store_id) REFERENCES public.stores(id),
  CONSTRAINT store_shipments_to_fkey       FOREIGN KEY (to_store_id)   REFERENCES public.stores(id),
  CONSTRAINT store_shipments_author_fkey   FOREIGN KEY (created_by)    REFERENCES public.profiles(id),
  CONSTRAINT store_shipments_receiver_fkey FOREIGN KEY (received_by)   REFERENCES public.profiles(id),
  CONSTRAINT store_shipments_undoer_fkey   FOREIGN KEY (undone_by)     REFERENCES public.profiles(id),
  CONSTRAINT store_shipments_distinct_check CHECK (from_store_id <> to_store_id),
  CONSTRAINT store_shipments_request_key UNIQUE (request_id)
);

CREATE INDEX IF NOT EXISTS idx_store_shipments_created ON public.store_shipments (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_store_shipments_to_status ON public.store_shipments (to_store_id, status);
CREATE INDEX IF NOT EXISTS idx_store_shipments_from ON public.store_shipments (from_store_id, created_at DESC);

-- Una fila por pieza (o por talla anotada). product_id es el de la tienda que
-- envía; target_product_id, el que la recibió (el mismo en «vuelve» y
-- «origen»). *_stock_after guardan cómo quedó cada fila justo después: es lo
-- que permite reconstruir qué pasó si un conteo no cuadra.
CREATE TABLE IF NOT EXISTS public.store_shipment_items (
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  shipment_id        uuid NOT NULL,
  sort               integer NOT NULL DEFAULT 0,
  product_id         uuid NOT NULL,
  target_product_id  uuid NOT NULL,
  quantity           integer NOT NULL CHECK (quantity > 0),
  missing            integer NOT NULL DEFAULT 0,
  size               text,
  match              text NOT NULL
                     CHECK (match = ANY (ARRAY['vuelve'::text, 'enlazado'::text, 'mismo'::text, 'parecido'::text, 'elegido'::text, 'origen'::text])),
  created_variant    boolean NOT NULL DEFAULT false,
  origin_stock_after integer NOT NULL,
  target_stock_after integer NOT NULL,
  origin_price       numeric,
  target_price       numeric,
  CONSTRAINT store_shipment_items_pkey PRIMARY KEY (id),
  CONSTRAINT store_shipment_items_shipment_fkey FOREIGN KEY (shipment_id) REFERENCES public.store_shipments(id) ON DELETE CASCADE,
  CONSTRAINT store_shipment_items_product_fkey  FOREIGN KEY (product_id)  REFERENCES public.products(id),
  CONSTRAINT store_shipment_items_target_fkey   FOREIGN KEY (target_product_id) REFERENCES public.products(id),
  CONSTRAINT store_shipment_items_missing_check CHECK (missing >= 0 AND missing <= quantity)
);

CREATE INDEX IF NOT EXISTS idx_store_shipment_items_shipment ON public.store_shipment_items (shipment_id, sort);
CREATE INDEX IF NOT EXISTS idx_store_shipment_items_product ON public.store_shipment_items (product_id);
CREATE INDEX IF NOT EXISTS idx_store_shipment_items_target ON public.store_shipment_items (target_product_id);

-- Enlaces guardados: el gemelo de un producto (o de un modelo) en otra tienda.
-- Se guardan en las DOS direcciones, así sirven para ir y para volver.
CREATE TABLE IF NOT EXISTS public.product_twins (
  product_id    uuid NOT NULL,
  twin_store_id uuid NOT NULL,
  twin_id       uuid NOT NULL,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_twins_pkey PRIMARY KEY (product_id, twin_store_id),
  CONSTRAINT product_twins_product_fkey FOREIGN KEY (product_id)    REFERENCES public.products(id) ON DELETE CASCADE,
  CONSTRAINT product_twins_twin_fkey    FOREIGN KEY (twin_id)       REFERENCES public.products(id) ON DELETE CASCADE,
  CONSTRAINT product_twins_store_fkey   FOREIGN KEY (twin_store_id) REFERENCES public.stores(id),
  CONSTRAINT product_twins_author_fkey  FOREIGN KEY (created_by)    REFERENCES public.profiles(id),
  CONSTRAINT product_twins_distinct_check CHECK (product_id <> twin_id)
);

CREATE INDEX IF NOT EXISTS idx_product_twins_twin ON public.product_twins (twin_id);

CREATE TABLE IF NOT EXISTS public.group_twins (
  group_id      uuid NOT NULL,
  twin_store_id uuid NOT NULL,
  twin_group_id uuid NOT NULL,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT group_twins_pkey PRIMARY KEY (group_id, twin_store_id),
  CONSTRAINT group_twins_group_fkey  FOREIGN KEY (group_id)      REFERENCES public.product_groups(id) ON DELETE CASCADE,
  CONSTRAINT group_twins_twin_fkey   FOREIGN KEY (twin_group_id) REFERENCES public.product_groups(id) ON DELETE CASCADE,
  CONSTRAINT group_twins_store_fkey  FOREIGN KEY (twin_store_id) REFERENCES public.stores(id),
  CONSTRAINT group_twins_author_fkey FOREIGN KEY (created_by)    REFERENCES public.profiles(id),
  CONSTRAINT group_twins_distinct_check CHECK (group_id <> twin_group_id)
);

CREATE INDEX IF NOT EXISTS idx_group_twins_twin ON public.group_twins (twin_group_id);

-- ----------------------------------------------------------------------------
-- 2. Políticas ANTES del ENABLE (trampa de ensure_rls: una tabla con RLS y
--    cero políticas no queda abierta, queda muda y sin error).
--
--    Solo SELECT. Nadie escribe por la API: lo hacen las funciones de abajo,
--    que son SECURITY DEFINER. Por eso el historial no se puede editar.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "store_shipments_select_staff" ON public.store_shipments;
CREATE POLICY "store_shipments_select_staff" ON public.store_shipments
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles p
             WHERE p.id = auth.uid()
               AND COALESCE(p.is_active, false)
               AND (p.role::text = 'owner'
                    OR (p.role::text = 'cashier' AND p.assigned_store_id IN (from_store_id, to_store_id))))
  );

-- Las piezas se ven si se ve su envío (la subconsulta pasa por la política de arriba).
DROP POLICY IF EXISTS "store_shipment_items_select_staff" ON public.store_shipment_items;
CREATE POLICY "store_shipment_items_select_staff" ON public.store_shipment_items
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.store_shipments s WHERE s.id = shipment_id)
  );

DROP POLICY IF EXISTS "product_twins_select_staff" ON public.product_twins;
CREATE POLICY "product_twins_select_staff" ON public.product_twins
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles p
             WHERE p.id = auth.uid() AND COALESCE(p.is_active, false)
               AND p.role::text IN ('owner', 'cashier', 'vendedor'))
  );

DROP POLICY IF EXISTS "group_twins_select_staff" ON public.group_twins;
CREATE POLICY "group_twins_select_staff" ON public.group_twins
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles p
             WHERE p.id = auth.uid() AND COALESCE(p.is_active, false)
               AND p.role::text IN ('owner', 'cashier', 'vendedor'))
  );

ALTER TABLE public.store_shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_shipment_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_twins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_twins ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 3. Ayudantes.
-- ----------------------------------------------------------------------------

-- Talla y color comparables: sin acentos, en mayúsculas, un solo espacio.
-- src/lib/traslados.ts tiene la misma regla (normText): si se toca una, la otra.
CREATE OR REPLACE FUNCTION public.traslado_norm(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT upper(btrim(regexp_replace(
           translate(COALESCE(p, ''), 'áéíóúüÁÉÍÓÚÜ', 'aeiouuAEIOUU'),
           '\s+', ' ', 'g')))
$$;

GRANT EXECUTE ON FUNCTION public.traslado_norm(text) TO authenticated;

-- Guarda «a es el gemelo de b» en las dos direcciones. Quien apuntaba antes a
-- cualquiera de los dos desde la otra tienda deja de hacerlo: un producto
-- tiene a lo sumo un gemelo por tienda.
CREATE OR REPLACE FUNCTION public._traslado_link_products(p_a uuid, p_b uuid, p_user uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_sa uuid;
  v_sb uuid;
BEGIN
  SELECT owner_store_id INTO v_sa FROM public.products WHERE id = p_a;
  SELECT owner_store_id INTO v_sb FROM public.products WHERE id = p_b;
  IF v_sa IS NULL OR v_sb IS NULL OR v_sa = v_sb THEN
    RETURN;
  END IF;

  DELETE FROM public.product_twins
   WHERE (twin_id = p_a AND twin_store_id = v_sa AND product_id <> p_b)
      OR (twin_id = p_b AND twin_store_id = v_sb AND product_id <> p_a);

  INSERT INTO public.product_twins (product_id, twin_store_id, twin_id, created_by)
  VALUES (p_a, v_sb, p_b, p_user), (p_b, v_sa, p_a, p_user)
  ON CONFLICT (product_id, twin_store_id)
  DO UPDATE SET twin_id = EXCLUDED.twin_id, created_by = EXCLUDED.created_by, created_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public._traslado_link_groups(p_a uuid, p_b uuid, p_user uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_sa uuid;
  v_sb uuid;
BEGIN
  SELECT owner_store_id INTO v_sa FROM public.product_groups WHERE id = p_a;
  SELECT owner_store_id INTO v_sb FROM public.product_groups WHERE id = p_b;
  IF v_sa IS NULL OR v_sb IS NULL OR v_sa = v_sb THEN
    RETURN;
  END IF;

  DELETE FROM public.group_twins
   WHERE (twin_group_id = p_a AND twin_store_id = v_sa AND group_id <> p_b)
      OR (twin_group_id = p_b AND twin_store_id = v_sb AND group_id <> p_a);

  INSERT INTO public.group_twins (group_id, twin_store_id, twin_group_id, created_by)
  VALUES (p_a, v_sb, p_b, p_user), (p_b, v_sa, p_a, p_user)
  ON CONFLICT (group_id, twin_store_id)
  DO UPDATE SET twin_group_id = EXCLUDED.twin_group_id, created_by = EXCLUDED.created_by, created_at = now();
END;
$$;

-- La variante del modelo p_group (de la tienda destino) que corresponde a la
-- pieza p_origin: misma talla (o la talla anotada) y mismo color. Si no hay,
-- la crea en ese modelo:
--   * nombre y categoría del modelo (todas las variantes llevan su nombre),
--   * precio de la tienda destino: el más común entre las variantes activas
--     del modelo; si no tiene, el precio por defecto del modelo,
--   * código nuevo con el prefijo de la tienda destino, igual que el
--     inventario (storePrefix en src/lib/stores.ts),
--   * sin etiqueta impresa (sale como «Nuevo»). La etiqueta de la pieza
--     enviada sigue sirviendo: la caja busca el gemelo.
-- Quien llama ya bloqueó el modelo, así dos envíos a la vez no crean dos
-- veces la misma variante.
CREATE OR REPLACE FUNCTION public._traslado_variant_in_group(
  p_group uuid, p_origin uuid, p_size text,
  OUT o_product uuid, OUT o_created boolean
)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  g        public.product_groups%ROWTYPE;
  o        public.products%ROWTYPE;
  v_talla  text;
  v_price  numeric;
  v_prefix text;
  v_sku    text;
BEGIN
  SELECT * INTO g FROM public.product_groups WHERE id = p_group;
  SELECT * INTO o FROM public.products WHERE id = p_origin;
  v_talla := COALESCE(NULLIF(btrim(COALESCE(p_size, '')), ''), o.talla);

  SELECT id INTO o_product
    FROM public.products
   WHERE parent_group_id = p_group
     AND COALESCE(is_active, false)
     AND public.traslado_norm(talla) = public.traslado_norm(v_talla)
     AND public.traslado_norm(color) = public.traslado_norm(o.color)
   ORDER BY created_at NULLS LAST, id
   LIMIT 1;

  IF o_product IS NOT NULL THEN
    o_created := false;
    RETURN;
  END IF;

  SELECT price INTO v_price
    FROM public.products
   WHERE parent_group_id = p_group AND COALESCE(is_active, false)
   GROUP BY price
   ORDER BY COUNT(*) DESC, price DESC
   LIMIT 1;
  v_price := COALESCE(v_price, g.default_price, o.price);

  SELECT CASE
           WHEN lower(name) LIKE '%juguet%' THEN 'JUG'
           WHEN lower(name) LIKE '%ropa%' THEN 'ROP'
           ELSE COALESCE(NULLIF(upper(left(btrim(name), 3)), ''), 'GEN')
         END
    INTO v_prefix
    FROM public.stores WHERE id = g.owner_store_id;

  FOR i IN 1..25 LOOP
    v_sku := v_prefix || '-' || (100000 + floor(random() * 900000))::int::text;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.products WHERE sku_barcode = v_sku);
    v_sku := NULL;
  END LOOP;
  IF v_sku IS NULL THEN
    RAISE EXCEPTION 'SKU_GENERATION_FAILED';
  END IF;

  INSERT INTO public.products (sku_barcode, name, category, price, is_active, owner_store_id, talla, color, parent_group_id)
  VALUES (v_sku, g.name, g.category, v_price, true, g.owner_store_id,
          NULLIF(btrim(COALESCE(v_talla, '')), ''), NULLIF(btrim(COALESCE(o.color, '')), ''), p_group)
  RETURNING id INTO o_product;

  -- El trigger de alta (on_product_created) crea las filas de stock; esto
  -- cubre el caso de que no estén.
  INSERT INTO public.store_stock (product_id, store_id, stock)
  SELECT o_product, s.id, 0 FROM public.stores s
  ON CONFLICT (product_id, store_id) DO NOTHING;

  o_created := true;
END;
$$;

-- Una variante que creó un envío y quedó sin ninguna unidad, sin ventas y sin
-- otro envío que la use (porque se deshizo o porque «faltó» todo) se da de
-- baja (borrado lógico) y pierde sus enlaces. Quien llama ya cambió el estado
-- del envío, así que sus propias piezas no cuentan.
CREATE OR REPLACE FUNCTION public._traslado_cleanup_variant(p_product uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF COALESCE((SELECT SUM(COALESCE(stock, 0)) FROM public.store_stock WHERE product_id = p_product), 0) = 0
     AND NOT EXISTS (SELECT 1 FROM public.sale_items WHERE product_id = p_product)
     AND NOT EXISTS (SELECT 1
                       FROM public.store_shipment_items si
                       JOIN public.store_shipments s ON s.id = si.shipment_id
                      WHERE s.status <> 'deshecho'
                        AND si.quantity > si.missing
                        AND (si.product_id = p_product OR si.target_product_id = p_product)) THEN
    UPDATE public.products SET is_active = false WHERE id = p_product;
    DELETE FROM public.product_twins WHERE product_id = p_product OR twin_id = p_product;
  END IF;
END;
$$;

-- Los ayudantes NO se llaman por la API: solo desde las funciones de abajo
-- (que corren como su dueño y conservan el permiso).
REVOKE ALL ON FUNCTION public._traslado_link_products(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._traslado_link_groups(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._traslado_variant_in_group(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._traslado_cleanup_variant(uuid) FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 4. Enviar.
--    p_lines: [{ product_id, qty, size?, target_group_id?, target_product_id?,
--                match? ('mismo' | 'parecido' | 'elegido'), origin? (true =
--                que llegue con su padre de origen aunque haya enlace) }]
--    Devuelve jsonb: { shipment_id, pieces, replayed, items: [...] }.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.send_shipment(
  p_from_store_id uuid,
  p_to_store_id   uuid,
  p_note          text,
  p_lines         jsonb,
  p_request_id    uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      uuid := auth.uid();
  v_role     text;
  v_assigned uuid;
  v_active   boolean;
  v_note     text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_prev     public.store_shipments%ROWTYPE;
  v_line     jsonb;
  v_res      jsonb := '[]'::jsonb;
  v_items    jsonb := '[]'::jsonb;
  p          public.products%ROWTYPE;
  v_pid      uuid;
  v_qty      integer;
  v_size     text;
  v_tgroup   uuid;
  v_tprod    uuid;
  v_label    text;
  v_origin   boolean;
  v_target   uuid;
  v_group    uuid;
  v_match    text;
  v_created  boolean;
  v_pieces   integer := 0;
  v_ship     uuid;
  v_sort     integer := 0;
  v_from     integer;
  v_to       integer;
  v_tsku     text;
  v_tprice   numeric;
BEGIN
  -- 1. Autorización. Va aquí dentro y no solo en el front: la clave anónima
  --    viaja en el navegador y cualquiera podría llamar al RPC.
  SELECT role::text, assigned_store_id, is_active
    INTO v_role, v_assigned, v_active
    FROM public.profiles WHERE id = v_uid;
  IF v_role IS NULL OR NOT COALESCE(v_active, false) OR v_role NOT IN ('owner', 'cashier') THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;

  -- 2. Argumentos.
  IF p_from_store_id IS NULL OR p_to_store_id IS NULL OR p_lines IS NULL
     OR jsonb_typeof(p_lines) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS';
  END IF;
  IF p_from_store_id = p_to_store_id THEN
    RAISE EXCEPTION 'SAME_STORE';
  END IF;
  -- El cajero envía solo desde su tienda (el destino es la otra).
  IF v_role <> 'owner' AND v_assigned IS DISTINCT FROM p_from_store_id THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED_STORE';
  END IF;
  IF (SELECT COUNT(*) FROM public.stores
       WHERE id IN (p_from_store_id, p_to_store_id) AND COALESCE(is_active, false)) <> 2 THEN
    RAISE EXCEPTION 'STORE_NOT_AVAILABLE';
  END IF;
  IF v_note IS NULL THEN
    RAISE EXCEPTION 'NOTE_REQUIRED';
  END IF;
  IF jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'EMPTY_SHIPMENT';
  END IF;
  IF jsonb_array_length(p_lines) > 300 THEN
    RAISE EXCEPTION 'TOO_MANY_LINES';
  END IF;

  -- 3. Idempotencia: un reintento con el mismo id espera al primero y
  --    devuelve lo que hizo.
  IF p_request_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 0));
    SELECT * INTO v_prev FROM public.store_shipments WHERE request_id = p_request_id;
    IF FOUND THEN
      RETURN jsonb_build_object('shipment_id', v_prev.id, 'pieces', v_prev.pieces, 'replayed', true, 'items', '[]'::jsonb);
    END IF;
  END IF;

  -- 4. Bloquear, en orden, los modelos que pueden recibir una variante nueva.
  PERFORM 1
     FROM public.product_groups g
    WHERE g.id IN (
            SELECT NULLIF(l->>'target_group_id', '')::uuid
              FROM jsonb_array_elements(p_lines) l
            UNION
            SELECT gt.twin_group_id
              FROM jsonb_array_elements(p_lines) l
              JOIN public.products pr ON pr.id = NULLIF(l->>'product_id', '')::uuid
              JOIN public.group_twins gt ON gt.group_id = pr.parent_group_id AND gt.twin_store_id = p_to_store_id)
    ORDER BY g.id
      FOR UPDATE;

  -- 5. A qué producto llega cada línea (ver la cabecera).
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    v_pid    := NULLIF(v_line->>'product_id', '')::uuid;
    v_qty    := NULLIF(v_line->>'qty', '')::integer;
    v_size   := NULLIF(btrim(COALESCE(v_line->>'size', '')), '');
    v_tgroup := NULLIF(v_line->>'target_group_id', '')::uuid;
    v_tprod  := NULLIF(v_line->>'target_product_id', '')::uuid;
    v_origin := COALESCE(NULLIF(v_line->>'origin', '')::boolean, false);
    v_label  := COALESCE(v_line->>'match', 'elegido');
    IF v_label NOT IN ('mismo', 'parecido', 'elegido') THEN
      v_label := 'elegido';
    END IF;

    IF v_pid IS NULL THEN
      RAISE EXCEPTION 'INVALID_ARGUMENTS';
    END IF;
    IF v_qty IS NULL OR v_qty < 1 OR v_qty > 999 THEN
      RAISE EXCEPTION 'INVALID_QUANTITY';
    END IF;

    SELECT * INTO p FROM public.products WHERE id = v_pid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
    END IF;
    IF NOT COALESCE(p.is_active, false) THEN
      RAISE EXCEPTION 'PRODUCT_INACTIVE:%', p.sku_barcode;
    END IF;

    v_created := false;
    v_target := NULL;

    IF p.owner_store_id = p_to_store_id THEN
      -- 1) Es de la tienda destino: vuelve a su mismo producto.
      v_target := p.id;
      v_match := 'vuelve';

    ELSIF v_origin THEN
      -- La cajera eligió que llegue con su padre de origen.
      v_target := p.id;
      v_match := 'origen';

    ELSIF v_tprod IS NOT NULL THEN
      -- 2a) Producto elegido en la tienda destino.
      IF NOT EXISTS (SELECT 1 FROM public.products
                      WHERE id = v_tprod AND COALESCE(is_active, false) AND owner_store_id = p_to_store_id) THEN
        RAISE EXCEPTION 'TARGET_INVALID:%', p.sku_barcode;
      END IF;
      v_target := v_tprod;
      v_match := v_label;
      IF v_size IS NULL THEN
        PERFORM public._traslado_link_products(p.id, v_target, v_uid);
      END IF;

    ELSIF v_tgroup IS NOT NULL THEN
      -- 2b) Modelo elegido en la tienda destino: su variante, o una nueva.
      IF NOT EXISTS (SELECT 1 FROM public.product_groups
                      WHERE id = v_tgroup AND is_active AND owner_store_id = p_to_store_id) THEN
        RAISE EXCEPTION 'TARGET_INVALID:%', p.sku_barcode;
      END IF;
      SELECT o_product, o_created INTO v_target, v_created
        FROM public._traslado_variant_in_group(v_tgroup, p.id, v_size);
      v_match := v_label;
      IF p.parent_group_id IS NOT NULL THEN
        PERFORM public._traslado_link_groups(p.parent_group_id, v_tgroup, v_uid);
      END IF;
      IF v_size IS NULL THEN
        PERFORM public._traslado_link_products(p.id, v_target, v_uid);
      END IF;

    ELSE
      -- 3) Enlace guardado: de la pieza (no en códigos con varias tallas)…
      IF v_size IS NULL THEN
        SELECT t.twin_id INTO v_target
          FROM public.product_twins t
          JOIN public.products tp ON tp.id = t.twin_id
         WHERE t.product_id = p.id AND t.twin_store_id = p_to_store_id
           AND COALESCE(tp.is_active, false) AND tp.owner_store_id = p_to_store_id;
      END IF;

      IF v_target IS NOT NULL THEN
        v_match := 'enlazado';
      ELSE
        -- …o de su modelo.
        v_group := NULL;
        IF p.parent_group_id IS NOT NULL THEN
          SELECT gt.twin_group_id INTO v_group
            FROM public.group_twins gt
            JOIN public.product_groups tg ON tg.id = gt.twin_group_id
           WHERE gt.group_id = p.parent_group_id AND gt.twin_store_id = p_to_store_id
             AND tg.is_active AND tg.owner_store_id = p_to_store_id;
        END IF;

        IF v_group IS NOT NULL THEN
          SELECT o_product, o_created INTO v_target, v_created
            FROM public._traslado_variant_in_group(v_group, p.id, v_size);
          v_match := 'enlazado';
          IF v_size IS NULL THEN
            PERFORM public._traslado_link_products(p.id, v_target, v_uid);
          END IF;
        ELSE
          -- 4) La tienda destino no lo tiene: queda del mismo producto.
          v_target := p.id;
          v_match := 'origen';
        END IF;
      END IF;
    END IF;

    v_pieces := v_pieces + v_qty;
    v_res := v_res || jsonb_build_object(
      'pid', p.id, 'sku', p.sku_barcode, 'owner', p.owner_store_id, 'price', p.price,
      'qty', v_qty, 'size', v_size, 'target', v_target, 'match', v_match, 'created', v_created);
  END LOOP;

  -- 6. Asegurar y bloquear, en orden fijo, todas las filas de stock que se tocan.
  INSERT INTO public.store_stock (product_id, store_id, stock)
  SELECT DISTINCT x.pid, x.sid, 0
    FROM (SELECT (r->>'pid')::uuid AS pid, p_from_store_id AS sid FROM jsonb_array_elements(v_res) r
          UNION
          SELECT (r->>'target')::uuid, p_to_store_id FROM jsonb_array_elements(v_res) r) x
  ON CONFLICT (product_id, store_id) DO NOTHING;

  PERFORM 1
     FROM public.store_stock s
    WHERE (s.product_id, s.store_id) IN (
            SELECT (r->>'pid')::uuid, p_from_store_id FROM jsonb_array_elements(v_res) r
            UNION
            SELECT (r->>'target')::uuid, p_to_store_id FROM jsonb_array_elements(v_res) r)
    ORDER BY s.product_id, s.store_id
      FOR UPDATE;

  -- 7. El envío y sus piezas.
  INSERT INTO public.store_shipments (from_store_id, to_store_id, note, pieces, request_id, created_by)
  VALUES (p_from_store_id, p_to_store_id, v_note, v_pieces, p_request_id, v_uid)
  RETURNING id INTO v_ship;

  FOR v_line IN SELECT value FROM jsonb_array_elements(v_res) LOOP
    v_sort := v_sort + 1;
    v_pid := (v_line->>'pid')::uuid;
    v_target := (v_line->>'target')::uuid;
    v_qty := (v_line->>'qty')::integer;

    -- Regla de negativos: un producto ajeno no puede quedar negativo en el origen.
    SELECT COALESCE(stock, 0) INTO v_from
      FROM public.store_stock WHERE product_id = v_pid AND store_id = p_from_store_id;
    IF v_from - v_qty < 0 AND (v_line->>'owner')::uuid IS DISTINCT FROM p_from_store_id THEN
      RAISE EXCEPTION 'INSUFFICIENT_STOCK:%', v_line->>'sku';
    END IF;

    -- Mover por DELTA.
    UPDATE public.store_stock SET stock = COALESCE(stock, 0) - v_qty
     WHERE product_id = v_pid AND store_id = p_from_store_id
    RETURNING stock INTO v_from;

    UPDATE public.store_stock SET stock = COALESCE(stock, 0) + v_qty
     WHERE product_id = v_target AND store_id = p_to_store_id
    RETURNING stock INTO v_to;

    SELECT sku_barcode, price INTO v_tsku, v_tprice FROM public.products WHERE id = v_target;

    INSERT INTO public.store_shipment_items (
      shipment_id, sort, product_id, target_product_id, quantity, size, match, created_variant,
      origin_stock_after, target_stock_after, origin_price, target_price
    ) VALUES (
      v_ship, v_sort, v_pid, v_target, v_qty, v_line->>'size', v_line->>'match', (v_line->>'created')::boolean,
      v_from, v_to, (v_line->>'price')::numeric, v_tprice
    );

    v_items := v_items || jsonb_build_object(
      'product_id', v_pid, 'sku', v_line->>'sku', 'target_product_id', v_target, 'target_sku', v_tsku,
      'match', v_line->>'match', 'created_variant', (v_line->>'created')::boolean, 'quantity', v_qty);
  END LOOP;

  RETURN jsonb_build_object('shipment_id', v_ship, 'pieces', v_pieces, 'replayed', false, 'items', v_items);
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. Recibir: «Todo llegó» (p_missing vacío) o «Falta algo»
--    (p_missing = [{ item_id, missing }]). Lo que falta vuelve al origen.
--    Devuelve jsonb: { shipment_id, status, missing }.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.receive_shipment(
  p_shipment_id uuid,
  p_missing     jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      uuid := auth.uid();
  v_role     text;
  v_assigned uuid;
  v_active   boolean;
  s          public.store_shipments%ROWTYPE;
  it         record;
  v_total    integer := 0;
  v_now      integer;
BEGIN
  SELECT role::text, assigned_store_id, is_active
    INTO v_role, v_assigned, v_active
    FROM public.profiles WHERE id = v_uid;
  IF v_role IS NULL OR NOT COALESCE(v_active, false) OR v_role NOT IN ('owner', 'cashier') THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;
  IF p_shipment_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS';
  END IF;

  SELECT * INTO s FROM public.store_shipments WHERE id = p_shipment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SHIPMENT_NOT_FOUND';
  END IF;
  IF v_role <> 'owner' AND v_assigned IS DISTINCT FROM s.to_store_id THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED_STORE';
  END IF;
  IF s.status <> 'pendiente' THEN
    RAISE EXCEPTION 'SHIPMENT_NOT_PENDING';
  END IF;

  IF p_missing IS NOT NULL AND jsonb_typeof(p_missing) <> 'array' THEN
    RAISE EXCEPTION 'MISSING_INVALID';
  END IF;

  -- Cada faltante es de una pieza de ESTE envío y no supera lo enviado.
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(COALESCE(p_missing, '[]'::jsonb)) m
      LEFT JOIN public.store_shipment_items si
             ON si.id = NULLIF(m->>'item_id', '')::uuid AND si.shipment_id = s.id
     WHERE si.id IS NULL
        OR NULLIF(m->>'missing', '')::integer IS NULL
        OR (m->>'missing')::integer < 0
        OR (m->>'missing')::integer > si.quantity
  ) THEN
    RAISE EXCEPTION 'MISSING_INVALID';
  END IF;
  -- Cada pieza una sola vez: repetida, devolvería dos veces lo que falta.
  IF (SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(p_missing, '[]'::jsonb)))
     <> (SELECT COUNT(DISTINCT m->>'item_id') FROM jsonb_array_elements(COALESCE(p_missing, '[]'::jsonb)) m) THEN
    RAISE EXCEPTION 'MISSING_INVALID';
  END IF;

  -- Bloquear las filas que se tocan, en orden fijo.
  PERFORM 1
     FROM public.store_stock st
    WHERE (st.product_id, st.store_id) IN (
            SELECT si.target_product_id, s.to_store_id FROM public.store_shipment_items si WHERE si.shipment_id = s.id
            UNION
            SELECT si.product_id, s.from_store_id FROM public.store_shipment_items si WHERE si.shipment_id = s.id)
    ORDER BY st.product_id, st.store_id
      FOR UPDATE;

  FOR it IN
    SELECT si.*, (m->>'missing')::integer AS m_qty, tp.sku_barcode AS target_sku
      FROM jsonb_array_elements(COALESCE(p_missing, '[]'::jsonb)) m
      JOIN public.store_shipment_items si ON si.id = (m->>'item_id')::uuid
      JOIN public.products tp ON tp.id = si.target_product_id
     WHERE (m->>'missing')::integer > 0
     ORDER BY si.sort
  LOOP
    SELECT COALESCE(stock, 0) INTO v_now
      FROM public.store_stock WHERE product_id = it.target_product_id AND store_id = s.to_store_id;
    IF v_now - it.m_qty < LEAST(0, it.target_stock_after - it.quantity) THEN
      RAISE EXCEPTION 'SOLD_IN_DESTINATION:%', it.target_sku;
    END IF;

    UPDATE public.store_stock SET stock = COALESCE(stock, 0) - it.m_qty
     WHERE product_id = it.target_product_id AND store_id = s.to_store_id;
    UPDATE public.store_stock SET stock = COALESCE(stock, 0) + it.m_qty
     WHERE product_id = it.product_id AND store_id = s.from_store_id;
    UPDATE public.store_shipment_items SET missing = it.m_qty WHERE id = it.id;
    v_total := v_total + it.m_qty;
  END LOOP;

  UPDATE public.store_shipments
     SET status = CASE WHEN v_total > 0 THEN 'incompleto' ELSE 'recibido' END,
         received_by = v_uid,
         received_at = now()
   WHERE id = s.id;

  -- Una variante nueva de la que no llegó nada se da de baja.
  IF v_total > 0 THEN
    PERFORM public._traslado_cleanup_variant(si.target_product_id)
       FROM public.store_shipment_items si
      WHERE si.shipment_id = s.id AND si.created_variant AND si.missing > 0;
  END IF;

  RETURN jsonb_build_object(
    'shipment_id', s.id,
    'status', CASE WHEN v_total > 0 THEN 'incompleto' ELSE 'recibido' END,
    'missing', v_total);
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. Deshacer: todo lo que llegó vuelve a la tienda de origen.
--    Devuelve jsonb: { shipment_id, status, pieces }.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.undo_shipment(p_shipment_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      uuid := auth.uid();
  v_role     text;
  v_assigned uuid;
  v_active   boolean;
  s          public.store_shipments%ROWTYPE;
  it         record;
  v_back     integer;
  v_now      integer;
  v_total    integer := 0;
BEGIN
  SELECT role::text, assigned_store_id, is_active
    INTO v_role, v_assigned, v_active
    FROM public.profiles WHERE id = v_uid;
  IF v_role IS NULL OR NOT COALESCE(v_active, false) OR v_role NOT IN ('owner', 'cashier') THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;
  IF p_shipment_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS';
  END IF;

  SELECT * INTO s FROM public.store_shipments WHERE id = p_shipment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SHIPMENT_NOT_FOUND';
  END IF;
  IF s.status = 'deshecho' THEN
    RAISE EXCEPTION 'ALREADY_UNDONE';
  END IF;
  IF s.status <> 'pendiente' AND v_role <> 'owner' THEN
    RAISE EXCEPTION 'ONLY_OWNER_AFTER_RECEIVED';
  END IF;
  IF v_role <> 'owner' AND v_assigned IS DISTINCT FROM s.from_store_id THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED_STORE';
  END IF;

  PERFORM 1
     FROM public.store_stock st
    WHERE (st.product_id, st.store_id) IN (
            SELECT si.target_product_id, s.to_store_id FROM public.store_shipment_items si WHERE si.shipment_id = s.id
            UNION
            SELECT si.product_id, s.from_store_id FROM public.store_shipment_items si WHERE si.shipment_id = s.id)
    ORDER BY st.product_id, st.store_id
      FOR UPDATE;

  FOR it IN
    SELECT si.*, tp.sku_barcode AS target_sku
      FROM public.store_shipment_items si
      JOIN public.products tp ON tp.id = si.target_product_id
     WHERE si.shipment_id = s.id AND si.quantity > si.missing
     ORDER BY si.sort
  LOOP
    v_back := it.quantity - it.missing;
    SELECT COALESCE(stock, 0) INTO v_now
      FROM public.store_stock WHERE product_id = it.target_product_id AND store_id = s.to_store_id;
    -- El destino no puede quedar por debajo de donde estaba antes del envío.
    IF v_now - v_back < LEAST(0, it.target_stock_after - it.quantity) THEN
      RAISE EXCEPTION 'SOLD_IN_DESTINATION:%', it.target_sku;
    END IF;

    UPDATE public.store_stock SET stock = COALESCE(stock, 0) - v_back
     WHERE product_id = it.target_product_id AND store_id = s.to_store_id;
    UPDATE public.store_stock SET stock = COALESCE(stock, 0) + v_back
     WHERE product_id = it.product_id AND store_id = s.from_store_id;
    v_total := v_total + v_back;
  END LOOP;

  UPDATE public.store_shipments
     SET status = 'deshecho', undone_by = v_uid, undone_at = now()
   WHERE id = s.id;

  PERFORM public._traslado_cleanup_variant(si.target_product_id)
     FROM public.store_shipment_items si
    WHERE si.shipment_id = s.id AND si.created_variant;

  RETURN jsonb_build_object('shipment_id', s.id, 'status', 'deshecho', 'pieces', v_total);
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. Enlazar al recibir: una pieza que llegó «con su padre de origen» pasa al
--    producto o modelo que la tienda destino elige. Solo con el envío
--    pendiente. Devuelve jsonb: { item_id, target_product_id, created_variant }.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.relink_shipment_item(
  p_item_id           uuid,
  p_target_group_id   uuid DEFAULT NULL,
  p_target_product_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      uuid := auth.uid();
  v_role     text;
  v_assigned uuid;
  v_active   boolean;
  it         public.store_shipment_items%ROWTYPE;
  s          public.store_shipments%ROWTYPE;
  p          public.products%ROWTYPE;
  v_target   uuid;
  v_created  boolean := false;
  v_qty      integer;
  v_now      integer;
  v_to       integer;
  v_tprice   numeric;
BEGIN
  SELECT role::text, assigned_store_id, is_active
    INTO v_role, v_assigned, v_active
    FROM public.profiles WHERE id = v_uid;
  IF v_role IS NULL OR NOT COALESCE(v_active, false) OR v_role NOT IN ('owner', 'cashier') THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;
  IF p_item_id IS NULL OR (p_target_group_id IS NULL AND p_target_product_id IS NULL) THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS';
  END IF;

  SELECT * INTO it FROM public.store_shipment_items WHERE id = p_item_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SHIPMENT_NOT_FOUND';
  END IF;
  SELECT * INTO s FROM public.store_shipments WHERE id = it.shipment_id FOR UPDATE;
  IF v_role <> 'owner' AND v_assigned IS DISTINCT FROM s.to_store_id THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED_STORE';
  END IF;
  IF s.status <> 'pendiente' THEN
    RAISE EXCEPTION 'SHIPMENT_NOT_PENDING';
  END IF;
  -- Releer con el envío bloqueado (otro enlace pudo llegar antes).
  SELECT * INTO it FROM public.store_shipment_items WHERE id = p_item_id;
  IF it.match <> 'origen' THEN
    RAISE EXCEPTION 'ITEM_NOT_RELINKABLE';
  END IF;

  SELECT * INTO p FROM public.products WHERE id = it.product_id;

  IF p_target_product_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.products
                    WHERE id = p_target_product_id AND COALESCE(is_active, false) AND owner_store_id = s.to_store_id) THEN
      RAISE EXCEPTION 'TARGET_INVALID:%', p.sku_barcode;
    END IF;
    v_target := p_target_product_id;
    IF it.size IS NULL THEN
      PERFORM public._traslado_link_products(p.id, v_target, v_uid);
    END IF;
  ELSE
    PERFORM 1 FROM public.product_groups
     WHERE id = p_target_group_id AND is_active AND owner_store_id = s.to_store_id
       FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'TARGET_INVALID:%', p.sku_barcode;
    END IF;
    SELECT o_product, o_created INTO v_target, v_created
      FROM public._traslado_variant_in_group(p_target_group_id, p.id, it.size);
    IF p.parent_group_id IS NOT NULL THEN
      PERFORM public._traslado_link_groups(p.parent_group_id, p_target_group_id, v_uid);
    END IF;
    IF it.size IS NULL THEN
      PERFORM public._traslado_link_products(p.id, v_target, v_uid);
    END IF;
  END IF;

  INSERT INTO public.store_stock (product_id, store_id, stock)
  VALUES (v_target, s.to_store_id, 0)
  ON CONFLICT (product_id, store_id) DO NOTHING;

  PERFORM 1
     FROM public.store_stock st
    WHERE st.store_id = s.to_store_id AND st.product_id IN (it.product_id, v_target)
    ORDER BY st.product_id, st.store_id
      FOR UPDATE;

  v_qty := it.quantity - it.missing;
  SELECT COALESCE(stock, 0) INTO v_now
    FROM public.store_stock WHERE product_id = it.product_id AND store_id = s.to_store_id;
  IF v_now - v_qty < LEAST(0, it.target_stock_after - it.quantity) THEN
    RAISE EXCEPTION 'SOLD_IN_DESTINATION:%', p.sku_barcode;
  END IF;

  UPDATE public.store_stock SET stock = COALESCE(stock, 0) - v_qty
   WHERE product_id = it.product_id AND store_id = s.to_store_id;
  UPDATE public.store_stock SET stock = COALESCE(stock, 0) + v_qty
   WHERE product_id = v_target AND store_id = s.to_store_id
  RETURNING stock INTO v_to;

  SELECT price INTO v_tprice FROM public.products WHERE id = v_target;

  UPDATE public.store_shipment_items
     SET target_product_id = v_target,
         match = 'elegido',
         created_variant = v_created,
         target_stock_after = v_to,
         target_price = v_tprice
   WHERE id = it.id;

  RETURN jsonb_build_object('item_id', it.id, 'target_product_id', v_target, 'created_variant', v_created);
END;
$$;

REVOKE ALL ON FUNCTION public.send_shipment(uuid, uuid, text, jsonb, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.receive_shipment(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.undo_shipment(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.relink_shipment_item(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_shipment(uuid, uuid, text, jsonb, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.receive_shipment(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.undo_shipment(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.relink_shipment_item(uuid, uuid, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- VERIFICACIÓN. Tiene que dar:
--   las 4 tablas con rls_activa = true y politicas = 1,
--   rpc: los 4 con versiones = 1, security_definer = true, ejecutable = true,
--   ayudantes_cerrados = true (la API no puede llamar a los _traslado_*),
--   envios = 0 y enlaces = 0 (la primera vez),
--   suma_stock_total = el mismo número que antes de correr el archivo.
-- ============================================================================
SELECT jsonb_pretty(jsonb_build_object(
  'tablas', (
    SELECT jsonb_object_agg(c.relname, jsonb_build_object(
             'rls_activa', c.relrowsecurity,
             'politicas', (SELECT COUNT(*) FROM pg_policies pp
                            WHERE pp.schemaname = 'public' AND pp.tablename = c.relname)))
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname IN ('store_shipments', 'store_shipment_items', 'product_twins', 'group_twins')
  ),
  'rpc', (
    SELECT jsonb_object_agg(f.name, jsonb_build_object(
             'versiones', (SELECT COUNT(*) FROM pg_proc pr JOIN pg_namespace n ON n.oid = pr.pronamespace
                            WHERE n.nspname = 'public' AND pr.proname = f.name),
             'security_definer', (SELECT bool_and(pr.prosecdef) FROM pg_proc pr JOIN pg_namespace n ON n.oid = pr.pronamespace
                                   WHERE n.nspname = 'public' AND pr.proname = f.name),
             'ejecutable', has_function_privilege('authenticated', f.sig, 'EXECUTE')))
      FROM (VALUES ('send_shipment', 'public.send_shipment(uuid, uuid, text, jsonb, uuid)'),
                   ('receive_shipment', 'public.receive_shipment(uuid, jsonb)'),
                   ('undo_shipment', 'public.undo_shipment(uuid)'),
                   ('relink_shipment_item', 'public.relink_shipment_item(uuid, uuid, uuid)')) AS f(name, sig)
  ),
  'ayudantes_cerrados', NOT (
       has_function_privilege('authenticated', 'public._traslado_link_products(uuid, uuid, uuid)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public._traslado_link_groups(uuid, uuid, uuid)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public._traslado_variant_in_group(uuid, uuid, text)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public._traslado_cleanup_variant(uuid)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.send_shipment(uuid, uuid, text, jsonb, uuid)', 'EXECUTE')
  ),
  'envios', (SELECT COUNT(*) FROM public.store_shipments),
  'enlaces', (SELECT COUNT(*) FROM public.product_twins) + (SELECT COUNT(*) FROM public.group_twins),
  'suma_stock_total', (SELECT SUM(stock) FROM public.store_stock)
));
