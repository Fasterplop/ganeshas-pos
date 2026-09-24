-- ============================================================================
-- FINANZAS 07 - ChatGPT conectado a Finanzas: tokens y bandeja de revision.
--
-- Que resuelve: el dueno le sube a un GPT personalizado el estado de cuenta del
-- banco y el GPT propone las compras, gastos y abonos que faltan. Nada entra
-- directo: todo cae en `fin_inbox` (la "Bandeja" de Finanzas) y solo se
-- registra lo que el dueno aprueba con `fin_inbox_approve`.
--
-- !! REGLA DEL NEGOCIO: el GPT NO toca Cuentas. Nunca inserta en
-- fin_account_movements, ni propone cargos o pagos a tarjetas. El saldo de las
-- cuentas es 100% manual (db/finanzas_06_saldo_manual.sql); la tarjeta solo
-- queda anotada como forma de pago en fin_payments.account_id, igual que cuando
-- se registra una compra a mano. Asi nada se cuenta dos veces.
--
-- Quien escribe que:
--   - La API /api/fin-agent (con la service_role, detras del token) INSERTA en
--     fin_inbox y actualiza fin_api_tokens.last_used_at. No toca nada mas.
--   - El dueno, desde el navegador (RLS), edita, descarta y aprueba.
--   - Solo el RPC fin_inbox_approve crea compras, gastos y abonos.
--
-- !! Las politicas van ANTES del ENABLE por el event trigger `ensure_rls`: una
-- tabla sin politicas queda muda, sin error (ver cabecera de finanzas_01).
--
-- TODO ADITIVO: dos tablas y una funcion nuevas. No altera ninguna tabla
-- existente. Idempotente. Aplicar en el SQL Editor de Supabase.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Tokens del conector.
--
-- Se guarda SOLO el sha256 del token: el texto completo se muestra una vez al
-- generarlo y no queda en ningun lado. Anular = poner revoked_at.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fin_api_tokens (
  id           uuid NOT NULL DEFAULT uuid_generate_v4(),
  token_hash   text NOT NULL,
  label        text NOT NULL DEFAULT 'ChatGPT',
  -- A nombre de quien queda lo que entra por este token.
  profile_id   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz,
  CONSTRAINT fin_api_tokens_pkey PRIMARY KEY (id),
  CONSTRAINT fin_api_tokens_profile_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fin_api_tokens_hash
  ON public.fin_api_tokens (token_hash);


-- ----------------------------------------------------------------------------
-- 2. Bandeja de revision.
--
-- Las columnas de negocio son deliberadamente laxas (casi todo NULL-able): el
-- GPT puede proponer una linea incompleta ("no se de que cuenta salio") y el
-- dueno la completa en la Bandeja. Las reglas estrictas se aplican al APROBAR,
-- en fin_inbox_approve, con mensajes claros.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fin_inbox (
  id                uuid NOT NULL DEFAULT uuid_generate_v4(),
  batch_id          uuid NOT NULL,
  source_file       text,
  line_no           integer,
  -- La linea tal cual vino del banco: es lo que el dueno compara de un vistazo.
  raw_text          text NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('compra','gasto','abono')),

  supplier_id       uuid,
  -- Proveedor que todavia no existe: se crea al aprobar.
  supplier_name_new text,
  category_id       uuid,
  -- Solo para un abono: la compra o gasto existente que se abona.
  expense_id        uuid,
  -- De donde salio el dinero. SOLO forma de pago: no mueve el saldo.
  account_id        uuid,

  description       text,
  currency          text NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD','VES')),
  amount            numeric NOT NULL CHECK (amount > 0),
  bcv_rate          numeric CHECK (bcv_rate IS NULL OR bcv_rate > 0),
  amount_usd        numeric NOT NULL CHECK (amount_usd > 0),
  movement_date     date NOT NULL,
  due_date          date,
  -- Compra/gasto que sale de un estado de cuenta ya esta pagado.
  paid              boolean NOT NULL DEFAULT true,
  is_personal       boolean NOT NULL DEFAULT false,
  reference         text,

  -- cuenta|fecha|monto|referencia-o-hash|ocurrencia. Lo arma la API.
  dedup_key         text NOT NULL,
  -- Aviso para el dueno: "posible duplicado de ...".
  warning           text,
  -- Explicacion corta del GPT de por que lo clasifico asi.
  ai_note           text,

  status            text NOT NULL DEFAULT 'pendiente'
                    CHECK (status IN ('pendiente','aprobada','descartada')),
  -- Ultimo error al intentar aprobar (se limpia al aprobar bien).
  approve_error     text,
  result_expense_id uuid,
  result_payment_id uuid,

  created_by        uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  reviewed_by       uuid,
  reviewed_at       timestamptz,

  CONSTRAINT fin_inbox_pkey PRIMARY KEY (id),
  CONSTRAINT fin_inbox_supplier_fkey FOREIGN KEY (supplier_id) REFERENCES public.fin_suppliers(id) ON DELETE SET NULL,
  CONSTRAINT fin_inbox_category_fkey FOREIGN KEY (category_id) REFERENCES public.fin_categories(id) ON DELETE SET NULL,
  CONSTRAINT fin_inbox_expense_fkey  FOREIGN KEY (expense_id)  REFERENCES public.fin_expenses(id)  ON DELETE SET NULL,
  CONSTRAINT fin_inbox_account_fkey  FOREIGN KEY (account_id)  REFERENCES public.fin_accounts(id)  ON DELETE SET NULL,
  CONSTRAINT fin_inbox_result_expense_fkey FOREIGN KEY (result_expense_id) REFERENCES public.fin_expenses(id) ON DELETE SET NULL,
  CONSTRAINT fin_inbox_result_payment_fkey FOREIGN KEY (result_payment_id) REFERENCES public.fin_payments(id) ON DELETE SET NULL,
  CONSTRAINT fin_inbox_author_fkey   FOREIGN KEY (created_by)  REFERENCES public.profiles(id),
  CONSTRAINT fin_inbox_reviewer_fkey FOREIGN KEY (reviewed_by) REFERENCES public.profiles(id)
);

