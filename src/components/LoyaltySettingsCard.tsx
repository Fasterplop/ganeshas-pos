'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

// Regla inmutable de acumulación: 1 punto por cada $20 gastados.
// La UI se expresa en "monto gastado" pero el backend sigue guardando puntos.
const DOLLARS_PER_POINT = 20;

// Tarjeta de configuración del programa de fidelidad.
// La regla es GLOBAL: se aplica igual a TODAS las sucursales.
// Solo el owner puede guardar (la RLS de loyalty_settings lo garantiza).
export default function LoyaltySettingsCard() {
  const supabase = createClient();

  // Se edita como MONTO gastado (USD); internamente = puntos * $20.
  const [montoNecesario, setMontoNecesario] = useState('200');
  const [discountPerBlock, setDiscountPerBlock] = useState('10');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  // Carga la regla global (fila más reciente; todas las sucursales son iguales).
  useEffect(() => {
    setLoading(true);
    setMsg(null);
    (async () => {
      const { data } = await supabase
        .from('loyalty_settings')
        .select('points_per_block, discount_per_block_usd')
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (data) {
        setMontoNecesario(String(data.points_per_block * DOLLARS_PER_POINT));
        setDiscountPerBlock(String(data.discount_per_block_usd));
      } else {
        setMontoNecesario('200');
        setDiscountPerBlock('10');
      }
      setLoading(false);
    })();
  }, []);

  const handleSave = async () => {
    const monto = Number(montoNecesario);
    const dpb = Number(discountPerBlock);

    if (isNaN(monto) || monto <= 0 || monto % DOLLARS_PER_POINT !== 0) {
      setMsg({ text: `El monto debe ser un múltiplo de $${DOLLARS_PER_POINT} (ej. 20, 40, 200).`, ok: false });
      return;
    }
    if (isNaN(dpb) || dpb <= 0) {
      setMsg({ text: 'El descuento debe ser mayor a 0.', ok: false });
      return;
    }

    setSaving(true);
    setMsg(null);

    const { data: { user } } = await supabase.auth.getUser();

    // Regla GLOBAL: se replica idéntica a la fila de cada sucursal.
    const { data: stores } = await supabase.from('stores').select('id');
    const rows = (stores ?? []).map((s: { id: string }) => ({
      store_id: s.id,
      points_per_block: monto / DOLLARS_PER_POINT,  // convierte monto -> puntos
      discount_per_block_usd: dpb,
      updated_at: new Date().toISOString(),
      updated_by: user?.id ?? null,
    }));

    if (rows.length === 0) {
      setSaving(false);
      setMsg({ text: 'No hay sucursales registradas para aplicar la configuración.', ok: false });
      return;
    }

    const { error } = await supabase.from('loyalty_settings').upsert(rows);

    setSaving(false);

    if (error) {
      setMsg({ text: 'No se pudo guardar. Verifica que tengas permisos de administrador.', ok: false });
    } else {
      setMsg({ text: 'Configuración guardada para todas las sucursales.', ok: true });
    }
  };

  return (
    <div className="bg-white p-6 rounded-xl shadow-sm border border-teal-200 flex flex-col">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-teal-600">✪</span>
        <h3 className="text-lg font-bold text-slate-800">Descuento por Puntos</h3>
      </div>
      <p className="text-xs text-slate-500 mb-4">
        Regla de canje aplicada por igual a <strong className="text-teal-700">todas las sucursales</strong>.
      </p>

      {loading ? (
        <p className="text-sm text-slate-500">Cargando configuración...</p>
      ) : (
        <>
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wide">
                Monto necesario
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">$</span>
                <input
                  type="number"
                  min={DOLLARS_PER_POINT}
                  step={DOLLARS_PER_POINT}
                  value={montoNecesario}
                  onChange={(e) => setMontoNecesario(e.target.value)}
                  className="w-full pl-7 pr-3 py-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wide">
                Descuento ($)
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">$</span>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={discountPerBlock}
                  onChange={(e) => setDiscountPerBlock(e.target.value)}
                  className="w-full pl-7 pr-3 py-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none"
                />
              </div>
            </div>
          </div>

          <div className="text-xs text-slate-500 mt-3 bg-slate-50 border border-slate-200 rounded-lg p-2.5 space-y-1">
            <p>
              Cada <strong>${Number(montoNecesario || 0).toFixed(2)}</strong> gastado equivale a{' '}
              <strong>${Number(discountPerBlock || 0).toFixed(2)}</strong> de descuento.
            </p>
            <p className="text-slate-400">
              El gasto acumulado se cuenta en bloques de ${DOLLARS_PER_POINT}.
            </p>
          </div>

          {msg && (
            <p className={`text-sm mt-3 ${msg.ok ? 'text-emerald-600' : 'text-red-500'}`}>
              {msg.ok ? '✅ ' : '⚠️ '}{msg.text}
            </p>
          )}

          <button
            onClick={handleSave}
            disabled={saving}
            className="w-full bg-[#0f5c5c] hover:bg-[#0a4545] disabled:bg-slate-300 text-white font-medium py-2.5 px-4 rounded-lg transition mt-4"
          >
            {saving ? 'Guardando...' : 'Guardar configuración'}
          </button>
        </>
      )}
    </div>
  );
}
