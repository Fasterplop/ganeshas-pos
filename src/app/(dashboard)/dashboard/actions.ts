'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'
import { exchangeErrorMessage } from '@/lib/exchange'

// Anula una venta O un cambio de producto (ambos son filas de `sales`; el RPC
// revierte stock y puntos en los dos casos). Si la venta tiene cambios
// registrados, el RPC responde SALE_HAS_EXCHANGES: hay que anular el cambio primero.
export async function deleteSaleAction(saleId: string) {
  const supabase = await createClient()

  // 1. Verificar la sesión activa
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) throw new Error('No autorizado')

  // 2. Control estricto de roles: Verificar que el usuario sea 'owner'
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (profile?.role !== 'owner') {
    throw new Error('Permisos insuficientes. Solo el administrador puede anular ventas.')
  }

  // 3. Ejecutar la transacción en base de datos
  const { error: rpcError } = await supabase.rpc('delete_sale_and_revert', { 
    p_sale_id: saleId 
  })

  if (rpcError) {
    console.error('Error al eliminar venta:', rpcError)
    throw new Error(exchangeErrorMessage(
      rpcError,
      'Ocurrió un error al intentar anular la venta y revertir el inventario.',
    ))
  }

  // 4. Refrescar el caché del dashboard para actualizar el UI inmediatamente
  revalidatePath('/dashboard')
  
  return { success: true }
}