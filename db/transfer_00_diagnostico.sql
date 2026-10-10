-- ============================================================================
-- Transferencias entre tiendas (0): DIAGNÓSTICO. Solo lee, no cambia nada.
--
-- Correr ANTES de db/transfer_01_stock_transfers.sql y guardar el JSON que
-- devuelve (sirve para comparar después y para decidir qué descuadres viejos
-- se corrigen).
--
-- QUÉ MIRAR EN EL RESULTADO:
--   * tiendas: tienen que ser exactamente DOS activas. La función asume eso.
--   * productos_sin_duena y productos_sin_fila_por_tienda: tienen que dar 0.
--   * filas_no_duenas.positivas: tiene que dar 0. Si no, esos productos se
--     vuelven vendibles en la otra tienda en cuanto se despliegue la caja
--     nueva (la regla nueva es "se vende lo propio o lo que tenga stock aquí").
--   * filas_no_duenas.negativas / detalle_no_duenas: las ventas cruzadas viejas
--     (un producto de una tienda vendido en la otra antes del filtro de la
--     caja). NO se corrigen por SQL: se revisan una por una desde Inventario
--     con el botón «Regularizar».
--   * grupos_desalineados: tiene que dar 0 (variante y modelo en la misma tienda).
--   * politicas_store_stock y triggers: referencia; no están en db/.
--   * suma_stock_total: anotarla. Una transferencia no crea ni borra unidades,
--     así que este número no puede cambiar por transferir.
--
-- Aplicar en el SQL Editor de Supabase.
-- ============================================================================

SELECT jsonb_pretty(jsonb_build_object(
  'tiendas', (
    SELECT jsonb_agg(jsonb_build_object('id', id, 'nombre', name, 'activa', is_active) ORDER BY name)
      FROM public.stores
  ),
  'anulables', (
    SELECT jsonb_agg(jsonb_build_object('tabla', table_name, 'columna', column_name, 'acepta_null', is_nullable))
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND (table_name, column_name) IN (
             ('store_stock', 'stock'), ('products', 'owner_store_id'),
             ('products', 'is_active'), ('stores', 'is_active'))
  ),
  'productos_sin_duena', (SELECT COUNT(*) FROM public.products WHERE owner_store_id IS NULL),
  'productos_sin_fila_por_tienda', (
    SELECT COUNT(*) FROM public.products p
     WHERE (SELECT COUNT(*) FROM public.store_stock s WHERE s.product_id = p.id)
           <> (SELECT COUNT(*) FROM public.stores)
  ),
  'filas_no_duenas', (
    SELECT jsonb_build_object(
             'positivas', COUNT(*) FILTER (WHERE s.stock > 0),
             'negativas', COUNT(*) FILTER (WHERE s.stock < 0))
      FROM public.store_stock s
      JOIN public.products p ON p.id = s.product_id
     WHERE s.store_id <> p.owner_store_id
  ),
  'detalle_no_duenas', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'product_id', p.id, 'sku', p.sku_barcode, 'nombre', p.name, 'activo', p.is_active,
             'duena', o.name, 'tienda_fila', t.name,
             'stock_fila', s.stock, 'stock_duena', os.stock,
             'ventas_alli', (
               SELECT jsonb_agg(jsonb_build_object('fecha', v.created_at, 'cant', i.quantity))
                 FROM public.sale_items i
                 JOIN public.sales v ON v.id = i.sale_id
                WHERE i.product_id = p.id AND v.store_id = s.store_id))), '[]'::jsonb)
      FROM public.store_stock s
      JOIN public.products p ON p.id = s.product_id
      JOIN public.stores o ON o.id = p.owner_store_id
      JOIN public.stores t ON t.id = s.store_id
      LEFT JOIN public.store_stock os ON os.product_id = p.id AND os.store_id = p.owner_store_id
     WHERE s.store_id <> p.owner_store_id AND s.stock <> 0
  ),
  'grupos_desalineados', (
    SELECT COUNT(*) FROM public.products p
      JOIN public.product_groups g ON g.id = p.parent_group_id
     WHERE g.owner_store_id <> p.owner_store_id
  ),
  'checks_store_stock', (
    SELECT jsonb_agg(pg_get_constraintdef(oid)) FROM pg_constraint
     WHERE conrelid = 'public.store_stock'::regclass
  ),
  'politicas_store_stock', (
    SELECT jsonb_agg(jsonb_build_object(
             'politica', policyname, 'cmd', cmd, 'tipo', permissive, 'using', qual, 'check', with_check))
      FROM pg_policies WHERE schemaname = 'public' AND tablename = 'store_stock'
  ),
  'triggers', (
    SELECT jsonb_agg(jsonb_build_object('tabla', c.relname, 'def', pg_get_triggerdef(t.oid)))
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE NOT t.tgisinternal AND c.relname IN ('products', 'store_stock', 'stores')
  ),
  'ya_instalado', jsonb_build_object(
    'tabla_stock_transfers', to_regclass('public.stock_transfers') IS NOT NULL,
    'funcion_transfer_stock', EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'transfer_stock')
  ),
  'suma_stock_total', (SELECT SUM(stock) FROM public.store_stock)
));
