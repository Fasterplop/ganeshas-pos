-- ============================================================================
-- MODULO DE FINANZAS - esquema completo (solo el owner).
--
-- Que resuelve: hoy el dueno lleva las finanzas fuera del sistema. Compra a
-- varias marcas, paga con distintas tarjetas y cuentas, y no sabe cuanto debe
-- ni cuando vence. Y sobre todo: envia varias cajas en dias distintos y no
-- sabe que llevo cada una (lo anota en notas sueltas y se le pierde).
--
-- !! POR QUE LAS POLITICAS VAN EN ESTE MISMO ARCHIVO:
-- esta base tiene el event trigger `ensure_rls` -> `rls_auto_enable()`, que
-- activa RLS sola en CADA `CREATE TABLE` de public. Una tabla nueva sin
-- politicas no queda "abierta": queda BLOQUEADA para todos, y PostgREST
-- devuelve lista vacia SIN ERROR. Eso ya paso con customer_points_adjustments
-- (bug silencioso en produccion, ver db/rls_01_activar.sql:19-25). Por eso el
-- Bloque 4 es obligatorio: sin el, el modulo entero "funciona" y no muestra
-- nada.
--
-- !! NO DEJAR ESTE ARCHIVO A MEDIAS. Si hay que parar, correr al menos hasta
-- el final del Bloque 4. Lo ideal es correrlo entero de una vez.
--
-- ALCANCE: todo el modulo es DEL NEGOCIO, no de una sucursal. No hay store_id
-- en ninguna tabla: el dueno ve las mismas finanzas este en la tienda que
-- este. La Amex paga para cualquier sucursal, LC Lizette le vende al negocio y
-- una caja que llega es la misma caja desde donde se mire.
--
-- Aislamiento: ninguna tabla existente del POS recibe FK hacia fin_*, y este
-- archivo no modifica ni una sola tabla del POS. Se puede revertir entero con
-- db/finanzas_99_rollback.sql sin tocar ventas, productos ni stock.
--
-- Es idempotente: correrlo dos veces seguidas debe terminar sin error.
-- Aplicar en el SQL Editor de Supabase.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- BLOQUE 1 - Maestros del negocio: proveedores, categorias, cuentas y tarjetas.
--
-- Como todo el modulo, son del negocio y no de una sucursal: la Amex paga para
-- cualquier tienda y LC Lizette le vende al negocio, no a un local.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.fin_suppliers (
  id            uuid NOT NULL DEFAULT uuid_generate_v4(),
  name          text NOT NULL,
  contact_name  text,
  phone         text,
  email         text,
  payment_terms text NOT NULL DEFAULT 'contado'
                CHECK (payment_terms IN ('contado','15_dias','30_dias','consignacion','otro')),
  notes         text,
  is_active     boolean NOT NULL DEFAULT true,
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fin_suppliers_pkey PRIMARY KEY (id),
  CONSTRAINT fin_suppliers_author_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id)
);

-- Evita que "Kancan" y "kancan" terminen siendo dos marcas distintas, que es
-- como se parte en dos el estado de cuenta de un proveedor sin darse cuenta.
CREATE UNIQUE INDEX IF NOT EXISTS idx_fin_suppliers_name_uniq
  ON public.fin_suppliers (lower(name));


