'use client';

import FinShell from '@/components/finanzas/FinShell';
import FinPlaceholder from '@/components/finanzas/FinPlaceholder';

export default function ComprasPage() {
  return (
    <FinShell title="Compras" subtitle="Registro de compras" showScope>
      <FinPlaceholder
        section="Registro de compras"
        phase="Fase 3"
        bullets={[
            'Alta en pocos segundos: proveedor, monto, fecha, cuenta y estado',
            'En dólares o en bolívares, guardando la tasa BCV del día de la compra',
            'Cuenta preseleccionada con la última usada con ese proveedor',
            'Aviso antes de duplicar una compra ya registrada',
            'Foto del recibo, opcional y adjuntable después',
        ]}
      />
    </FinShell>
  );
}
