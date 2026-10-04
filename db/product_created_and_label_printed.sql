-- ============================================================================
-- Fecha de alta del producto + registro de impresión de etiqueta (badge "Nuevo").
--
--   products.created_at        → cuándo se dio de alta el producto.
--   products.label_printed_at  → cuándo se imprimió su etiqueta por primera vez.
--
-- El badge "Nuevo" del inventario se muestra cuando el producto se creó hace
-- menos de 1 día Y todavía no se le imprimió la etiqueta.
--
-- IMPORTANTE (por qué el DEFAULT se agrega en un segundo paso): si la columna
-- se creara directamente con `DEFAULT now()`, Postgres rellenaría TODAS las
-- filas existentes con la fecha de la migración y los ~cientos de productos ya
-- cargados aparecerían como "Nuevo" durante 24 h. Creándola primero SIN default,
-- las filas existentes quedan en NULL (= producto viejo, sin badge) y solo los
-- productos nuevos reciben now(). No se modifica ningún dato existente.
--
-- Aplicar en el SQL Editor de Supabase. Todo aditivo, no destructivo.
-- ============================================================================

-- 1) Columnas nuevas. Sin DEFAULT en el ADD: las filas existentes quedan NULL.
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS created_at timestamptz;

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS label_printed_at timestamptz;

-- 2) A partir de ahora, cada producto nuevo se sella con la fecha de alta.
ALTER TABLE public.products
  ALTER COLUMN created_at SET DEFAULT now();

-- 3) Registrar el clic en "Imprimir Etiqueta": mark_label_printed se define en
--    db/role_consulta_02_rpc.sql (sella solo la PRIMERA impresión; exige caja
--    o dueño).
