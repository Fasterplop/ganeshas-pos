'use client';

import FinShell from '@/components/finanzas/FinShell';
import FinPlaceholder from '@/components/finanzas/FinPlaceholder';

export default function CalendarioPage() {
  return (
    <FinShell title="Calendario de pagos" subtitle="Calendario de pagos y recordatorios" showScope>
      <FinPlaceholder
        section="Calendario de pagos y recordatorios"
        phase="Fase 4"
        bullets={[
            'Vista de mes con todos los vencimientos: proveedores, tarjetas y gastos fijos',
            'Avisos a 7 días, a 3 días, el mismo día, y en rojo al vencerse',
            'Lo que queda pendiente entra solo, sin un paso extra',
        ]}
      />
    </FinShell>
  );
}
