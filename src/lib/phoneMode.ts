'use client';

import { useSyncExternalStore } from 'react';

// "Teléfono" = pantalla más angosta que el corte `md` de Tailwind (768 px), el
// mismo en que el menú pasa de la barra lateral (Sidebar) a la de arriba
// (TopBarMenu).
const PHONE_QUERY = '(max-width: 767px)';

/** Rutas que ve una cuenta con modo teléfono cuando entra desde el teléfono. */
export const PHONE_SIMPLE_PATHS = ['/consultar-precio', '/pos'];

export function isPhoneScreen(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(PHONE_QUERY).matches;
}

function subscribe(onChange: () => void) {
  const mq = window.matchMedia(PHONE_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

/** true en pantalla de teléfono. En el servidor, false (no se sabe). */
export function usePhoneScreen(): boolean {
  return useSyncExternalStore(subscribe, isPhoneScreen, () => false);
}
