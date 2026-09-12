'use client';

import FinShell from '@/components/finanzas/FinShell';
import FinPlaceholder from '@/components/finanzas/FinPlaceholder';

export default function PersonalPage() {
  return (
    <FinShell title="Personal" subtitle="Estado financiero personal, separado">
      <FinPlaceholder
        section="Estado financiero personal, separado"
        phase="Fase 6"
        bullets={[
            'Cuentas y tarjetas personales con su propio resumen',
            'El dinero de la tienda y el personal nunca se mezclan en los reportes del negocio',
        ]}
      />
    </FinShell>
  );
}
