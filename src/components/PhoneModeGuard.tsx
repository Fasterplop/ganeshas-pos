'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { isPhoneScreen, PHONE_SIMPLE_PATHS, usePhoneScreen } from '@/lib/phoneMode';

// Modo teléfono (profiles.phone_simple_mode, «En el teléfono: precio y caja»
// en Usuarios). La misma cuenta ve todo en la computadora y, en una pantalla
// de teléfono, solo Consultar precio y la caja. El menú (TopBarMenu) esconde
// lo demás; esto lleva a Consultar precio a quien llegue a otra ruta por un
// enlace o escribiendo la URL.
//
// Es una comodidad, no un candado: la cuenta sigue siendo de cajero y sus
// permisos de verdad están en la RLS y los RPC.
const LANDED_KEY = 'ganesha-phone-landed';

export default function PhoneModeGuard({ enabled }: { enabled: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const phone = usePhoneScreen();

  useEffect(() => {
    if (!enabled || !phone || !isPhoneScreen()) return;

    // La primera pantalla de la sesión en el teléfono es Consultar precio (la
    // app abre en "/" y el servidor manda al cajero a la caja).
    let landed = false;
    try { landed = sessionStorage.getItem(LANDED_KEY) === '1'; } catch { landed = true; }
    if (!landed) {
      try { sessionStorage.setItem(LANDED_KEY, '1'); } catch { /* sin almacenamiento: no pasa nada */ }
      if (pathname !== '/consultar-precio') {
        router.replace('/consultar-precio');
        return;
      }
    }

    if (!PHONE_SIMPLE_PATHS.includes(pathname)) router.replace('/consultar-precio');
  }, [enabled, phone, pathname, router]);

  return null;
}
