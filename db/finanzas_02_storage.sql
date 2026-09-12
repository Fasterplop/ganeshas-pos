-- ============================================================================
-- MODULO DE FINANZAS - bucket de respaldos (recibos y guias de envio).
--
-- El proyecto no tenia NADA de Storage hasta ahora: cero buckets, cero
-- uploads, cero <input type="file">. Esto lo crea desde cero.
--
-- Decisiones:
--   - Bucket PRIVADO. Un recibo lleva montos, proveedores y a veces datos
--     bancarios: no puede quedar en una URL publica adivinable. La app lo
--     muestra con createSignedUrl(path, 60).
--   - La BD guarda la RUTA (fin_expenses.receipt_path,
--     fin_shipments.document_path), nunca una URL firmada: las URLs expiran y
--     guardarlas seria guardar basura con fecha de caducidad.
--   - Solo el owner, igual que el resto del modulo, reutilizando la misma
--     funcion public.fin_is_owner() de db/finanzas_01_schema.sql.
--
-- Requiere haber corrido antes db/finanzas_01_schema.sql (usa fin_is_owner()).
-- Es idempotente. Aplicar en el SQL Editor de Supabase.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1) El bucket.
--
-- file_size_limit es la red de seguridad, no la solucion: la app comprime las
-- fotos a WebP de 1600 px antes de subirlas (una foto de 4 MB del celular
-- queda en ~200 KB). Sin esa compresion el bucket se llena de fotos crudas y
-- el cliente deja de adjuntar recibos.
-- ----------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'finanzas',
  'finanzas',
  false,
  5242880,  -- 5 MB
  ARRAY['image/jpeg','image/png','image/webp','image/heic','application/pdf']
)
ON CONFLICT (id) DO UPDATE
  SET public             = EXCLUDED.public,
      file_size_limit    = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;


-- ----------------------------------------------------------------------------
-- 2) Politicas: solo el owner, los cuatro verbos, y solo sobre este bucket.
--
-- La condicion de bucket_id va en TODAS: sin ella estas politicas se aplicarian
-- a cualquier objeto de Storage, incluido cualquier bucket que se cree despues.
--
-- Rutas esperadas dentro del bucket:
--   receipts/{expense_id}/{uuid}.{ext}
--   shipments/{shipment_id}/{uuid}.{ext}
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS fin_storage_select_owner ON storage.objects;
CREATE POLICY fin_storage_select_owner ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'finanzas' AND public.fin_is_owner());

DROP POLICY IF EXISTS fin_storage_insert_owner ON storage.objects;
CREATE POLICY fin_storage_insert_owner ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'finanzas' AND public.fin_is_owner());

DROP POLICY IF EXISTS fin_storage_update_owner ON storage.objects;
CREATE POLICY fin_storage_update_owner ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'finanzas' AND public.fin_is_owner())
  WITH CHECK (bucket_id = 'finanzas' AND public.fin_is_owner());

DROP POLICY IF EXISTS fin_storage_delete_owner ON storage.objects;
CREATE POLICY fin_storage_delete_owner ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'finanzas' AND public.fin_is_owner());


-- ----------------------------------------------------------------------------
-- VERIFICACION. El bucket debe salir privado y con sus 4 politicas.
--
-- PROBAR DESPUES DE ESTE BLOQUE: como owner, adjuntar la foto de una guia en
-- /finanzas/cajas y volver a abrirla (debe verse). Como cajero, pedir ese mismo
-- objeto debe ser denegado.
-- ----------------------------------------------------------------------------
SELECT jsonb_pretty(jsonb_build_object(
  'bucket', (SELECT jsonb_build_object(
                      'id', id, 'publico', public, 'limite_bytes', file_size_limit)
               FROM storage.buckets WHERE id = 'finanzas'),
  'politicas', (SELECT COUNT(*) FROM pg_policies
                 WHERE schemaname = 'storage' AND tablename = 'objects'
                   AND policyname LIKE 'fin\_storage\_%')
));
