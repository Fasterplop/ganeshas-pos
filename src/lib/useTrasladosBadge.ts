'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { fetchPendingToReceive, TRASLADOS_CHANGED_EVENT } from '@/lib/traslados';

/** Cada cuánto se vuelve a mirar si llegó un envío, con la pantalla quieta. */
const POLL_MS = 60_000;

/**
 * Número de «Traslados» en el menú: los envíos que esperan que la tienda
 * activa confirme («Te llegó un envío»). Se recalcula al cambiar de pantalla,
 * cada minuto y cuando la pantalla de Traslados avisa que algo cambió. Sin el
 * SQL aplicado queda en 0 (no se muestra).
 */
export function useTrasladosBadge(storeId: string | null | undefined, enabled: boolean): number {
  const pathname = usePathname();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!enabled || !storeId) return;
    let cancelled = false;
    const supabase = createClient();
    const refresh = async () => {
      const n = await fetchPendingToReceive(supabase, storeId);
      if (!cancelled) setCount(n);
    };
    void refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    window.addEventListener(TRASLADOS_CHANGED_EVENT, refresh);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener(TRASLADOS_CHANGED_EVENT, refresh);
    };
  }, [enabled, storeId, pathname]);

  return enabled && storeId ? count : 0;
}
