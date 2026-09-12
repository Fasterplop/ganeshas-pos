// Filtros del módulo de Finanzas: rango de fechas y alcance por tienda.
//
// POR QUÉ UN STORE APARTE Y NO usePOSStore:
// la propuesta pide poder ver el "consolidado" de todas las sucursales, pero
// el POS exige SIEMPRE una tienda activa (StoreGuard bloquea la pantalla hasta
// elegirla, y cambiarla vacía el carrito). Meter un scope 'todas' en
// usePOSStore filtraría ese concepto al punto de venta y al inventario, que no
// saben qué hacer con él. Aquí queda contenido: Finanzas lee `currentStore` del
// store del POS, pero nunca lo modifica.

import { create } from 'zustand';
import { caracasMonthStart, caracasToday } from '@/lib/finanzas/dates';

/** 'tienda' = la sucursal activa del POS. 'todas' = el consolidado. */
export type FinScope = 'tienda' | 'todas';

export interface FinDateRange {
  start: string; // 'YYYY-MM-DD'
  end: string;   // 'YYYY-MM-DD'
}

interface FinanceFiltersState {
  scope: FinScope;
  setScope: (scope: FinScope) => void;

  dateRange: FinDateRange;
  setDateRange: (range: FinDateRange) => void;
  setRangeCurrentMonth: () => void;
  setRangeLastDays: (days: number) => void;
}

// El mes en curso es el período que el dueño mira el 90% de las veces.
// caracasToday() da el mismo valor en el servidor y en el navegador (fija la
// zona horaria), así que no provoca desajustes de hidratación.
function currentMonthRange(): FinDateRange {
  const today = caracasToday();
  return { start: caracasMonthStart(today), end: today };
}

export const useFinanceFilters = create<FinanceFiltersState>((set) => ({
  scope: 'tienda',
  setScope: (scope) => set({ scope }),

  dateRange: currentMonthRange(),
  setDateRange: (dateRange) => set({ dateRange }),
  setRangeCurrentMonth: () => set({ dateRange: currentMonthRange() }),
  setRangeLastDays: (days) => {
    const end = caracasToday();
    const from = new Date(`${end}T12:00:00Z`);
    from.setUTCDate(from.getUTCDate() - (days - 1));
    set({ dateRange: { start: from.toISOString().slice(0, 10), end } });
  },
}));