CREATE TABLE IF NOT EXISTS public.fin_categories (
  id         uuid NOT NULL DEFAULT uuid_generate_v4(),
  name       text NOT NULL,
  kind       text NOT NULL DEFAULT 'gasto' CHECK (kind IN ('compra','gasto')),
  sort_order integer NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fin_categories_pkey PRIMARY KEY (id),
  CONSTRAINT fin_categories_author_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fin_categories_name_uniq
  ON public.fin_categories (lower(name));


-- Cuentas y tarjetas en UNA sola tabla, distinguidas por `kind`.
--
-- Por que una y no dos: el 90% de los campos son compartidos, y cada egreso
-- necesita apuntar a "de donde salio el dinero" con UN solo FK. Dos tablas
-- obligarian a un FK polimorfico (account_kind + account_id) en pagos y
-- compras, que es justo el tipo de complicacion que el resto del codigo evita.
--
-- SEGURIDAD (exigencia explicita de la propuesta al cliente): de una tarjeta
-- se guardan SOLO el alias, el banco y los ultimos 4 digitos. NO existe
-- columna para el numero completo, ni para el CVV, ni para claves. El CHECK de
-- exactamente 4 digitos impide que alguien pegue ahi el numero entero por
-- descuido.
CREATE TABLE IF NOT EXISTS public.fin_accounts (
  id                   uuid NOT NULL DEFAULT uuid_generate_v4(),
  name                 text NOT NULL,
  kind                 text NOT NULL CHECK (kind IN ('banco','zelle','efectivo','tarjeta_credito','otro')),
  bank_name            text,
  last4                varchar(4) CHECK (last4 ~ '^[0-9]{4}$'),
  currency             text NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD','VES')),

  -- Arranque real: con que saldo (o que deuda, si es tarjeta) y desde que
  -- fecha entra la cuenta al sistema. Sin esto el modulo miente los primeros
  -- meses. Tambien es el punto de reconciliacion: despues de pagarle a la
  -- tarjeta, se ajusta aqui.
  opening_balance_usd  numeric NOT NULL DEFAULT 0,
  opening_balance_date date,

  credit_limit_usd     numeric CHECK (credit_limit_usd IS NULL OR credit_limit_usd > 0),
  statement_day        smallint CHECK (statement_day BETWEEN 1 AND 31),
  due_day              smallint CHECK (due_day BETWEEN 1 AND 31),
  is_personal          boolean NOT NULL DEFAULT false,
  is_active            boolean NOT NULL DEFAULT true,
  notes                text,
  created_by           uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fin_accounts_pkey PRIMARY KEY (id),
  CONSTRAINT fin_accounts_author_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id),
  -- Limite y fechas de corte/pago solo tienen sentido en una tarjeta.
  CONSTRAINT fin_accounts_card_fields CHECK (
    kind = 'tarjeta_credito'
    OR (credit_limit_usd IS NULL AND statement_day IS NULL AND due_day IS NULL)
  )
);

-- Semilla de categorias. El cliente las edita y crea las suyas desde la app;
-- esto es solo para que no arranque con una lista vacia. Idempotente.
DO $seed$
DECLARE
  v_owner uuid;
BEGIN
  SELECT id INTO v_owner
    FROM public.profiles
   WHERE role::text = 'owner' AND COALESCE(is_active, true)
   ORDER BY full_name
   LIMIT 1;

  IF v_owner IS NULL THEN
    RAISE NOTICE 'Sin perfil owner activo: se omite la semilla de categorias.';
    RETURN;
  END IF;

  INSERT INTO public.fin_categories (name, kind, sort_order, created_by)
  SELECT s.name, s.kind, s.ord, v_owner
    FROM (VALUES
            ('Mercancia',   'compra', 10),
            ('Envio/Flete', 'compra', 20),
            ('Alquiler',    'gasto',  30),
            ('Nomina',      'gasto',  40),
            ('Servicios',   'gasto',  50),
            ('Suscripciones','gasto',  55),
            ('Publicidad',  'gasto',  60),
            ('Transporte',  'gasto',  70),
            ('Papeleria',   'gasto',  80)
         ) AS s(name, kind, ord)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.fin_categories c WHERE lower(c.name) = lower(s.name)
   );
END
$seed$;


-- ----------------------------------------------------------------------------
-- BLOQUE 2 - Control de envio de cajas.
--
-- Va antes que los egresos porque es lo primero que se entrega: el cliente
-- necesita dejar de perder las notas YA, antes de que exista el registro de
-- compras.
-- ----------------------------------------------------------------------------

