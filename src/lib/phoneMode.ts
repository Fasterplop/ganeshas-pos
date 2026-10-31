'use client';

import { useSyncExternalStore } from 'react';

// "Teléfono" = pantalla más angosta que el corte `md` de Tailwind (768 px), el
// mismo en que el menú pasa de la barra lateral (Sidebar) a la de arriba
// (TopBarMenu).
const PHONE_QUERY = '(max-width: 767px)';

/**
 * Rutas que ve una cuenta con modo teléfono cuando entra desde el teléfono.
 * Traslados va porque se pistolea con el teléfono escáner; el menú la filtra
 * por rol (no la ven el vendedor ni el rol consulta).
 */
export const PHONE_SIMPLE_PATHS = ['/consultar-precio', '/pos', '/traslados'];

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
