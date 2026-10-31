'use client';

import { useEffect, useState } from 'react';
import { ArrowLeftRight, TrendingUp, Truck } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { formatVariant } from '@/lib/productVariant';
import {
  fetchNovedades,
  fetchNovedadesSeenAt,
  markNovedadesSeen,
  type Novedad,
} from '@/lib/novedades';

type Filter = 'all' | 'price' | 'transfer' | 'traslado';

const FILTER_LABEL: Record<Filter, string> = { all: 'Todo', price: 'Precios', transfer: 'Transferencias', traslado: 'Traslados' };

// Etiqueta de cada hecho de un traslado (src/lib/novedades.ts).
const TRASLADO_LABEL = { enviado: 'Traslado', incompleto: 'Falta algo', deshecho: 'Traslado deshecho' } as const;

const fmtUSD = (n: number) => `$${n.toFixed(2)}`;

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString('es-VE', {
    timeZone: 'America/Caracas', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });

const shortStore = (name?: string | null) => (name ?? '').replace(/^tienda de /i, '') || 'la otra tienda';

export default function NovedadesPage() {
  const supabase = createClient();
  const [rows, setRows] = useState<Novedad[]>([]);
  const [stores, setStores] = useState<{ id: string; name: string }[]>([]);
  const [seenAt, setSeenAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [marking, setMarking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const [list, seen, storesRes] = await Promise.all([
        fetchNovedades(supabase, user.id),
        fetchNovedadesSeenAt(supabase, user.id),
        supabase.from('stores').select('id, name'),
      ]);
      if (cancelled) return;
      setRows(list.rows);
      setError(list.error);
      setSeenAt(seen.seenAt);
      setStores((storesRes.data as { id: string; name: string }[] | null) ?? []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const isNew = (r: Novedad) => !seenAt || r.created_at > seenAt;
  const newCount = rows.filter(isNew).length;
  const shown = filter === 'all' ? rows : rows.filter(r => r.kind === filter);
  const storeName = (id?: string) => shortStore(stores.find(s => s.id === id)?.name);

  const markAll = async () => {
    setMarking(true);
    const res = await markNovedadesSeen(supabase);
    setMarking(false);
    if (res.error) { setError(res.error); return; }
    setSeenAt(res.seenAt);
  };

  return (
    <div className="max-w-4xl mx-auto flex flex-col gap-4">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            Novedades
            {newCount > 0 && (
              <span className="text-xs font-bold bg-red-50 text-red-600 border border-red-200 px-2 py-0.5 rounded-full">
                {newCount} {newCount === 1 ? 'nueva' : 'nuevas'}
              </span>
            )}
          </h1>
          <p className="text-sm text-slate-500">Subidas de precio, transferencias y traslados entre tiendas hechos por el equipo, con su motivo.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {(Object.keys(FILTER_LABEL) as Filter[]).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-full text-sm font-semibold transition cursor-pointer ${filter === f ? 'bg-[#0f5c5c] text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
            >
              {FILTER_LABEL[f]}
            </button>
          ))}
          {newCount > 0 && (
            <button
              onClick={() => void markAll()}
              disabled={marking}
              className="px-3 py-1.5 text-sm font-semibold text-teal-700 hover:bg-teal-50 rounded-lg transition cursor-pointer disabled:opacity-60"
            >
              {marking ? 'Guardando…' : 'Marcar todo como visto'}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm font-medium">{error}</div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        {loading ? (
          <p className="p-6 text-center text-slate-500">Cargando…</p>
        ) : shown.length === 0 ? (
          <p className="p-6 text-center text-slate-500">
            {filter === 'price'
              ? 'Nadie ha subido precios todavía.'
              : filter === 'transfer'
                ? 'No hay transferencias del equipo.'
                : filter === 'traslado'
                  ? 'No hay traslados del equipo.'
                  : 'No hay novedades todavía.'}
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {shown.map(r => {
              const fresh = isNew(r);
              const variant = formatVariant(r.talla, r.color);
              const diff = (r.newPrice ?? 0) - (r.oldPrice ?? 0);
              const pct = r.oldPrice ? Math.round((diff / r.oldPrice) * 100) : 0;
              return (
                <li key={r.id} className={`flex gap-3 p-4 ${fresh ? '' : 'opacity-70'}`}>
                  <span
                    className={`shrink-0 w-9 h-9 rounded-lg flex items-center justify-center ${
                      r.kind === 'price' ? 'bg-amber-50 text-amber-700' : r.kind === 'traslado' ? 'bg-indigo-50 text-indigo-700' : 'bg-teal-50 text-teal-700'
                    }`}
                  >
                    {r.kind === 'price' ? <TrendingUp size={18} /> : r.kind === 'traslado' ? <Truck size={18} /> : <ArrowLeftRight size={18} />}
                  </span>
                  <div className="flex-1 min-w-0">
                    {r.kind === 'traslado' ? (
                      <>
                        <span
                          className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${
                            r.event === 'incompleto' ? 'bg-orange-50 text-orange-800' : r.event === 'deshecho' ? 'bg-slate-100 text-slate-700' : 'bg-indigo-50 text-indigo-800'
                          }`}
                        >
                          {TRASLADO_LABEL[r.event ?? 'enviado']}
                        </span>
                        <p className="mt-1 text-sm text-slate-700">
                          {r.event === 'incompleto'
                            ? `${r.missing === 1 ? 'Faltó 1' : `Faltaron ${r.missing}`} de ${r.pieces} ${r.pieces === 1 ? 'pieza' : 'piezas'}: ${r.missing === 1 ? 'volvió' : 'volvieron'} a ${storeName(r.fromStoreId)}`
                            : r.event === 'deshecho'
                              ? `${r.pieces} ${r.pieces === 1 ? 'pieza volvió' : 'piezas volvieron'} a ${storeName(r.fromStoreId)}`
                              : `${r.pieces} ${r.pieces === 1 ? 'pieza' : 'piezas'}`}
                          {' '}· De {storeName(r.fromStoreId)} a {storeName(r.toStoreId)}
                        </p>
                        <p className="text-sm">
                          <span className="text-slate-500">Motivo: </span>
                          <span className="font-semibold text-slate-800">{r.note}</span>
                        </p>
                      </>
                    ) : (
                      <>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${r.kind === 'price' ? 'bg-amber-50 text-amber-800' : 'bg-teal-50 text-teal-800'}`}>
                            {r.kind === 'price' ? 'Subida de precio' : r.changesOwner ? 'Pasó a la otra tienda' : 'Transferencia'}
                          </span>
                          <span className="font-bold text-slate-800">{r.productName}</span>
                          <span className="text-xs text-slate-500">
                            {variant && `${variant} · `}<span className="font-mono">{r.sku}</span>
                          </span>
                        </div>
                        {r.kind === 'price' ? (
                          <p className="mt-1 text-sm text-slate-700">
                            <span className="text-slate-400 line-through">{fmtUSD(r.oldPrice ?? 0)}</span>
                            {' → '}
                            <span className="font-bold text-emerald-700">{fmtUSD(r.newPrice ?? 0)}</span>
                            <span className="text-slate-500 text-xs"> (+{fmtUSD(diff)} · +{pct} %)</span>
                          </p>
                        ) : (
                          <>
                            <p className="mt-1 text-sm text-slate-700">
                              {r.quantity === 1 ? '1 unidad' : `${r.quantity} unidades`} · De {storeName(r.fromStoreId)} a {storeName(r.toStoreId)}
                              {r.source === 'pos' && <span className="text-slate-500"> · desde la caja</span>}
                            </p>
                            <p className="text-sm">
                              <span className="text-slate-500">Motivo: </span>
                              {r.note ? <span className="font-semibold text-slate-800">{r.note}</span> : <span className="text-slate-400">sin motivo</span>}
                            </p>
                          </>
                        )}
                      </>
                    )}
                  </div>
                  <div className="shrink-0 text-right text-xs text-slate-500">
                    <p className="font-medium text-slate-600">{r.who}</p>
                    <p>{fmtWhen(r.created_at)}</p>
                    {fresh && <span className="inline-block mt-1 w-2 h-2 rounded-full bg-red-500" title="Nueva" />}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {!loading && rows.length > 0 && (
        <p className="text-xs text-slate-400">Se muestran los últimos 200 de cada tipo.</p>
      )}
    </div>
  );
}