-- Se pide lo minimo: como se llama la caja, cuando salio, su guia y que lleva
-- dentro. Numero de caja, agencia, llegada estimada, piezas y peso se quitaron
-- porque no se llenaban nunca (db/finanzas_04_cajas_simples.sql), y un
-- formulario con campos que nadie llena es un formulario que se deja de usar.
--
-- received_date SI se queda: no se pide al crear, lo pone sola la app cuando
-- se marca la caja como recibida.
CREATE TABLE IF NOT EXISTS public.fin_shipments (
  id            uuid NOT NULL DEFAULT uuid_generate_v4(),
  alias         text NOT NULL,
  status        text NOT NULL DEFAULT 'preparada'
                CHECK (status IN ('preparada','enviada','en_transito','recibida','recibida_incompleta')),
  tracking_code text,
  sent_date     date,
  received_date date,
  document_path text,
  notes         text,
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fin_shipments_pkey PRIMARY KEY (id),
  CONSTRAINT fin_shipments_author_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id)
);

-- "Que esta en camino" es la consulta que la app hace al abrir la seccion.
CREATE INDEX IF NOT EXISTS idx_fin_shipments_incoming
  ON public.fin_shipments (sent_date)
  WHERE status IN ('enviada','en_transito');


-- Contenido de la caja. La pieza que resuelve el dolor principal.
--
-- expense_id es NULLABLE A PROPOSITO: en la primera entrega el contenido se
-- escribe a mano ("10 blusas Kancan") porque todavia no existe el registro de
-- compras. Cuando llegue, esa MISMA fila recibe su expense_id y no hay que
-- recargar nada.
--
-- SIN COLUMNA DEL MONTO DEL GASTO, a proposito: el gasto vive 100% en
-- fin_expenses y los reportes suman fin_expenses.amount_usd, nunca esta tabla.
-- Por eso una compra repartida en tres cajas genera tres filas aqui y el gasto
-- se sigue contando UNA sola vez. `allocated_usd` es informativo (para el
-- "costo real por caja") y ningun reporte lo suma jamas.
CREATE TABLE IF NOT EXISTS public.fin_shipment_items (
  id               uuid NOT NULL DEFAULT uuid_generate_v4(),
  shipment_id      uuid NOT NULL,
  expense_id       uuid,
  supplier_id      uuid,
  purchase_line_id uuid,
  description      text,
  pieces           integer CHECK (pieces IS NULL OR pieces >= 0),
  received_pieces  integer CHECK (received_pieces IS NULL OR received_pieces >= 0),
  is_received      boolean NOT NULL DEFAULT false,
  allocated_usd    numeric CHECK (allocated_usd IS NULL OR allocated_usd >= 0),
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fin_shipment_items_pkey PRIMARY KEY (id),
  CONSTRAINT fin_shipment_items_shipment_fkey
    FOREIGN KEY (shipment_id) REFERENCES public.fin_shipments(id) ON DELETE CASCADE,
  -- Una fila sin compra y sin texto no dice nada.
  CONSTRAINT fin_shipment_items_content CHECK (expense_id IS NOT NULL OR description IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_fin_shipment_items_shipment
  ON public.fin_shipment_items (shipment_id);
CREATE INDEX IF NOT EXISTS idx_fin_shipment_items_expense
  ON public.fin_shipment_items (expense_id);

-- Cuantas cajas fisicas van en el envio y de que tamano.
--
-- Es una tabla y no una columna porque un envio lleva varios tamanos a la vez
-- ("2 grandes y 1 mediana"), y asi se puede sumar por tamano en los reportes
-- sin parsear texto. El total de cajas NO se guarda: se suma de aqui, para no
-- tener dos numeros que puedan contradecirse.
--
-- `size` es texto libre a proposito: la app sugiere los tamanos habituales,
-- pero el courier de turno puede tener los suyos.
CREATE TABLE IF NOT EXISTS public.fin_shipment_boxes (
  id          uuid NOT NULL DEFAULT uuid_generate_v4(),
  shipment_id uuid NOT NULL,
  size        text NOT NULL,
  quantity    integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  sort_order  integer NOT NULL DEFAULT 0,
  CONSTRAINT fin_shipment_boxes_pkey PRIMARY KEY (id),
  CONSTRAINT fin_shipment_boxes_shipment_fkey
    FOREIGN KEY (shipment_id) REFERENCES public.fin_shipments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fin_shipment_boxes_shipment
  ON public.fin_shipment_boxes (shipment_id);


-- ----------------------------------------------------------------------------
-- BLOQUE 3 - Egresos, lineas, pagos y presupuesto.
--
-- UN solo tipo de documento de egreso: una compra a proveedor y un gasto
-- operativo comparten monto, fecha, cuenta, estado, categoria, nota y foto.
-- Separarlos en dos tablas duplicaria la maquinaria de abonos, calendario,
-- export y dashboard. Se distinguen por `kind`.
--
-- MONEDA: amount_usd es obligatorio y es LO UNICO que suman los reportes.
-- currency + amount + bcv_rate guardan como se capturo, para el respaldo y la
-- auditoria, pero nunca se suman. Es el mismo criterio que ya usa
-- sales.bcv_rate: la tasa se congela en el documento, asi una compra de marzo
-- sigue valiendo lo mismo cuando se mire en septiembre.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.fin_expenses (
  id           uuid NOT NULL DEFAULT uuid_generate_v4(),
  kind         text NOT NULL CHECK (kind IN ('compra','gasto','envio')),
  supplier_id  uuid,
  category_id  uuid,
  shipment_id  uuid,
  description  text,

  currency     text NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD','VES')),
  amount       numeric NOT NULL CHECK (amount > 0),
  bcv_rate     numeric CHECK (bcv_rate IS NULL OR bcv_rate > 0),
  amount_usd   numeric NOT NULL CHECK (amount_usd > 0),

  expense_date date NOT NULL,
  due_date     date,

  -- Materializados por trigger desde fin_payments. Se guardan en vez de
  -- calcularse en cada consulta porque el calendario y el dashboard filtran
  -- por status y due_date todo el tiempo, y el indice parcial de abajo es lo
  -- que hace esa consulta instantanea.
  paid_usd     numeric NOT NULL DEFAULT 0 CHECK (paid_usd >= 0),
  status       text NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pagada','parcial','pendiente')),

  is_personal  boolean NOT NULL DEFAULT false,
  receipt_path text,
  notes        text,
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fin_expenses_pkey PRIMARY KEY (id),
  CONSTRAINT fin_expenses_supplier_fkey FOREIGN KEY (supplier_id) REFERENCES public.fin_suppliers(id),
  CONSTRAINT fin_expenses_category_fkey FOREIGN KEY (category_id) REFERENCES public.fin_categories(id),
  CONSTRAINT fin_expenses_shipment_fkey FOREIGN KEY (shipment_id) REFERENCES public.fin_shipments(id) ON DELETE SET NULL,
  CONSTRAINT fin_expenses_author_fkey   FOREIGN KEY (created_by)  REFERENCES public.profiles(id),
  -- Una compra siempre tiene proveedor; un gasto operativo no lo necesita.
  CONSTRAINT fin_expenses_supplier_req CHECK (kind <> 'compra' OR supplier_id IS NOT NULL),
  -- Sin tasa, un monto en Bs no se puede auditar despues.
  CONSTRAINT fin_expenses_rate_req     CHECK (currency <> 'VES' OR bcv_rate IS NOT NULL)
);


-- Lineas opcionales de una compra: INFORMATIVAS. No se enlazan a products (el
-- catalogo real no se toca) y NO tienen que sumar el total de la compra: el
-- total del documento es el que manda.
CREATE TABLE IF NOT EXISTS public.fin_purchase_lines (
  id             uuid NOT NULL DEFAULT uuid_generate_v4(),
  expense_id     uuid NOT NULL,
  description    text NOT NULL,
  quantity       numeric NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_cost_usd  numeric CHECK (unit_cost_usd IS NULL OR unit_cost_usd >= 0),
  line_total_usd numeric CHECK (line_total_usd IS NULL OR line_total_usd >= 0),
  sort_order     integer NOT NULL DEFAULT 0,
  CONSTRAINT fin_purchase_lines_pkey PRIMARY KEY (id),
  CONSTRAINT fin_purchase_lines_expense_fkey
    FOREIGN KEY (expense_id) REFERENCES public.fin_expenses(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fin_purchase_lines_expense
  ON public.fin_purchase_lines (expense_id);


-- Pagos y abonos. Una sola tabla resuelve dos requisitos de la propuesta:
--   - abono parcial : una fila que no cubre el total
--   - pago mixto    : dos filas, mismo expense_id, distinto account_id
-- Es tambien el libro de movimientos de cada cuenta.
CREATE TABLE IF NOT EXISTS public.fin_payments (
  id         uuid NOT NULL DEFAULT uuid_generate_v4(),
  expense_id uuid NOT NULL,
  account_id uuid NOT NULL,
  currency   text NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD','VES')),
  amount     numeric NOT NULL CHECK (amount > 0),
  bcv_rate   numeric CHECK (bcv_rate IS NULL OR bcv_rate > 0),
  amount_usd numeric NOT NULL CHECK (amount_usd > 0),
  paid_at    date NOT NULL,
  reference  text,
  notes      text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fin_payments_pkey PRIMARY KEY (id),
  CONSTRAINT fin_payments_expense_fkey FOREIGN KEY (expense_id) REFERENCES public.fin_expenses(id) ON DELETE CASCADE,
  CONSTRAINT fin_payments_account_fkey FOREIGN KEY (account_id) REFERENCES public.fin_accounts(id),
  CONSTRAINT fin_payments_author_fkey  FOREIGN KEY (created_by) REFERENCES public.profiles(id),
  CONSTRAINT fin_payments_rate_req     CHECK (currency <> 'VES' OR bcv_rate IS NOT NULL)
);


CREATE TABLE IF NOT EXISTS public.fin_budgets (
  id           uuid NOT NULL DEFAULT uuid_generate_v4(),
  category_id  uuid NOT NULL,
  period_month date NOT NULL CHECK (period_month = date_trunc('month', period_month)::date),
  amount_usd   numeric NOT NULL CHECK (amount_usd >= 0),
  created_by   uuid NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fin_budgets_pkey PRIMARY KEY (id),
  CONSTRAINT fin_budgets_uniq UNIQUE (category_id, period_month),
  CONSTRAINT fin_budgets_category_fkey FOREIGN KEY (category_id) REFERENCES public.fin_categories(id),
  CONSTRAINT fin_budgets_author_fkey   FOREIGN KEY (created_by)  REFERENCES public.profiles(id)
);


-- FKs que el Bloque 2 dejo pendientes, ahora que fin_expenses y
-- fin_purchase_lines existen.
--
-- ON DELETE SET NULL y no CASCADE: borrar una compra NO puede borrar el
-- historial de que traia una caja. La fila sobrevive con su texto libre.
DO $fks$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fin_shipment_items_expense_fkey') THEN
    ALTER TABLE public.fin_shipment_items
      ADD CONSTRAINT fin_shipment_items_expense_fkey
      FOREIGN KEY (expense_id) REFERENCES public.fin_expenses(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fin_shipment_items_supplier_fkey') THEN
    ALTER TABLE public.fin_shipment_items
      ADD CONSTRAINT fin_shipment_items_supplier_fkey
      FOREIGN KEY (supplier_id) REFERENCES public.fin_suppliers(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fin_shipment_items_line_fkey') THEN
    ALTER TABLE public.fin_shipment_items
      ADD CONSTRAINT fin_shipment_items_line_fkey
      FOREIGN KEY (purchase_line_id) REFERENCES public.fin_purchase_lines(id) ON DELETE SET NULL;
  END IF;
END
$fks$;


-- Indices de las consultas que la app hace todo el tiempo.
CREATE INDEX IF NOT EXISTS idx_fin_expenses_date
  ON public.fin_expenses (expense_date DESC);

-- El calendario de pagos: "que vence y todavia no esta pagado".
CREATE INDEX IF NOT EXISTS idx_fin_expenses_due
  ON public.fin_expenses (due_date)
  WHERE status <> 'pagada' AND due_date IS NOT NULL;

-- Estado de cuenta por proveedor.
CREATE INDEX IF NOT EXISTS idx_fin_expenses_supplier
  ON public.fin_expenses (supplier_id, expense_date DESC);

-- Deteccion de compra duplicada (mismo proveedor + fecha + monto), que es el
-- caso "compra registrada dos veces" de la propuesta.
CREATE INDEX IF NOT EXISTS idx_fin_expenses_dupe
  ON public.fin_expenses (supplier_id, expense_date, amount_usd);

CREATE INDEX IF NOT EXISTS idx_fin_expenses_shipment
  ON public.fin_expenses (shipment_id) WHERE shipment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_fin_payments_expense ON public.fin_payments (expense_id);
CREATE INDEX IF NOT EXISTS idx_fin_payments_account ON public.fin_payments (account_id, paid_at DESC);

CREATE INDEX IF NOT EXISTS idx_fin_budgets_lookup
  ON public.fin_budgets (period_month);


-- Trigger que mantiene paid_usd y status de una compra a partir de sus pagos.
--
-- El margen de 0.005 evita que un centavo de redondeo (tipico al convertir de
-- Bs) deje una compra eternamente en "parcial" cuando ya esta saldada.
CREATE OR REPLACE FUNCTION public.fin_sync_expense_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_expense_id uuid := COALESCE(NEW.expense_id, OLD.expense_id);
BEGIN
  UPDATE public.fin_expenses e
     SET paid_usd = COALESCE(p.total, 0),
         status = CASE
                    WHEN COALESCE(p.total, 0) >= e.amount_usd - 0.005 THEN 'pagada'
                    WHEN COALESCE(p.total, 0) > 0                     THEN 'parcial'
                    ELSE 'pendiente'
                  END
    FROM (SELECT SUM(amount_usd) AS total
            FROM public.fin_payments
           WHERE expense_id = v_expense_id) p
   WHERE e.id = v_expense_id;
  RETURN NULL;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_fin_payments_sync ON public.fin_payments;
CREATE TRIGGER trg_fin_payments_sync
  AFTER INSERT OR UPDATE OR DELETE ON public.fin_payments
  FOR EACH ROW EXECUTE FUNCTION public.fin_sync_expense_status();


-- Si se corrige el monto de una compra, su estado puede quedar desfasado
-- (bajarlo de $300 a $100 con $100 ya abonado deberia dejarla "pagada").
CREATE OR REPLACE FUNCTION public.fin_resync_own_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn2$
BEGIN
  NEW.paid_usd := COALESCE((SELECT SUM(amount_usd) FROM public.fin_payments WHERE expense_id = NEW.id), 0);
  NEW.status := CASE
                  WHEN NEW.paid_usd >= NEW.amount_usd - 0.005 THEN 'pagada'
                  WHEN NEW.paid_usd > 0                       THEN 'parcial'
                  ELSE 'pendiente'
                END;
  RETURN NEW;
END;
$fn2$;

DROP TRIGGER IF EXISTS trg_fin_expenses_resync ON public.fin_expenses;
CREATE TRIGGER trg_fin_expenses_resync
  BEFORE UPDATE OF amount_usd ON public.fin_expenses
  FOR EACH ROW EXECUTE FUNCTION public.fin_resync_own_status();


-- Reparacion: recalcula lo que haya quedado desfasado. Asi, volver a correr
-- este archivo tambien corrige cualquier desvio de una corrida anterior.
UPDATE public.fin_expenses e
   SET paid_usd = t.total,
       status = CASE
                  WHEN t.total >= e.amount_usd - 0.005 THEN 'pagada'
                  WHEN t.total > 0                     THEN 'parcial'
                  ELSE 'pendiente'
                END
  FROM (
    SELECT e2.id,
           COALESCE((SELECT SUM(amount_usd) FROM public.fin_payments WHERE expense_id = e2.id), 0) AS total
      FROM public.fin_expenses e2
  ) t
 WHERE e.id = t.id
   AND (e.paid_usd IS DISTINCT FROM t.total
        OR e.status IS DISTINCT FROM CASE
                                       WHEN t.total >= e.amount_usd - 0.005 THEN 'pagada'
                                       WHEN t.total > 0                     THEN 'parcial'
                                       ELSE 'pendiente'
                                     END);


-- ----------------------------------------------------------------------------
-- BLOQUE 4 - RLS: el dueno y nadie mas.  [OBLIGATORIO]
--
-- Son 10 tablas x 4 verbos = 40 politicas. Se generan en bucle a proposito:
-- escritas a mano, olvidar UNA deja esa tabla muda y sin error visible, que es
-- exactamente el bug que este bloque existe para evitar. El bucle hace
-- imposible que una tabla de la lista se quede sin sus cuatro politicas.
--
-- A diferencia del resto del POS, aqui se dan los cuatro verbos por politica
-- en vez de por RPC, porque el modulo es AUTOGESTIONABLE: el cliente crea y
-- edita sus cuentas, tarjetas, proveedores, categorias y presupuestos desde el
-- navegador, sin depender de nosotros.
-- ----------------------------------------------------------------------------

-- SECURITY DEFINER para que la politica no dependa de que el usuario pueda
-- leer public.profiles, y STABLE para que Postgres la evalue una vez por
-- consulta y no una vez por fila.
CREATE OR REPLACE FUNCTION public.fin_is_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $isowner$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE p.id = auth.uid() AND p.role::text = 'owner'
  );
$isowner$;

REVOKE ALL ON FUNCTION public.fin_is_owner() FROM public;
GRANT EXECUTE ON FUNCTION public.fin_is_owner() TO authenticated;

DO $rls$
DECLARE
  t text;
  tablas text[] := ARRAY[
    'fin_suppliers', 'fin_categories', 'fin_accounts',
    'fin_shipments', 'fin_shipment_items', 'fin_shipment_boxes',
    'fin_expenses', 'fin_purchase_lines', 'fin_payments', 'fin_budgets'
  ];
BEGIN
  FOREACH t IN ARRAY tablas LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select_owner', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.fin_is_owner())',
      t || '_select_owner', t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_insert_owner', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (public.fin_is_owner())',
      t || '_insert_owner', t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_update_owner', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (public.fin_is_owner()) WITH CHECK (public.fin_is_owner())',
      t || '_update_owner', t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_delete_owner', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (public.fin_is_owner())',
      t || '_delete_owner', t);

    -- Recien ahora, con las cuatro politicas ya puestas (mismo orden que
    -- db/rls_01_activar.sql:43-46,88).
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END
$rls$;


-- ----------------------------------------------------------------------------
-- BLOQUE 5 - Vistas de reporte.
--
-- !! security_invoker = on es OBLIGATORIO. Sin eso una vista corre con los
-- permisos de quien la creo y SE SALTA la RLS de las tablas base: un cajero
-- leeria por la vista lo que la politica le niega por la tabla. Seria un hueco
-- justo en el modulo mas sensible del sistema.
-- ----------------------------------------------------------------------------

-- Saldo, consumo y disponible por cuenta.
--
-- Los reportes NO guardan el saldo: lo derivan. Materializarlo seria una
-- segunda fuente de verdad que se desincroniza en cuanto alguien corrige un
-- pago.
--   - banco / zelle / efectivo : el dinero SALE     -> el saldo baja
--   - tarjeta de credito       : cada pago es deuda -> el consumo sube
--
-- Limitacion conocida: abonarle a la tarjeta (bajar su deuda) todavia no se
-- registra como movimiento; se reconcilia ajustando opening_balance_usd.
CREATE OR REPLACE VIEW public.fin_v_account_balance
WITH (security_invoker = on) AS
SELECT a.id                       AS account_id,
       a.name,
       a.kind,
       a.bank_name,
       a.last4,
       a.is_personal,
       a.is_active,
       a.credit_limit_usd,
       a.statement_day,
       a.due_day,
       a.opening_balance_usd,
       COALESCE(p.moved_usd, 0)   AS moved_usd,
       CASE WHEN a.kind = 'tarjeta_credito'
            THEN a.opening_balance_usd + COALESCE(p.moved_usd, 0)
            ELSE a.opening_balance_usd - COALESCE(p.moved_usd, 0)
       END                        AS balance_usd,
       CASE WHEN a.kind = 'tarjeta_credito' AND a.credit_limit_usd IS NOT NULL
            THEN a.credit_limit_usd - (a.opening_balance_usd + COALESCE(p.moved_usd, 0))
            ELSE NULL
       END                        AS available_usd
  FROM public.fin_accounts a
  LEFT JOIN (
    SELECT account_id, SUM(amount_usd) AS moved_usd
      FROM public.fin_payments
     GROUP BY account_id
  ) p ON p.account_id = a.id;


-- Estado de cuenta por proveedor: facturas abiertas, saldo y proximo
-- vencimiento. Excluye lo personal, que nunca se mezcla con el negocio.
CREATE OR REPLACE VIEW public.fin_v_supplier_balance
WITH (security_invoker = on) AS
SELECT s.id   AS supplier_id,
       s.name,
       s.payment_terms,
       s.is_active,
       COUNT(e.id) FILTER (WHERE e.status <> 'pagada')                        AS open_invoices,
       COALESCE(SUM(e.amount_usd - e.paid_usd)
                FILTER (WHERE e.status <> 'pagada'), 0)                       AS balance_usd,
       MIN(e.due_date) FILTER (WHERE e.status <> 'pagada')                    AS next_due_date,
       COALESCE(SUM(e.amount_usd), 0)                                         AS total_purchased_usd,
       MAX(e.expense_date)                                                    AS last_purchase_date
  FROM public.fin_suppliers s
  LEFT JOIN public.fin_expenses e
    ON e.supplier_id = s.id
   AND e.is_personal = false
 GROUP BY s.id, s.name, s.payment_terms, s.is_active;


-- Presupuesto vs. gastado por categoria, mes y tienda.
CREATE OR REPLACE VIEW public.fin_v_budget_vs_actual
WITH (security_invoker = on) AS
SELECT b.category_id,
       c.name                                   AS category_name,
       b.period_month,
       b.amount_usd                             AS budget_usd,
       COALESCE(g.spent_usd, 0)                 AS spent_usd,
       b.amount_usd - COALESCE(g.spent_usd, 0)  AS remaining_usd,
       CASE WHEN b.amount_usd > 0
            THEN ROUND(COALESCE(g.spent_usd, 0) / b.amount_usd * 100, 1)
            ELSE NULL
       END                                      AS pct_used
  FROM public.fin_budgets b
  JOIN public.fin_categories c ON c.id = b.category_id
  LEFT JOIN LATERAL (
    SELECT SUM(e.amount_usd) AS spent_usd
      FROM public.fin_expenses e
     WHERE e.category_id = b.category_id
       AND e.is_personal = false
       AND date_trunc('month', e.expense_date)::date = b.period_month
  ) g ON true;


-- ----------------------------------------------------------------------------
-- VERIFICACION. Devuelve una sola celda JSON (el editor de Supabase solo
-- muestra el ultimo SELECT).
--
-- Las 10 tablas fin_* deben salir TODAS con rls_activa = true y politicas = 4.
-- Si alguna sale con politicas = 0, esa tabla esta muda: la app no vera ni una
-- fila y no habra ningun error en consola.
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
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'fin\_%'
) s;
