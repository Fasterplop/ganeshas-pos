'use client';

// Traslados: enviar mercancía a la otra tienda y confirmar lo que llega
// (propuesta «Cashea + Traslados» v2, aprobada por Gerardo el 2026-10-30).
//
// Inicio (paso 1): «Enviar a <la otra tienda>», lo que está «Por recibir» y la
// lista de envíos con su estado. La cajera envía solo desde su tienda y a un
// destino fijo; el dueño ve los envíos de las dos tiendas y envía desde la
// tienda activa del menú.
//
// Las reglas (a qué producto llega cada pieza, todo o nada, quién deshace)
// viven en db/traslados_01.sql; ver también src/lib/traslados.ts.

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { usePOSStore } from '@/store/usePOSStore';
import Modal from '@/components/Modal';
import EnviarTraslado from '@/components/traslados/EnviarTraslado';
import EnvioModal from '@/components/traslados/EnvioModal';
import { fetchStores, otherStore, type StoreLite } from '@/lib/transfers';
import {
  checkTrasladosAvailable,
  fetchShipments,
  loadDraft,
  notifyTrasladosChanged,
  undoShipment,
  TRASLADOS_MIGRATION_MISSING,
  type Shipment,
} from '@/lib/traslados';

const short = (name?: string | null) => (name ?? '').replace(/^tienda de /i, '') || 'la otra tienda';
const caracasDay = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });

function whenText(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('es-VE', { timeZone: 'America/Caracas', hour: 'numeric', minute: '2-digit', hour12: true });
  if (caracasDay(d) === caracasDay(new Date())) return time;
  return `${d.toLocaleDateString('es-VE', { timeZone: 'America/Caracas', day: '2-digit', month: 'short' }).replace('.', '')} · ${time}`;
}