-- Unico en TODOS los estados: subir otra vez el mismo archivo no revive lo que
-- el dueno ya descarto ni duplica lo que ya aprobo.
CREATE UNIQUE INDEX IF NOT EXISTS idx_fin_inbox_dedup
  ON public.fin_inbox (dedup_key);

CREATE INDEX IF NOT EXISTS idx_fin_inbox_pending
  ON public.fin_inbox (created_at DESC) WHERE status = 'pendiente';

CREATE INDEX IF NOT EXISTS idx_fin_inbox_batch
  ON public.fin_inbox (batch_id);


-- ----------------------------------------------------------------------------
-- 3. RLS: el dueno y nadie mas. Politicas ANTES del ENABLE.
--
-- Sin politica de INSERT en fin_inbox: las propuestas solo entran por la API
-- (service_role). Sin DELETE en ninguna: descartar es un cambio de status, y
-- un token se anula, no se borra (queda el rastro de cuando se uso).
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS fin_api_tokens_select_owner ON public.fin_api_tokens;
CREATE POLICY fin_api_tokens_select_owner ON public.fin_api_tokens
  FOR SELECT TO authenticated USING (public.fin_is_owner());

DROP POLICY IF EXISTS fin_api_tokens_insert_owner ON public.fin_api_tokens;
CREATE POLICY fin_api_tokens_insert_owner ON public.fin_api_tokens
  FOR INSERT TO authenticated WITH CHECK (public.fin_is_owner());

DROP POLICY IF EXISTS fin_api_tokens_update_owner ON public.fin_api_tokens;
CREATE POLICY fin_api_tokens_update_owner ON public.fin_api_tokens
  FOR UPDATE TO authenticated USING (public.fin_is_owner()) WITH CHECK (public.fin_is_owner());

