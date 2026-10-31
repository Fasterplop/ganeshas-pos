'use client';

// Un envío, pieza por pieza (paso 4 de la propuesta v2).
//
// En la tienda que recibe y mientras está pendiente: «Te llegó un envío» con
// «✓ Todo llegó» o «Falta algo» (lo que no llegó vuelve a la tienda que envió
// y Gerardo lo ve en Novedades), y «Enlazar» en lo que llegó con su padre de
// origen. En cualquier otro caso es solo para ver.

import { useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import type { SupabaseClient } from '@supabase/supabase-js';
import Modal from '@/components/Modal';
import ElegirModelo, { type ModeloPick } from '@/components/traslados/ElegirModelo';
import { formatVariant } from '@/lib/productVariant';
import {
  fetchStoreCatalog,
  notifyTrasladosChanged,
  receiveShipment,
  relinkShipmentItem,
  type DestGroup,
  type DestProduct,
  type Shipment,
  type ShipmentItem,
} from '@/lib/traslados';

const short = (name?: string | null) => (name ?? '').replace(/^tienda de /i, '') || 'la otra tienda';
const when = (iso: string) =>
  new Date(iso).toLocaleString('es-VE', {
    timeZone: 'America/Caracas',
    day: '2-digit',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

const variantOf = (it: ShipmentItem, p: ShipmentItem['product']) =>
  formatVariant(it.size ?? p?.talla ?? null, p?.color ?? null);

export default function EnvioModal({
  supabase,
  shipment,
  storeName,
  canReceive,
  onClose,
  onChanged,
}: {
  supabase: SupabaseClient;
  shipment: Shipment | null;
  storeName: (id: string) => string;
  /** La tienda activa es la que recibe (o es el dueño) y el envío está pendiente. */
  canReceive: boolean;
  onClose: () => void;
  /** Algo cambió (recibido, enlazado): hay que volver a leer. */
  onChanged: () => void;
}) {
  const [missingMode, setMissingMode] = useState(false);
  const [missing, setMissing] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<{ groups: DestGroup[]; products: DestProduct[] } | null>(null);
  const [linking, setLinking] = useState<ShipmentItem | null>(null);

  if (!shipment) return null;

  const from = storeName(shipment.from_store_id);
  const to = storeName(shipment.to_store_id);
  const pending = shipment.status === 'pendiente';
  const totalMissing = Object.values(missing).reduce((a, n) => a + n, 0);

  const close = () => {
    setMissingMode(false);
    setMissing({});
    setError(null);
    onClose();
  };

  const confirm = async (withMissing: boolean) => {
    setSaving(true);
    setError(null);
    const list = withMissing
      ? Object.entries(missing).filter(([, n]) => n > 0).map(([item_id, n]) => ({ item_id, missing: n }))
      : [];
    const res = await receiveShipment(supabase, shipment.id, list);
    setSaving(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    notifyTrasladosChanged();
    onChanged();
    close();
  };

  const openLink = async (it: ShipmentItem) => {
    setLinking(it);
    if (!catalog) {
      const c = await fetchStoreCatalog(supabase, shipment.to_store_id);
      setCatalog({ groups: c.groups, products: c.products });
    }
  };

  const onPick = async (pick: ModeloPick) => {
    const it = linking;
    setLinking(null);
    if (!it || pick.kind === 'origen') return;
    setSaving(true);
    setError(null);
    const res = await relinkShipmentItem(supabase, {
      itemId: it.id,
      targetGroupId: pick.kind === 'group' ? pick.group.id : null,
      targetProductId: pick.kind === 'product' ? pick.product.id : null,
    });
    setSaving(false);
    if (res.error) setError(res.error);
    else onChanged();
  };

  return (
    <>
      <Modal isOpen onClose={close} title={pending && canReceive ? `📥 Te llegó un envío de ${from}` : `Envío ${short(from)} → ${short(to)}`}>
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            {shipment.pieces} {shipment.pieces === 1 ? 'pieza' : 'piezas'} · {when(shipment.created_at)} · {shipment.author}
            <br />
            Motivo: <span className="font-semibold text-slate-800">«{shipment.note}»</span>
          </p>

          <div className="border border-slate-200 rounded-xl overflow-hidden">
            <div className="hidden sm:grid grid-cols-[1fr_4.5rem_1.3fr] gap-3 px-3 py-2 bg-slate-100 text-[11px] uppercase tracking-wide font-semibold text-slate-600">
              <span>Llegó</span>
              <span className="text-center">Cant.</span>
              <span>{missingMode ? 'Cuántas faltan' : 'Quedó en'}</span>
            </div>
            <ul className="divide-y divide-slate-100">
              {shipment.items.map((it) => {
                const variant = variantOf(it, it.product);
                const m = missing[it.id] ?? 0;
                return (
                  <li key={it.id} className="px-3 py-2.5 flex flex-col sm:grid sm:grid-cols-[1fr_4.5rem_1.3fr] gap-1 sm:gap-3 sm:items-center text-sm">
                    <span className="text-slate-800">
                      <span className="font-semibold">{it.product?.name ?? 'Producto eliminado'}</span>
                      {variant && <span className="text-slate-500"> · {variant}</span>}
                      <span className="block text-xs font-mono text-slate-400">{it.product?.sku_barcode}</span>
                    </span>
                    <span className="sm:text-center font-bold text-slate-700">
                      {it.quantity}
                      {it.missing > 0 && <span className="block text-xs font-semibold text-amber-700">faltó {it.missing}</span>}
                    </span>
                    {missingMode ? (
                      <span className="flex items-center gap-2">
                        <button
                          onClick={() => setMissing((p) => ({ ...p, [it.id]: Math.max(0, m - 1) }))}
                          className="w-8 h-8 rounded-lg border border-slate-300 flex items-center justify-center hover:bg-slate-50 cursor-pointer"
                          aria-label="Una menos"
                        >
                          <Minus size={14} />
                        </button>
                        <span className={`w-8 text-center font-bold ${m > 0 ? 'text-amber-700' : 'text-slate-400'}`}>{m}</span>
                        <button
                          onClick={() => setMissing((p) => ({ ...p, [it.id]: Math.min(it.quantity, m + 1) }))}
                          className="w-8 h-8 rounded-lg border border-slate-300 flex items-center justify-center hover:bg-slate-50 cursor-pointer"
                          aria-label="Una más"
                        >
                          <Plus size={14} />
                        </button>
                        <span className="text-xs text-slate-500">de {it.quantity}</span>
                      </span>
                    ) : (
                      <QuedoEn it={it} fromShort={short(from)} onLink={pending && canReceive && it.match === 'origen' ? () => void openLink(it) : undefined} />
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-sm">{error}</div>}

          {pending && canReceive ? (
            missingMode ? (
              <div className="space-y-2">
                <p className="text-xs text-slate-500">
                  Lo que no llegó vuelve a {from} y Gerardo lo ve en Novedades.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setMissingMode(false);
                      setMissing({});
                    }}
                    disabled={saving}
                    className="flex-1 py-3 rounded-xl border border-slate-300 font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
                  >
                    Volver
                  </button>
                  <button
                    onClick={() => void confirm(true)}
                    disabled={saving || totalMissing === 0}
                    className="flex-1 py-3 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-bold cursor-pointer disabled:opacity-50"
                  >
                    {saving ? 'Guardando…' : `Confirmar: faltan ${totalMissing}`}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                <button
                  onClick={() => void confirm(false)}
                  disabled={saving}
                  className="flex-1 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold cursor-pointer disabled:opacity-60"
                >
                  {saving ? 'Guardando…' : '✓ Todo llegó'}
                </button>
                <button
                  onClick={() => setMissingMode(true)}
                  disabled={saving}
                  className="flex-1 py-3 rounded-xl border-2 border-amber-500 text-amber-700 font-bold hover:bg-amber-50 cursor-pointer"
                >
                  Falta algo
                </button>
              </div>
            )
          ) : (
            <EstadoTexto shipment={shipment} to={to} />
          )}
        </div>
      </Modal>

      {catalog && (
        <ElegirModelo
          isOpen={!!linking}
          onClose={() => setLinking(null)}
          modelName={linking?.product?.name ?? ''}
          storeName={to}
          groups={catalog.groups}
          products={catalog.products}
          allowProducts={!!linking && !linking.product?.parent_group_id}
          onPick={(p) => void onPick(p)}
        />
      )}
    </>
  );
}

function QuedoEn({ it, fromShort, onLink }: { it: ShipmentItem; fromShort: string; onLink?: () => void }) {
  if (it.match === 'vuelve') return <span className="text-emerald-700">↩ volvió a su producto</span>;
  if (it.match === 'origen') {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-indigo-700">
          ＋ «{it.product?.name?.trim()}» de {fromShort}
        </span>
        {onLink && (
          <button onClick={onLink} className="text-xs font-bold px-2.5 py-1 rounded-md border border-indigo-300 text-indigo-700 hover:bg-indigo-50 cursor-pointer">
            Enlazar
          </button>
        )}
      </span>
    );
  }
  const variant = formatVariant(it.target?.talla ?? null, it.target?.color ?? null);
  return (
    <span className="text-slate-700">
      ✓ su {it.target?.name?.trim()}
      {variant && <> · {variant}</>}
      {it.created_variant && <span className="ml-1.5 text-[11px] font-bold bg-teal-600 text-white px-1.5 py-0.5 rounded">NUEVA</span>}
    </span>
  );
}

function EstadoTexto({ shipment, to }: { shipment: Shipment; to: string }) {
  switch (shipment.status) {
    case 'pendiente':
      return <p className="text-sm text-amber-700 font-semibold">⏳ Esperando que {to} confirme.</p>;
    case 'recibido':
      return (
        <p className="text-sm text-emerald-700 font-semibold">
          ✓ Llegó · confirmó {shipment.receiver ?? to}
          {shipment.received_at && ` · ${when(shipment.received_at)}`}
        </p>
      );
    case 'incompleto':
      return (
        <p className="text-sm text-amber-700 font-semibold">
          ⚠ Llegó incompleto: lo que faltó volvió a la tienda que lo envió
          {shipment.received_at && ` · ${when(shipment.received_at)}`}
        </p>
      );
    case 'deshecho':
      return (
        <p className="text-sm text-slate-600 font-semibold">
          ↩ Deshecho{shipment.undoer && ` por ${shipment.undoer}`}
          {shipment.undone_at && ` · ${when(shipment.undone_at)}`}: todo volvió a su tienda.
        </p>
      );
  }
}
