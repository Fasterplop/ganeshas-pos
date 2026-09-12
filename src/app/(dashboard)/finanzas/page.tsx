'use client';

import FinShell from '@/components/finanzas/FinShell';
import FinPlaceholder from '@/components/finanzas/FinPlaceholder';

export default function FinanzasPage() {
  return (
    <FinShell title="Resumen financiero" subtitle="Dashboard financiero">
      <FinPlaceholder
        section="Dashboard financiero"
        phase="Fase 5"
        bullets={[
            'Cuánto entró, cuánto salió, cuánto queda y cuánto se debe',
            'Ventas del periodo, gastos, compras y deuda pendiente',
            'Próximos pagos y efectivo disponible',
            'Gráfico del período, en la misma línea del panel de Reportes',
        ]}
      />
    </FinShell>
  );
}
