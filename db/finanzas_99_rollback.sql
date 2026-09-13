-- ============================================================================
-- MODULO DE FINANZAS - deshacer TODO.
--
-- Deshace exactamente lo que crean db/finanzas_01_schema.sql y
-- db/finanzas_02_storage.sql, y nada mas.
--
-- POR QUE ES SEGURO: ninguna tabla del POS (sales, sale_items, products,
-- store_stock, customers, profiles, stores...) tiene un FK hacia fin_*, y
-- ninguna de esas tablas fue modificada por la migracion. El CASCADE de abajo
-- solo puede alcanzar objetos fin_*. Correr esto NO puede tocar ventas,
-- clientes, productos ni stock.
--
-- LO QUE SI SE PIERDE: todo lo cargado en el modulo de finanzas (cajas,
-- compras, pagos, proveedores, cuentas, presupuestos) y los archivos del
-- bucket. Hacer `node scripts/backup-db.mjs` antes si hay datos reales.
--
-- Aplicar en el SQL Editor de Supabase. Es idempotente.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1) Tablas, en orden inverso de dependencias.
-- ----------------------------------------------------------------------------
DROP VIEW IF EXISTS public.fin_v_budget_vs_actual;
DROP VIEW IF EXISTS public.fin_v_supplier_balance;
DROP VIEW IF EXISTS public.fin_v_account_balance;

DROP TABLE IF EXISTS public.fin_subscriptions      CASCADE;
DROP TABLE IF EXISTS public.fin_account_movements  CASCADE;
DROP TABLE IF EXISTS public.fin_payments        CASCADE;
DROP TABLE IF EXISTS public.fin_shipment_boxes  CASCADE;
DROP TABLE IF EXISTS public.fin_shipment_items  CASCADE;
DROP TABLE IF EXISTS public.fin_purchase_lines  CASCADE;
DROP TABLE IF EXISTS public.fin_budgets         CASCADE;
DROP TABLE IF EXISTS public.fin_expenses        CASCADE;
DROP TABLE IF EXISTS public.fin_shipments       CASCADE;
DROP TABLE IF EXISTS public.fin_accounts        CASCADE;
DROP TABLE IF EXISTS public.fin_categories      CASCADE;
DROP TABLE IF EXISTS public.fin_suppliers       CASCADE;


-- ----------------------------------------------------------------------------
-- 2) Funciones. fin_is_owner() va al final porque las politicas de Storage
--    dependen de ella.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS fin_storage_select_owner ON storage.objects;
DROP POLICY IF EXISTS fin_storage_insert_owner ON storage.objects;
DROP POLICY IF EXISTS fin_storage_update_owner ON storage.objects;
DROP POLICY IF EXISTS fin_storage_delete_owner ON storage.objects;

DROP FUNCTION IF EXISTS public.fin_sync_expense_status();
DROP FUNCTION IF EXISTS public.fin_resync_own_status();
DROP FUNCTION IF EXISTS public.fin_is_owner();


-- ----------------------------------------------------------------------------
-- 3) El bucket y sus archivos.
--
-- Descomentar SOLO si de verdad se quieren borrar los recibos y guias
-- adjuntados. Se deja comentado a proposito: borrar el esquema es reversible
-- (se vuelve a correr la migracion), borrar los archivos no.
-- ----------------------------------------------------------------------------
-- DELETE FROM storage.objects WHERE bucket_id = 'finanzas';
-- DELETE FROM storage.buckets WHERE id = 'finanzas';


-- ----------------------------------------------------------------------------
-- VERIFICACION. Debe devolver 0 tablas fin_* y 0 politicas de storage fin_*.
-- ----------------------------------------------------------------------------
SELECT jsonb_pretty(jsonb_build_object(
  'tablas_fin_restantes', (SELECT COUNT(*) FROM pg_class c
                            JOIN pg_namespace n ON n.oid = c.relnamespace
                           WHERE n.nspname = 'public' AND c.relkind = 'r'
                             AND c.relname LIKE 'fin\_%'),
  'politicas_storage_fin', (SELECT COUNT(*) FROM pg_policies
                             WHERE schemaname = 'storage' AND tablename = 'objects'
                               AND policyname LIKE 'fin\_storage\_%'),
  'bucket_sigue',          (SELECT COUNT(*) FROM storage.buckets WHERE id = 'finanzas')
));
