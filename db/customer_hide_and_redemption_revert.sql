-- ============================================================================
-- Cambios:
--  1) Ocultar clientes en /customers (soft-delete visual, owner).
--  2) Guardar los puntos canjeados por venta, para poder reintegrarlos al anular.
--  3) delete_sale_and_revert: al anular, reintegra los puntos canjeados de la venta.
-- Aplicar en el SQL Editor de Supabase. Todo aditivo, no borra nada.
-- ============================================================================

-- 1. Bandera para ocultar clientes de la lista (los datos se conservan).
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS is_hidden boolean NOT NULL DEFAULT false;

-- 2. Puntos consumidos por canje en cada venta (0 si no hubo canje).
ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS redemption_points integer NOT NULL DEFAULT 0;

-- 3. Anulación de venta: revierte stock + puntos ganados y AHORA TAMBIÉN
--    reintegra los puntos canjeados (redemption_points) de esa venta.
CREATE OR REPLACE FUNCTION public.delete_sale_and_revert(p_sale_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_store_id          UUID;
  v_customer_id       VARCHAR;
  v_total_amount      NUMERIC;
  v_redemption_points INTEGER;
  v_points_to_deduct  INTEGER;
  v_item              RECORD;
BEGIN
  SELECT store_id, customer_id, total_amount, redemption_points
    INTO v_store_id, v_customer_id, v_total_amount, v_redemption_points
    FROM sales WHERE id = p_sale_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venta no encontrada';
  END IF;

  -- Devolver el stock (los productos rápidos tienen product_id NULL y no aplican)
  FOR v_item IN (SELECT product_id, quantity FROM sale_items WHERE sale_id = p_sale_id) LOOP
    UPDATE store_stock
       SET stock = stock + v_item.quantity
     WHERE product_id = v_item.product_id AND store_id = v_store_id;
  END LOOP;

  IF v_customer_id IS NOT NULL THEN
    -- Puntos GANADOS por la venta (1pt/$1) que se quitan, MENOS los puntos
    -- CANJEADOS en la venta que se reintegran.
    v_points_to_deduct := FLOOR(v_total_amount);

    UPDATE customers
       SET total_spent   = GREATEST(total_spent - v_total_amount, 0),
           reward_points = GREATEST(reward_points - v_points_to_deduct + COALESCE(v_redemption_points, 0), 0)
     WHERE document_id = v_customer_id AND store_id = v_store_id;
  END IF;

  DELETE FROM sale_items WHERE sale_id = p_sale_id;
  DELETE FROM sales WHERE id = p_sale_id;
END;
$function$;
