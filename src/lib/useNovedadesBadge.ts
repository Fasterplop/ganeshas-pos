'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { fetchNovedadesCount, NOVEDADES_SEEN_EVENT } from '@/lib/novedades';

/**
 * Contador rojo de «Novedades» en el menú del dueño: lo que no ha visto. Se
 * recalcula al cambiar de pantalla y cuando marca todo como visto. Sin el SQL
 * aplicado queda en 0 (no se muestra).
 */
export function useNovedadesBadge(enabled: boolean): number {
  const pathname = usePathname();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const supabase = createClient();
    const refresh = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const n = await fetchNovedadesCount(supabase, user.id);
      if (!cancelled) setCount(n);
    };
    void refresh();
    window.addEventListener(NOVEDADES_SEEN_EVENT, refresh);
    return () => {
      cancelled = true;
      window.removeEventListener(NOVEDADES_SEEN_EVENT, refresh);
    };
  }, [enabled, pathname]);

  return enabled ? count : 0;
}
