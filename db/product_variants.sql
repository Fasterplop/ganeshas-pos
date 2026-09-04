-- ============================================================================
-- Variantes de producto: agrupar productos existentes (talla/color) bajo un
-- "producto padre" (grupo de variantes), sin tocar ni un solo dato actual.
--
-- Aditivo y NO destructivo:
--   - Tabla NUEVA `product_groups` (el "producto padre"): nombre, categoría y
--     precio global de referencia, dueño de tienda. No es escaneable, no
--     tiene stock propio (el stock que se ve en pantalla es la suma de sus
--     variantes hijas).
--   - Columna NUEVA `products.parent_group_id`, nullable, sin default. Todas
--     las filas existentes quedan en NULL = "sin variantes" (comportamiento
--     idéntico al de hoy). Nada se borra, renombra ni actualiza.
--
-- Por qué el padre es una tabla aparte y no una fila más de `products`:
-- `products.sku_barcode` es NOT NULL UNIQUE (no hay código de barra "de
-- grupo") y un padre no es vendible ni tiene stock propio. Con una tabla
-- separada, toda consulta existente sobre `products` (búsqueda del POS,
-- checkout, reportes, exportaciones, etiquetas) sigue exactamente igual sin
-- tocarla: es ciega a los grupos hasta que se le agregue lógica nueva a
-- propósito.
--
-- Sin RLS: `products` tampoco la tiene (ver db/*.sql), se mantiene la misma
-- convención del proyecto.
--
-- Aplicar en el SQL Editor de Supabase.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.product_groups (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  name text NOT NULL,
  category public.product_category_v2 NOT NULL,
  default_price numeric NOT NULL,
  owner_store_id uuid NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_groups_pkey PRIMARY KEY (id),
  CONSTRAINT product_groups_owner_store_id_fkey FOREIGN KEY (owner_store_id) REFERENCES public.stores(id)
);

-- Supabase habilita RLS por defecto en tablas creadas desde el SQL Editor
-- (a diferencia de `products`, que quedó sin RLS). La dejamos apagada a
-- propósito, igual que el resto de tablas del proyecto: sin policies.
ALTER TABLE public.product_groups DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS parent_group_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_parent_group_id_fkey'
  ) THEN
    ALTER TABLE public.products
      ADD CONSTRAINT products_parent_group_id_fkey
      FOREIGN KEY (parent_group_id) REFERENCES public.product_groups(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_products_parent_group_id ON public.products(parent_group_id);
