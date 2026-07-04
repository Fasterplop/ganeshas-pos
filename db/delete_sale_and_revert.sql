-- ============================================================================
-- Fix: delete_sale_and_revert revertía puntos con la regla vieja ($20 = 1 pt).
-- Ahora usa la regla vigente 1 punto por cada $1 gastado.
-- Único cambio respecto a la versión anterior: la línea de v_points_to_deduct.
-- Aplicar en el SQL Editor de Supabase (CREATE OR REPLACE, no destructivo).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.delete_sale_and_revert(p_sale_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_store_id         UUID;
  v_customer_id      VARCHAR;
  v_total_amount     NUMERIC;
  v_points_to_deduct INTEGER;
  v_item             RECORD;
BEGIN
  -- 1. Obtener la información de la venta a eliminar
  SELECT store_id, customer_id, total_amount
    INTO v_store_id, v_customer_id, v_total_amount
    FROM sales WHERE id = p_sale_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venta no encontrada';
  END IF;

  -- 2. Devolver el stock iterando sobre los items de la venta
  --    (los productos rápidos tienen product_id NULL y no afectan stock)
  FOR v_item IN (SELECT product_id, quantity FROM sale_items WHERE sale_id = p_sale_id) LOOP
    UPDATE store_stock
       SET stock = stock + v_item.quantity
     WHERE product_id = v_item.product_id AND store_id = v_store_id;
  END LOOP;

  -- 3. Revertir el gasto y los puntos del cliente (si no fue a consumidor final)
  IF v_customer_id IS NOT NULL THEN
    -- Puntos generados por esta venta con la regla vigente: 1 punto por cada $1.
    v_points_to_deduct := FLOOR(v_total_amount);

    UPDATE customers
       SET total_spent   = GREATEST(total_spent - v_total_amount, 0),
           reward_points = GREATEST(reward_points - v_points_to_deduct, 0)
     WHERE document_id = v_customer_id AND store_id = v_store_id;
  END IF;

  -- 4. Eliminar el detalle de la venta
  DELETE FROM sale_items WHERE sale_id = p_sale_id;

  -- 5. Eliminar la cabecera de la venta
  DELETE FROM sales WHERE id = p_sale_id;
END;
$function$;
