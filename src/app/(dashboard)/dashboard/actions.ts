'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'

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
    throw new Error('Ocurrió un error al intentar anular la venta y revertir el inventario.')
  }

  // 4. Refrescar el caché del dashboard para actualizar el UI inmediatamente
  revalidatePath('/dashboard')
  
  return { success: true }
}