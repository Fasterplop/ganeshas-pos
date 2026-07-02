'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { usePOSStore } from '@/store/usePOSStore';

// Tarjeta de configuración del programa de lealtad, POR SUCURSAL.
// Solo el owner puede guardar (la RLS de loyalty_settings lo garantiza).
export default function LoyaltySettingsCard() {
  const supabase = createClient();
  const { currentStore } = usePOSStore();

  const [pointsPerBlock, setPointsPerBlock] = useState('10');
  const [discountPerBlock, setDiscountPerBlock] = useState('10');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    if (!currentStore) return;
    setLoading(true);
    setMsg(null);

    (async () => {
      const { data } = await supabase
        .from('loyalty_settings')
        .select('points_per_block, discount_per_block_usd')
        .eq('store_id', currentStore.id)
        .maybeSingle();

      if (data) {
        setPointsPerBlock(String(data.points_per_block));
        setDiscountPerBlock(String(data.discount_per_block_usd));
      } else {
        setPointsPerBlock('10');
        setDiscountPerBlock('10');
      }
      setLoading(false);
    })();
  }, [currentStore?.id]);

  const handleSave = async () => {
    if (!currentStore) return;

    const ppb = Number(pointsPerBlock);
    const dpb = Number(discountPerBlock);

    if (!Number.isInteger(ppb) || ppb <= 0) {
      setMsg({ text: 'Los puntos por bloque deben ser un número entero mayor a 0.', ok: false });
      return;
    }
    if (isNaN(dpb) || dpb <= 0) {
      setMsg({ text: 'El descuento debe ser mayor a 0.', ok: false });
      return;
    }

    setSaving(true);
    setMsg(null);

    const { data: { user } } = await supabase.auth.getUser();

    const { error } = await supabase.from('loyalty_settings').upsert({
      store_id: currentStore.id,
      points_per_block: ppb,
      discount_per_block_usd: dpb,
      updated_at: new Date().toISOString(),
      updated_by: user?.id ?? null,
    });

    setSaving(false);

    if (error) {
      setMsg({ text: 'No se pudo guardar. Verifica que tengas permisos de administrador.', ok: false });
    } else {
      setMsg({ text: 'Configuración guardada.', ok: true });
    }
  };

  if (!currentStore) return null;

  return (
    <div className="bg-white p-6 rounded-xl shadow-sm border border-teal-200 flex flex-col">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-teal-600">✪</span>
        <h3 className="text-lg font-bold text-slate-800">Descuento por Puntos</h3>
      </div>
      <p className="text-xs text-slate-500 mb-4">
        Regla de canje para <strong className="text-teal-700">{currentStore.name}</strong>.
      </p>

      {loading ? (
        <p className="text-sm text-slate-500">Cargando configuración...</p>
      ) : (
        <>
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wide">
                Puntos necesarios
              </label>
              <input
                type="number"
                min="1"
                step="1"
                value={pointsPerBlock}
                onChange={(e) => setPointsPerBlock(e.target.value)}
                className="w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none"
              />
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
              Los clientes ganan <strong>1 punto por cada $20</strong> gastados.
            </p>
            <p>
              Cada <strong>{pointsPerBlock || '0'}</strong> puntos equivalen a{' '}
              <strong>${Number(discountPerBlock || 0).toFixed(2)}</strong> de descuento.
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
