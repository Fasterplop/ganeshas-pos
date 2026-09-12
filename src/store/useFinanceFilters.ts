// Filtros del módulo de Finanzas: el rango de fechas.
//
// NO hay filtro por tienda. Las finanzas son DEL NEGOCIO: el dueño ve lo mismo
// esté parado en la tienda que esté. La Amex paga para cualquier sucursal, LC
// Lizette le vende al negocio y una caja en camino es la misma caja desde donde
// se mire.
//
// POR QUÉ UN STORE APARTE Y NO usePOSStore: el POS exige siempre una tienda
// activa (StoreGuard bloquea la pantalla hasta elegirla, y cambiarla vacía el
// carrito). Finanzas no depende de eso, y meterle su rango de fechas al store
// del POS mezclaría dos cosas que no tienen nada que ver.

import { create } from 'zustand';
import { caracasMonthStart, caracasToday } from '@/lib/finanzas/dates';

export interface FinDateRange {
  start: string; // 'YYYY-MM-DD'
  end: string;   // 'YYYY-MM-DD'
}

interface FinanceFiltersState {
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
