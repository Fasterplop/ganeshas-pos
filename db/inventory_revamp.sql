-- ============================================================================
-- Inventario por tienda + limpieza de datos + nuevas categorías.
--
-- Qué hace (en este orden):
--   1) BORRA los datos de negocio actuales: clientes, ventas, ítems de venta,
--      stock e inventario (productos). CONSERVA: tiendas, usuarios (profiles)
--      y la configuración de lealtad (loyalty_settings).
--   2) Agrega products.owner_store_id: la tienda "dueña" del producto. El
--      inventario mostrará SOLO los productos de la tienda correspondiente.
--      (Los productos siguen siendo vendibles en cualquier tienda desde el POS.)
--   3) Reemplaza las categorías 'otros' y 'descuento' por 'zapato' y 'perfume'
--      (quedan: juguetes, ropa, zapato, perfume).
--   4) Permite STOCK NEGATIVO (quita el CHECK stock >= 0): la sobreventa deja
--      el stock de esa tienda en negativo (p.ej. -1).
--
-- Ejecutar TODO junto en el SQL Editor de Supabase. Es DESTRUCTIVO (paso 1).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) LIMPIEZA (destructivo). Un solo TRUNCATE con todas las tablas que se
--    referencian entre sí, para no necesitar CASCADE. No toca stores/profiles.
-- ----------------------------------------------------------------------------
TRUNCATE TABLE
  public.sale_items,
  public.sales,
  public.store_stock,
  public.products,
  public.customers
RESTART IDENTITY;

-- ----------------------------------------------------------------------------
-- 2) Tienda dueña del producto (para filtrar el inventario por tienda).
--    Aditivo y nullable; el POS la ignora (los productos son globales al vender).
-- ----------------------------------------------------------------------------
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS owner_store_id uuid REFERENCES public.stores(id);

CREATE INDEX IF NOT EXISTS idx_products_owner_store ON public.products (owner_store_id);

-- ----------------------------------------------------------------------------
-- 3) Nuevas categorías: juguetes, ropa, zapato, perfume.
--    Como products quedó VACÍO en el paso 1, convertir la columna a un enum
--    nuevo es seguro (no hay filas que convertir). El tipo viejo se deja
--    intacto para no romper dependencias desconocidas.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'product_category_v2') THEN
    CREATE TYPE public.product_category_v2 AS ENUM ('juguetes', 'ropa', 'zapato', 'perfume');
  END IF;
END $$;

ALTER TABLE public.products
  ALTER COLUMN category TYPE public.product_category_v2
  USING category::text::public.product_category_v2;

-- ----------------------------------------------------------------------------
-- 4) Permitir STOCK NEGATIVO: al vender un producto sin existencias, el stock
--    de esa tienda debe poder quedar en -1 (sobreventa). Se elimina el
--    CHECK (stock >= 0) de store_stock (cualquiera sea su nombre autogenerado).
-- ----------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.store_stock'::regclass AND contype = 'c'
  LOOP
    EXECUTE format('ALTER TABLE public.store_stock DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
