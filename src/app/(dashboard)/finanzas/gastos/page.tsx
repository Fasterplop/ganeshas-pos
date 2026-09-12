'use client';

import FinShell from '@/components/finanzas/FinShell';
import FinPlaceholder from '@/components/finanzas/FinPlaceholder';

export default function GastosPage() {
  return (
    <FinShell title="Gastos y presupuesto" subtitle="Gastos operativos con presupuesto editable" showScope>
      <FinPlaceholder
        section="Gastos operativos con presupuesto editable"
        phase="Fase 4"
        bullets={[
            'Alquiler, nómina, servicios, publicidad, transporte y papelería',
            'Presupuesto mensual editable por categoría',
            'Planeado vs. gastado, porcentaje consumido y alerta al pasar del límite',
        ]}
      />
    </FinShell>
  );
}