ALTER TABLE public.fin_api_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fin_inbox_select_owner ON public.fin_inbox;
CREATE POLICY fin_inbox_select_owner ON public.fin_inbox
  FOR SELECT TO authenticated USING (public.fin_is_owner());

DROP POLICY IF EXISTS fin_inbox_update_owner ON public.fin_inbox;
CREATE POLICY fin_inbox_update_owner ON public.fin_inbox
  FOR UPDATE TO authenticated USING (public.fin_is_owner()) WITH CHECK (public.fin_is_owner());

ALTER TABLE public.fin_inbox ENABLE ROW LEVEL SECURITY;


-- ----------------------------------------------------------------------------
-- 4. Aprobar propuestas.
--
-- Cada fila va en su propio sub-bloque BEGIN/EXCEPTION: si una falla (falta la
-- cuenta, el abono pasa del saldo...) se anota el error en esa fila y las demas
-- se aprueban igual. Lo que si es atomico es cada fila: o queda la compra CON
-- su pago, o no queda nada.
--
-- NUNCA toca fin_account_movements: ver la regla en la cabecera.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_inbox_approve(p_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $approve$
DECLARE
  r            public.fin_inbox%ROWTYPE;
  v_uid        uuid := auth.uid();
  v_supplier   uuid;
  v_expense    uuid;
  v_payment    uuid;
  v_remaining  numeric;
  v_exp_kind   text;
  v_note       text;
  v_err        text;
  v_results    jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.fin_is_owner() THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;

  FOR r IN
    SELECT * FROM public.fin_inbox
     WHERE id = ANY(p_ids) AND status = 'pendiente'
     ORDER BY movement_date, line_no NULLS LAST, created_at
     FOR UPDATE
  LOOP
    v_err := NULL;
    v_supplier := r.supplier_id;
    v_expense := NULL;
    v_payment := NULL;
    v_note := 'Desde ChatGPT'
              || COALESCE(' — ' || NULLIF(trim(r.source_file), ''), '')
              || E'\nBanco: ' || r.raw_text;

    BEGIN
      IF r.currency = 'VES' AND r.bcv_rate IS NULL THEN
        RAISE EXCEPTION 'Falta la tasa BCV del %', to_char(r.movement_date, 'DD/MM/YYYY');
      END IF;

      IF r.kind IN ('compra','gasto') THEN
        -- Proveedor nuevo: se reutiliza si ya existe con el mismo nombre
        -- (el indice unico de fin_suppliers es por lower(name)).
        IF v_supplier IS NULL AND NULLIF(trim(r.supplier_name_new), '') IS NOT NULL THEN
          SELECT id INTO v_supplier
            FROM public.fin_suppliers
           WHERE lower(name) = lower(trim(r.supplier_name_new));
          IF v_supplier IS NULL THEN
            INSERT INTO public.fin_suppliers (name, payment_terms, created_by)
            VALUES (trim(r.supplier_name_new), 'contado', v_uid)
            RETURNING id INTO v_supplier;
          END IF;
        END IF;

        IF r.kind = 'compra' AND v_supplier IS NULL THEN
          RAISE EXCEPTION 'Una compra necesita proveedor';
        END IF;
        IF r.paid AND r.account_id IS NULL THEN
          RAISE EXCEPTION 'Falta la cuenta o tarjeta con que se pago';
        END IF;

        INSERT INTO public.fin_expenses (
          kind, supplier_id, category_id, description,
          currency, amount, bcv_rate, amount_usd,
          expense_date, due_date, is_personal, notes, created_by
        ) VALUES (
          r.kind, v_supplier, r.category_id, NULLIF(trim(r.description), ''),
          r.currency, r.amount, r.bcv_rate, r.amount_usd,
          r.movement_date, r.due_date, r.is_personal, v_note, v_uid
        )
        RETURNING id INTO v_expense;

        IF r.paid THEN
          -- El trigger trg_fin_payments_sync la deja en 'pagada'.
          INSERT INTO public.fin_payments (
            expense_id, account_id, currency, amount, bcv_rate, amount_usd,
            paid_at, reference, notes, created_by
          ) VALUES (
            v_expense, r.account_id, r.currency, r.amount, r.bcv_rate, r.amount_usd,
            r.movement_date, NULLIF(trim(r.reference), ''), v_note, v_uid
          )
          RETURNING id INTO v_payment;
        END IF;

      ELSE -- abono
        IF r.expense_id IS NULL THEN
          RAISE EXCEPTION 'Falta elegir la compra o gasto que se abona';
        END IF;
        IF r.account_id IS NULL THEN
          RAISE EXCEPTION 'Falta la cuenta o tarjeta con que se pago';
        END IF;

        SELECT amount_usd - paid_usd, kind INTO v_remaining, v_exp_kind
          FROM public.fin_expenses
         WHERE id = r.expense_id
         FOR UPDATE;
        IF v_remaining IS NULL THEN
          RAISE EXCEPTION 'La compra que se abona ya no existe';
        END IF;
        IF r.amount_usd > v_remaining + 0.01 THEN
          RAISE EXCEPTION 'El abono (%) pasa de lo que falta por pagar (%)',
            to_char(r.amount_usd, 'FM999G999G990D00'), to_char(GREATEST(v_remaining, 0), 'FM999G999G990D00');
        END IF;

        INSERT INTO public.fin_payments (
          expense_id, account_id, currency, amount, bcv_rate, amount_usd,
          paid_at, reference, notes, created_by
        ) VALUES (
          r.expense_id, r.account_id, r.currency, r.amount, r.bcv_rate, r.amount_usd,
          r.movement_date, NULLIF(trim(r.reference), ''), v_note, v_uid
        )
        RETURNING id INTO v_payment;
        v_expense := r.expense_id;
      END IF;

    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
    END;

    IF v_err IS NULL THEN
      UPDATE public.fin_inbox
         SET status = 'aprobada',
             supplier_id = COALESCE(v_supplier, supplier_id),
             result_expense_id = v_expense,
             result_payment_id = v_payment,
             approve_error = NULL,
             reviewed_by = v_uid,
             reviewed_at = now()
       WHERE id = r.id;
      v_results := v_results || jsonb_build_object(
        'id', r.id, 'ok', true, 'expense_id', v_expense, 'payment_id', v_payment);
    ELSE
      UPDATE public.fin_inbox SET approve_error = v_err WHERE id = r.id;
      v_results := v_results || jsonb_build_object('id', r.id, 'ok', false, 'error', v_err);
    END IF;
  END LOOP;

  RETURN v_results;
END;
$approve$;

REVOKE ALL ON FUNCTION public.fin_inbox_approve(uuid[]) FROM public;
GRANT EXECUTE ON FUNCTION public.fin_inbox_approve(uuid[]) TO authenticated;


-- ============================================================================
-- VERIFICACION (el SQL Editor solo muestra el ultimo SELECT: copiar la celda).
-- Debe decir rls_activa = true en ambas, politicas 3 y 2, y la funcion presente.
-- ============================================================================
SELECT jsonb_pretty(jsonb_build_object(
  'tablas', (
    SELECT jsonb_agg(jsonb_build_object(
             'tabla', c.relname,
             'rls_activa', c.relrowsecurity,
             'politicas', (SELECT COUNT(*) FROM pg_policies p
                            WHERE p.schemaname = 'public' AND p.tablename = c.relname)
           ) ORDER BY c.relname)
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname IN ('fin_api_tokens', 'fin_inbox')
  ),
  'funcion', (
    SELECT jsonb_agg(p.proname)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fin_inbox_approve'
  )
));