export default function TrasladosPage() {
  const supabase = useMemo(() => createClient(), []);
  const { currentStore } = usePOSStore();
  const [me, setMe] = useState<{ id: string; role: string } | null>(null);
  const [stores, setStores] = useState<StoreLite[]>([]);
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [view, setView] = useState<'inicio' | 'enviar'>('inicio');
  const [limit, setLimit] = useState(30);
  const [tick, setTick] = useState(0);
  const [data, setData] = useState<{ key: string; rows: Shipment[]; pending: Shipment[]; error: string | null } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [undoTarget, setUndoTarget] = useState<Shipment | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      const [prof, sts, ok] = await Promise.all([
        user ? supabase.from('profiles').select('role').eq('id', user.id).single() : Promise.resolve({ data: null }),
        fetchStores(supabase),
        checkTrasladosAvailable(supabase),
      ]);
      if (cancelled) return;
      if (user && prof.data) setMe({ id: user.id, role: String((prof.data as { role: string }).role) });
      setStores(sts.filter((s) => s.is_active !== false));
      setInstalled(ok);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  const isOwner = me?.role === 'owner';
  const storeId = currentStore?.id ?? null;
  const dest = otherStore(stores, storeId);
  const storeName = (id: string) => stores.find((s) => s.id === id)?.name ?? 'otra tienda';

  // Los envíos se guardan con la consulta que los trajo: mientras no coincida
  // con la actual, la lista está cargando.
  const listKey = `${storeId}|${isOwner}|${limit}|${tick}`;
  const loading = !data || data.key !== listKey;

  useEffect(() => {
    if (!installed || !me || !storeId) return;
    let cancelled = false;
    Promise.all([
      // El dueño ve todo; la RLS ya limita al cajero a los envíos de su tienda.
      fetchShipments(supabase, { storeId: isOwner ? null : storeId, limit }),
      fetchShipments(supabase, { storeId, pendingTo: storeId, limit: 50 }),
    ]).then(([list, pend]) => {
      if (cancelled) return;
      setData({ key: listKey, rows: list.rows, pending: pend.rows, error: list.error ?? pend.error });
    });
    return () => {
      cancelled = true;
    };
  }, [supabase, installed, me, storeId, isOwner, limit, listKey]);

  // Envío a medias guardado en este navegador («Seguir después»).
  const draftPieces = useMemo(() => {
    if (!me || !storeId || view !== 'inicio') return 0;
    return (loadDraft(me.id, storeId)?.lines ?? []).reduce((a, l) => a + l.qty, 0);
  }, [me, storeId, view]);

  const reload = () => setTick((t) => t + 1);

  const canUndo = (s: Shipment) =>
    s.status !== 'deshecho' && (isOwner || (s.status === 'pendiente' && s.from_store_id === storeId));
  const canReceive = (s: Shipment) => s.status === 'pendiente' && (isOwner || s.to_store_id === storeId);

  const doUndo = async () => {
    if (!undoTarget) return;
    setUndoing(true);
    setUndoError(null);
    const res = await undoShipment(supabase, undoTarget.id);
    setUndoing(false);
    if (res.error) {
      setUndoError(res.error);
      return;
    }
    setUndoTarget(null);
    notifyTrasladosChanged();
    reload();
  };

  const allRows = data?.rows ?? [];
  const opened = openId ? (allRows.find((s) => s.id === openId) ?? data?.pending.find((s) => s.id === openId) ?? null) : null;

  // --- Estados que no son la pantalla normal ---------------------------------
  if (installed === false) {
    return (
      <div className="max-w-2xl mx-auto bg-amber-50 border border-amber-200 rounded-xl p-6 text-amber-900">
        <h1 className="font-bold text-lg mb-2">Traslados todavía no está instalado</h1>
        <p className="text-sm">{TRASLADOS_MIGRATION_MISSING}</p>
        <p className="text-xs text-amber-700 mt-3">El resto del sistema sigue funcionando con normalidad.</p>
      </div>
    );
  }
  if (!me || installed === null || !currentStore) {
    return <div className="py-20 text-center text-slate-400 text-sm">Cargando Traslados…</div>;
  }
  if (!dest) {
    return (
      <div className="max-w-2xl mx-auto bg-white border border-slate-200 rounded-xl p-6 text-slate-700">
        <h1 className="font-bold text-lg mb-2">Traslados</h1>
        <p className="text-sm">Traslados necesita exactamente dos tiendas activas para saber a cuál enviar.</p>
      </div>
    );
  }

  if (view === 'enviar') {
    return (
      <EnviarTraslado
        key={currentStore.id}
        supabase={supabase}
        userId={me.id}
        fromStore={currentStore}
        toStore={dest}
        onExit={(sent) => {
          setView('inicio');
          if (sent) reload();
        }}
      />
    );
  }

  // --- Inicio ------------------------------------------------------------------
  const pending = data?.pending ?? [];
  const today = new Date().toLocaleDateString('es-VE', { timeZone: 'America/Caracas', weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-1">
        <h1 className="text-2xl font-bold text-slate-800">
          Traslados <span className="text-slate-400 font-normal">· {currentStore.name}</span>
        </h1>
        <p className="text-sm text-slate-500 first-letter:uppercase">{today}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Enviar */}
        <button
          onClick={() => setView('enviar')}
          className="text-left bg-[#0f5c5c] hover:bg-teal-800 text-white rounded-2xl p-5 shadow-sm transition-colors cursor-pointer"
        >
          <p className="text-3xl">📤</p>
          <p className="text-xl font-bold mt-2">Enviar a {dest.name}</p>
          <p className="text-teal-100 text-sm">Pistolear y enviar</p>
          {draftPieces > 0 && (
            <p className="mt-3 inline-block bg-white/15 rounded-lg px-3 py-1.5 text-sm font-semibold">
              Tienes un envío sin terminar: {draftPieces} {draftPieces === 1 ? 'pieza' : 'piezas'}
            </p>
          )}
        </button>

        {/* Por recibir */}
        <div className={`rounded-2xl p-5 border shadow-sm ${pending.length ? 'bg-amber-50 border-amber-300' : 'bg-white border-slate-200'}`}>
          <p className="text-3xl">📥</p>
          <p className="text-xl font-bold mt-2 text-slate-800 flex items-center gap-2">
            Por recibir
            {pending.length > 0 && (
              <span className="inline-flex items-center justify-center min-w-[1.5rem] h-6 px-2 rounded-full bg-red-500 text-white text-sm">{pending.length}</span>
            )}
          </p>
          {loading ? (
            <p className="text-sm text-slate-400">Cargando…</p>
          ) : pending.length === 0 ? (
            <p className="text-sm text-slate-500">No hay envíos esperando a {currentStore.name}.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {pending.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 bg-white rounded-xl border border-amber-200 px-3 py-2">
                  <span className="text-sm text-slate-700">
                    <span className="font-semibold">{short(storeName(s.from_store_id))}</span> te mandó {s.pieces} {s.pieces === 1 ? 'pieza' : 'piezas'}
                    <span className="block text-xs text-slate-500">{whenText(s.created_at)}</span>
                  </span>
                  <button
                    onClick={() => setOpenId(s.id)}
                    className="shrink-0 bg-amber-600 hover:bg-amber-700 text-white text-sm font-bold px-3 py-2 rounded-lg cursor-pointer"
                  >
                    Ver y confirmar
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Envíos */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-100">
          <div>
            <h2 className="font-bold text-slate-800">Envíos</h2>
            {isOwner && <p className="text-xs text-slate-500">Los de las dos tiendas.</p>}
          </div>
          <button onClick={reload} className="text-sm text-teal-700 hover:underline cursor-pointer">
            ↻ Actualizar
          </button>
        </div>
        {data?.error && <div className="m-4 bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-sm">{data.error}</div>}
        {loading && !data ? (
          <p className="p-6 text-center text-slate-400 text-sm">Cargando…</p>
        ) : allRows.length === 0 ? (
          <p className="p-6 text-center text-slate-500 text-sm">Todavía no hay envíos.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {allRows.map((s) => (
              <li key={s.id} className="px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                <button onClick={() => setOpenId(s.id)} className="flex-1 min-w-0 text-left cursor-pointer">
                  <p className="text-sm text-slate-800">
                    <span className="text-slate-500 mr-2">{whenText(s.created_at)}</span>
                    <span className="font-semibold">
                      {short(storeName(s.from_store_id))} → {short(storeName(s.to_store_id))}
                    </span>
                    <span className="text-slate-500">
                      {' '}· {s.pieces} {s.pieces === 1 ? 'pieza' : 'piezas'}
                    </span>
                  </p>
                  <p className="text-xs text-slate-500 truncate">
                    «{s.note}» · {s.author}
                  </p>
                </button>
                <StatusPill s={s} to={short(storeName(s.to_store_id))} />
                <div className="flex gap-2 shrink-0">
                  {canReceive(s) && (
                    <button onClick={() => setOpenId(s.id)} className="text-sm font-bold text-amber-700 border border-amber-300 hover:bg-amber-50 px-3 py-1.5 rounded-lg cursor-pointer">
                      Confirmar
                    </button>
                  )}
                  {canUndo(s) && (
                    <button
                      onClick={() => {
                        setUndoError(null);
                        setUndoTarget(s);
                      }}
                      className="text-sm font-semibold text-slate-700 border border-slate-300 hover:bg-slate-50 px-3 py-1.5 rounded-lg cursor-pointer"
                    >
                      ↩ Deshacer
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {allRows.length >= limit && (
          <button onClick={() => setLimit((l) => l + 30)} className="w-full py-3 text-sm text-teal-700 hover:bg-slate-50 border-t border-slate-100 cursor-pointer">
            Ver más envíos
          </button>
        )}
      </div>

      <EnvioModal
        key={opened?.id ?? 'ninguno'}
        supabase={supabase}
        shipment={opened}
        storeName={storeName}
        canReceive={!!opened && canReceive(opened)}
        onClose={() => setOpenId(null)}
        onChanged={reload}
      />

      {/* Deshacer */}
      <Modal isOpen={!!undoTarget} onClose={() => !undoing && setUndoTarget(null)} title="¿Deshacer este envío?">
        {undoTarget && (
          <div className="space-y-4">
            <p className="text-slate-700">
              {undoTarget.status === 'incompleto'
                ? 'Lo que llegó vuelve a '
                : `Las ${undoTarget.pieces} ${undoTarget.pieces === 1 ? 'pieza vuelve' : 'piezas vuelven'} a `}
              <span className="font-bold">{storeName(undoTarget.from_store_id)}</span>.
            </p>
            {undoTarget.status !== 'pendiente' && (
              <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                {short(storeName(undoTarget.to_store_id))} ya confirmó que llegó. Deshacerlo saca esas piezas de su inventario.
              </p>
            )}
            <p className="text-xs text-slate-500">Queda anotado en Novedades.</p>
            {undoError && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-sm">{undoError}</div>}
            <div className="flex gap-2">
              <button
                onClick={() => setUndoTarget(null)}
                disabled={undoing}
                className="flex-1 py-3 rounded-xl border border-slate-300 font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                No
              </button>
              <button
                onClick={() => void doUndo()}
                disabled={undoing}
                className="flex-1 py-3 rounded-xl bg-slate-800 hover:bg-slate-900 text-white font-bold cursor-pointer disabled:opacity-60"
              >
                {undoing ? 'Deshaciendo…' : 'Sí, deshacer'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function StatusPill({ s, to }: { s: Shipment; to: string }) {
  const base = 'shrink-0 text-xs font-semibold px-2.5 py-1 rounded-full border';
  switch (s.status) {
    case 'pendiente':
      return <span className={`${base} bg-amber-50 text-amber-800 border-amber-200`}>⏳ Esperando que {to} confirme</span>;
    case 'recibido':
      return <span className={`${base} bg-emerald-50 text-emerald-700 border-emerald-200`}>✓ Llegó{s.received_at ? ` · ${whenText(s.received_at)}` : ''}</span>;
    case 'incompleto': {
      const faltaron = s.items.reduce((a, it) => a + it.missing, 0);
      return <span className={`${base} bg-orange-50 text-orange-800 border-orange-200`}>⚠ {faltaron === 1 ? 'Faltó 1' : `Faltaron ${faltaron}`}</span>;
    }
    case 'deshecho':
      return <span className={`${base} bg-slate-100 text-slate-600 border-slate-200`}>↩ Deshecho</span>;
  }
}
