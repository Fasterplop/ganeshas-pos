-- ============================================================================
-- MODULO DE FINANZAS - simplificar la caja y agregar la categoria Suscripciones.
--
-- Por que: al usarlo, la mitad de los campos de una caja no se llenaban nunca.
-- El dueno no lleva numeracion de cajas ni pesa la mercancia; lo que necesita
-- es saber COMO se llama la caja, cuando salio, que lleva dentro y marcarla
-- cuando llega. Un formulario con campos que nadie llena es un formulario que
-- se deja de usar.
--
-- Que se quita de fin_shipments: box_number, courier, eta_date, pieces, weight
-- y weight_unit.
-- Que se queda: alias (pasa a ser EL nombre de la caja), status, tracking_code,
-- sent_date, received_date, document_path y notes.
--
-- received_date NO se quita: deja de pedirse al crear, pero se sigue guardando
-- sola cuando se marca la caja como recibida. Esa parte es justamente la que
-- hay que conservar.
--
-- El alias se rellena desde el numero antes de borrarlo, asi que las cajas ya
-- cargadas NO pierden como se llamaban.
--
-- Es idempotente. Aplicar en el SQL Editor de Supabase.
-- db/finanzas_01_schema.sql ya quedo actualizado a este diseno: una instalacion
-- NUEVA solo necesita el 01 y el 02.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1) Conservar la identidad de las cajas que ya existen.
--
-- Va ANTES de borrar la columna, obviamente, y solo toca las que no tienen
-- alias: si el dueno ya le puso nombre a una caja, ese nombre manda.
-- ----------------------------------------------------------------------------
DO $backfill$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'fin_shipments' AND column_name = 'box_number'
  ) THEN
    UPDATE public.fin_shipments
       SET alias = 'Caja ' || box_number
     WHERE alias IS NULL OR btrim(alias) = '';
  END IF;
END
$backfill$;

-- Si alguna quedo sin nombre igual (no tenia ni alias ni numero), se le pone
-- uno con su fecha para que no aparezca en blanco en la lista.
UPDATE public.fin_shipments
   SET alias = 'Caja del ' || to_char(COALESCE(sent_date, created_at::date), 'DD/MM/YYYY')
 WHERE alias IS NULL OR btrim(alias) = '';


-- ----------------------------------------------------------------------------
-- 2) Fuera los indices que dependen de las columnas que se van.
-- ----------------------------------------------------------------------------
DROP INDEX IF EXISTS public.idx_fin_shipments_number_uniq;
DROP INDEX IF EXISTS public.idx_fin_shipments_incoming;


-- ----------------------------------------------------------------------------
-- 3) Quitar las columnas que no se usan.
-- ----------------------------------------------------------------------------
ALTER TABLE public.fin_shipments DROP COLUMN IF EXISTS box_number;
ALTER TABLE public.fin_shipments DROP COLUMN IF EXISTS courier;
ALTER TABLE public.fin_shipments DROP COLUMN IF EXISTS eta_date;
ALTER TABLE public.fin_shipments DROP COLUMN IF EXISTS pieces;
ALTER TABLE public.fin_shipments DROP COLUMN IF EXISTS weight;
ALTER TABLE public.fin_shipments DROP COLUMN IF EXISTS weight_unit;


-- ----------------------------------------------------------------------------
-- 4) El alias pasa a ser obligatorio: es lo unico que identifica la caja.
-- ----------------------------------------------------------------------------
ALTER TABLE public.fin_shipments ALTER COLUMN alias SET NOT NULL;

-- "Que esta en camino" ahora se ordena por la fecha de envio, que es la unica
-- que queda.
CREATE INDEX IF NOT EXISTS idx_fin_shipments_incoming
  ON public.fin_shipments (sent_date)
  WHERE status IN ('enviada','en_transito');


-- ----------------------------------------------------------------------------
-- 5) Categoria nueva: Suscripciones (YouTube, Spotify, herramientas...).
--
-- Se inserta como las de la semilla del 01 y con el mismo criterio: si ya
-- existe una con ese nombre, no se toca.
-- ----------------------------------------------------------------------------
DO $cat$
DECLARE
  v_owner uuid;
BEGIN
  SELECT id INTO v_owner
    FROM public.profiles
   WHERE role::text = 'owner' AND COALESCE(is_active, true)
   ORDER BY full_name
   LIMIT 1;

  IF v_owner IS NULL THEN
    RAISE NOTICE 'Sin perfil owner activo: se omite la categoria Suscripciones.';
    RETURN;
  END IF;

  INSERT INTO public.fin_categories (name, kind, sort_order, created_by)
  SELECT 'Suscripciones', 'gasto', 55, v_owner
   WHERE NOT EXISTS (
     SELECT 1 FROM public.fin_categories WHERE lower(name) = 'suscripciones'
   );
END
$cat$;


-- ----------------------------------------------------------------------------
-- VERIFICACION.
--
-- `columnas_de_caja` no debe traer box_number, courier, eta_date, pieces,
-- weight ni weight_unit. `suscripciones` debe ser 1. Y las cajas que ya
-- existian deben conservar su nombre en `cajas`.
--
-- PROBAR DESPUES: /finanzas/cajas -> crear una caja nueva (solo pide nombre,
-- fecha, guia y notas), abrirla y marcarla como recibida.
-- ----------------------------------------------------------------------------
SELECT jsonb_pretty(jsonb_build_object(
  'columnas_de_caja', (
    SELECT jsonb_agg(column_name ORDER BY ordinal_position)
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'fin_shipments'
  ),
  'suscripciones', (SELECT COUNT(*) FROM public.fin_categories WHERE lower(name) = 'suscripciones'),
  'cajas', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('nombre', alias, 'estado', status) ORDER BY created_at), '[]'::jsonb)
      FROM public.fin_shipments
  )
));
