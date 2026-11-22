'use client';

// Cuentas por cobrar (db/fiado_02_schema.sql, src/lib/fiado.ts).
//
// Lista, por tienda, de los clientes que deben algo fiado: Total fiado,
// Abonado, Debe. «Abonar» registra un abono con el RPC fiado_abonar (se aplica
// a la venta fiada más vieja primero) y «Ver» muestra toda la historia del
// cliente en esta tienda: cada fiado y cada abono. El dueño puede borrar un
// abono mal anotado.
//
// Solo la ven el dueño y quien tenga el permiso de fiar (Usuarios): el mismo
// permiso enciende «Fiado» en la caja y esta sección en el menú.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createClient } from '@/lib/supabase/client';
import { usePOSStore } from '@/store/usePOSStore';
import { formatVariant } from '@/lib/productVariant';
import {
  FIADO_METHODS,
  FIADO_METHOD_LABEL,
  FIADO_MIGRATION_MISSING,
  borrarAbono,
  cents,
  registrarAbono,
  useFiadoAccess,
  type FiadoMethod,
} from '@/lib/fiado';

// PostgREST corta en 1000 filas en silencio: todo se lee por páginas.
const PAGE = 1000;
// Listas para .in(): en trozos, para que la URL no crezca demasiado.
const IN_CHUNK = 150;

type QueryResult = PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }>;

async function fetchAllPages<T>(build: (from: number, to: number) => QueryResult): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message || 'No se pudo leer la base de datos.');
    const rows = (data as T[] | null) ?? [];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

function chunks<T>(list: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// Fechas de Supabase a veces llegan sin zona horaria: se leen como UTC.
const parseDate = (s: string) => {
  if (!s) return new Date();
  let f = s;
  if (f.includes(' ') && !f.includes('T')) f = f.replace(' ', 'T');
  if (!f.endsWith('Z') && !f.includes('+') && !/-\d{2}:\d{2}$/.test(f)) f += 'Z';
  return new Date(f);
};
const fmtDay = (s: string) =>
  parseDate(s).toLocaleDateString('es-VE', { day: '2-digit', month: 'short', year: 'numeric' });
const fmtDayTime = (s: string) =>
  parseDate(s).toLocaleString('es-VE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const usd = (n: number) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;
const parseAmount = (v: string) => {
  const n = Number(v.replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};

type Account = {
  customerId: string;
  name: string;
  phone: string | null;
  total: number;
  paid: number;
  debt: number;
  openSales: number;
};

type DetailItem = { id: string; name: string; code: string; variant: string; qty: number; price: number };
type DetailSale = {
  id: string;
  created_at: string;
  total: number;
  paidAt: string | null;
  points: number;
  cashier: string | null;
  items: DetailItem[];
};
type DetailAbono = {
  batchId: string;
  created_at: string;
  isInitial: boolean;
  rows: { method: string; amount: number }[];
  total: number;
  ref: string | null;
  who: string | null;
};
type Detail = { sales: DetailSale[]; abonos: DetailAbono[] };

type Toast = { type: 'success' | 'error'; text: string } | null;

export default function CuentasPorCobrarPage() {
  const supabase = useMemo(() => createClient(), []);
  const { currentStore, bcvRate } = usePOSStore();
  const access = useFiadoAccess();

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState<Toast>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Ver
  const [verAccount, setVerAccount] = useState<Account | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [openItems, setOpenItems] = useState<Record<string, boolean>>({});

  // Abonar
  const [abonarAccount, setAbonarAccount] = useState<Account | null>(null);
  // Tienda en la que se abrieron Ver/Abonar: si se cambia de tienda, dejan de
  // mostrarse (son de la tienda anterior).
  const [modalStoreId, setModalStoreId] = useState<string | null>(null);

  const storeId = currentStore?.id ?? null;

  const showToast = useCallback((t: Toast) => {
    setToast(t);
    if (t) window.setTimeout(() => setToast(cur => (cur === t ? null : cur)), 5000);
  }, []);

  // ===== Lista: clientes con ventas fiadas abiertas en esta tienda =====
  useEffect(() => {
    if (!access.ready || !access.installed || !access.allowed || !storeId) return;
    let alive = true;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        type SaleRow = { id: string; total_amount: number | string; customer_id: string };
        const sales = await fetchAllPages<SaleRow>((from, to) =>
          supabase
            .from('sales')
            .select('id, total_amount, customer_id')
            .eq('store_id', storeId)
            .eq('payment_method', 'fiado')
            .is('fiado_paid_at', null)
            .order('created_at', { ascending: true })
            .order('id', { ascending: true })
            .range(from, to),
        );

        const paidBySale: Record<string, number> = {};
        for (const ids of chunks(sales.map(s => s.id))) {
          type PayRow = { id: string; sale_id: string; amount_usd: number | string };
          const rows = await fetchAllPages<PayRow>((from, to) =>
            supabase
              .from('fiado_payments')
              .select('id, sale_id, amount_usd')
              .in('sale_id', ids)
              .order('id', { ascending: true })
              .range(from, to),
          );
          for (const r of rows) paidBySale[r.sale_id] = (paidBySale[r.sale_id] || 0) + (Number(r.amount_usd) || 0);
        }

        const byCustomer = new Map<string, Account>();
        for (const s of sales) {
          const acc = byCustomer.get(s.customer_id) ?? {
            customerId: s.customer_id, name: s.customer_id, phone: null, total: 0, paid: 0, debt: 0, openSales: 0,
          };
          acc.total += Number(s.total_amount) || 0;
          acc.paid += paidBySale[s.id] || 0;
          acc.openSales += 1;
          byCustomer.set(s.customer_id, acc);
        }

        const docIds = [...byCustomer.keys()];
        for (const ids of chunks(docIds)) {
          const { data, error } = await supabase
            .from('customers')
            .select('document_id, full_name, phone')
            .eq('store_id', storeId)
            .in('document_id', ids);
          if (error) throw new Error(error.message);
          for (const c of (data ?? []) as { document_id: string; full_name: string | null; phone: string | null }[]) {
            const acc = byCustomer.get(c.document_id);
            if (acc) {
              acc.name = c.full_name?.trim() || c.document_id;
              acc.phone = c.phone?.trim() || null;
            }
          }
        }

        const list = [...byCustomer.values()]
          .map(a => ({ ...a, total: cents(a.total), paid: cents(a.paid), debt: cents(Math.max(0, a.total - a.paid)) }))
          .filter(a => a.debt > 0.004)
          .sort((a, b) => b.debt - a.debt || a.name.localeCompare(b.name));
        if (alive) setAccounts(list);
      } catch (err) {
        if (alive) setLoadError(err instanceof Error ? err.message : 'No se pudieron cargar las cuentas.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [access.ready, access.installed, access.allowed, storeId, supabase, refreshKey]);


  // ===== Ver: toda la historia del cliente en esta tienda =====
  const loadDetail = useCallback(async (customerId: string) => {
    if (!storeId) return;
    setDetailLoading(true);
    try {
      type SaleRow = {
        id: string; created_at: string; total_amount: number | string; fiado_paid_at: string | null;
        fiado_points_awarded: number | null; profiles?: { full_name?: string | null } | null;
        sale_items?: {
          id: string; product_id: string | null; quantity: number | string; unit_price: number | string;
          custom_name: string | null;
          products?: { name?: string | null; sku_barcode?: string | null; talla?: string | null; color?: string | null } | null;
        }[] | null;
      };
      const sales = await fetchAllPages<SaleRow>((from, to) =>
        supabase
          .from('sales')
          .select(`id, created_at, total_amount, fiado_paid_at, fiado_points_awarded,
            profiles (full_name),
            sale_items (id, product_id, quantity, unit_price, custom_name, products (name, sku_barcode, talla, color))`)
          .eq('store_id', storeId)
          .eq('customer_id', customerId)
          .eq('payment_method', 'fiado')
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      );

      type PayRow = {
        id: string; batch_id: string; amount_usd: number | string; payment_method: string;
        payment_ref: string | null; is_initial: boolean; created_at: string; created_by: string;
        profiles?: { full_name?: string | null } | null;
      };
      const payCols = 'id, batch_id, amount_usd, payment_method, payment_ref, is_initial, created_at, created_by';
      const runPays = (cols: string) => fetchAllPages<PayRow>((from, to) =>
        supabase
          .from('fiado_payments')
          .select(cols)
          .eq('store_id', storeId)
          .eq('customer_id', customerId)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      );
      let pays: PayRow[];
      try {
        pays = await runPays(`${payCols}, profiles (full_name)`);
      } catch {
        // Si la relación con profiles no se puede embeber, sin el nombre de quién cobró.
        pays = await runPays(payCols);
      }

      const detailSales: DetailSale[] = sales.map(s => ({
        id: s.id,
        created_at: s.created_at,
        total: Number(s.total_amount) || 0,
        paidAt: s.fiado_paid_at,
        points: Number(s.fiado_points_awarded) || 0,
        cashier: s.profiles?.full_name ?? null,
        items: (s.sale_items ?? []).map(it => ({
          id: it.id,
          name: it.custom_name || it.products?.name || 'Desconocido',
          code: it.products?.sku_barcode?.trim() || (it.product_id ? '' : 'sin código'),
          variant: formatVariant(it.products?.talla, it.products?.color),
          qty: Number(it.quantity) || 0,
          price: Number(it.unit_price) || 0,
        })),
      }));

      // Un abono con dos métodos, o repartido entre varias ventas, son varias
      // filas con el mismo batch_id: se muestran como UNO, con sus métodos.
      const byBatch = new Map<string, DetailAbono>();
      for (const p of pays) {
        const a = byBatch.get(p.batch_id) ?? {
          batchId: p.batch_id, created_at: p.created_at, isInitial: p.is_initial, rows: [], total: 0,
          ref: p.payment_ref, who: p.profiles?.full_name ?? null,
        };
        const amount = Number(p.amount_usd) || 0;
        const row = a.rows.find(r => r.method === p.payment_method);
        if (row) row.amount += amount;
        else a.rows.push({ method: p.payment_method, amount });
        a.total += amount;
        byBatch.set(p.batch_id, a);
      }

      setDetail({ sales: detailSales, abonos: [...byBatch.values()] });
    } catch (err) {
      showToast({ type: 'error', text: err instanceof Error ? err.message : 'No se pudo cargar la historia.' });
      setDetail({ sales: [], abonos: [] });
    } finally {
      setDetailLoading(false);
    }
  }, [storeId, supabase, showToast]);

  const openAbonar = (acc: Account) => {
    setModalStoreId(storeId);
    setAbonarAccount(acc);
  };

  const openVer = (acc: Account) => {
    setModalStoreId(storeId);
    setVerAccount(acc);
    setDetail(null);
    setOpenItems({});
    loadDetail(acc.customerId);
  };

  const handleBorrarAbono = async (abono: DetailAbono) => {
    if (!verAccount) return;
    const msg = `¿Borrar este abono de ${usd(abono.total)} (${fmtDayTime(abono.created_at)})? `
      + 'Se suma de nuevo a lo que debe el cliente y, si ya había terminado de pagar, se le quitan los puntos que sumó.';
    if (!confirm(msg)) return;
    try {
      await borrarAbono(supabase, abono.batchId);
      showToast({ type: 'success', text: 'Abono borrado.' });
      await loadDetail(verAccount.customerId);
      setRefreshKey(k => k + 1);
    } catch (err) {
      showToast({ type: 'error', text: err instanceof Error ? err.message : 'No se pudo borrar el abono.' });
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!q) return accounts;
    const qDigits = q.replace(/\D/g, '');
    return accounts.filter(a =>
      a.name.toLowerCase().replace(/\s+/g, ' ').includes(q)
      || a.customerId.toLowerCase().includes(q)
      || (qDigits.length >= 3 && (a.customerId.replace(/\D/g, '').includes(qDigits)
        || (a.phone ?? '').replace(/\D/g, '').includes(qDigits))),
    );
  }, [accounts, search]);

  const totalPorCobrar = useMemo(() => cents(accounts.reduce((s, a) => s + a.debt, 0)), [accounts]);

  // ===== Estados de acceso =====
  if (!access.ready) {
    return <div className="h-full flex items-center justify-center text-slate-500">Cargando...</div>;
  }
  if (!access.installed) {
    return (
      <div className="max-w-xl mx-auto mt-10 bg-amber-50 border border-amber-200 text-amber-800 rounded-xl p-5 text-sm">
        {FIADO_MIGRATION_MISSING}
      </div>
    );
  }
  if (!access.allowed) {
    return (
      <div className="max-w-xl mx-auto mt-10 bg-white border border-slate-200 rounded-xl p-6 text-center">
        <p className="text-3xl mb-2">🔒</p>
        <p className="font-bold text-slate-800">No tienes permiso para ver Cuentas por cobrar</p>
        <p className="text-sm text-slate-500 mt-1">El dueño lo puede activar en Usuarios.</p>
      </div>
    );
  }
  if (!currentStore) {
    return <div className="h-full flex items-center justify-center text-slate-500">Iniciando tienda...</div>;
  }

  // Totales de la ficha «Ver»: todo lo fiado y todo lo abonado de este cliente
  // en esta tienda (los fiados ya pagados también cuentan, y suman igual).
  const verTotal = detail ? detail.sales.reduce((s, x) => s + x.total, 0) : 0;
  const verPaid = detail ? detail.abonos.reduce((s, x) => s + x.total, 0) : 0;
  const verDebt = cents(Math.max(0, verTotal - verPaid));

  type TimelineEntry = { kind: 'sale'; at: string; sale: DetailSale } | { kind: 'abono'; at: string; abono: DetailAbono };
  const timeline: TimelineEntry[] = detail
    ? [
        ...detail.sales.map(sale => ({ kind: 'sale' as const, at: sale.created_at, sale })),
        ...detail.abonos.map(abono => ({ kind: 'abono' as const, at: abono.created_at, abono })),
      ].sort((a, b) => {
        const d = parseDate(a.at).getTime() - parseDate(b.at).getTime();
        // Misma hora: primero el fiado y después su abono inicial.
        return d !== 0 ? d : (a.kind === 'sale' ? -1 : 1);
      })
    : [];

  return (
    <div className="max-w-6xl mx-auto flex flex-col gap-5 font-sans">
      {toast && (
        <div
          role="status"
          className={`fixed top-4 right-4 left-4 sm:left-auto sm:max-w-sm z-[60] px-4 py-3 rounded-xl shadow-lg text-sm font-semibold ${
            toast.type === 'success' ? 'bg-emerald-600 text-white' : 'bg-rose-600 text-white'
          }`}
        >
          {toast.text}
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Cuentas por cobrar</h1>
          <p className="text-sm text-slate-500">
            Lo que deben los clientes en <strong className="text-teal-700">{currentStore.name}</strong>
          </p>
        </div>
        <div className="bg-white border border-amber-200 rounded-xl px-5 py-3 text-right shadow-sm">
          <p className="text-xs text-slate-500">Total por cobrar</p>
          <p className="text-2xl font-bold text-amber-700">{usd(totalPorCobrar)}</p>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 md:p-6 flex flex-col gap-4">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="🔍 Buscar cliente por nombre o cédula..."
          className="w-full border-2 border-teal-200 focus:border-teal-500 rounded-lg px-4 py-2.5 text-sm outline-none"
        />

        {loading ? (
          <p className="py-10 text-center text-slate-500">Cargando cuentas...</p>
        ) : loadError ? (
          <div className="py-6 text-center">
            <p className="text-rose-600 text-sm font-medium">{loadError}</p>
            <button
              type="button"
              onClick={() => setRefreshKey(k => k + 1)}
              className="mt-3 text-sm font-semibold text-teal-700 underline"
            >
              Reintentar
            </button>
          </div>
        ) : accounts.length === 0 ? (
          <div className="py-10 text-center flex flex-col items-center">
            <span className="text-4xl mb-2 opacity-50">🧾</span>
            <p className="text-slate-500 font-medium">Nadie debe nada en {currentStore.name}.</p>
          </div>
        ) : filtered.length === 0 ? (
          <p className="py-8 text-center text-slate-500 text-sm">Ningún cliente coincide con «{search}».</p>
        ) : (
          <>
            {/* Computadora: tabla */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead className="bg-slate-100 text-slate-600">
                  <tr>
                    <th className="p-3 font-semibold rounded-tl-lg">Cliente</th>
                    <th className="p-3 font-semibold text-right">Total fiado</th>
                    <th className="p-3 font-semibold text-right">Abonado</th>
                    <th className="p-3 font-semibold text-right">Debe</th>
                    <th className="p-3 font-semibold text-right rounded-tr-lg">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.map(a => (
                    <tr key={a.customerId} className="hover:bg-slate-50">
                      <td className="p-3">
                        <p className="font-bold text-slate-800">{a.name}</p>
                        <p className="text-xs text-slate-500">{a.customerId}{a.phone ? ` · ${a.phone}` : ''}</p>
                      </td>
                      <td className="p-3 text-right text-slate-700">{usd(a.total)}</td>
                      <td className="p-3 text-right text-slate-700">
                        {usd(a.paid)}
                        <div className="h-1.5 bg-slate-100 rounded-full mt-1 ml-auto w-24 overflow-hidden">
                          <div className="h-full bg-emerald-500" style={{ width: `${Math.min(100, a.total > 0 ? (a.paid / a.total) * 100 : 0)}%` }} />
                        </div>
                      </td>
                      <td className="p-3 text-right font-bold text-amber-700">{usd(a.debt)}</td>
                      <td className="p-3">
                        <div className="flex justify-end gap-2">
                          <button type="button" onClick={() => openVer(a)} className="px-3 py-1.5 rounded-lg border border-slate-200 text-slate-700 text-xs font-bold hover:bg-slate-50 whitespace-nowrap">👁 Ver</button>
                          <button type="button" onClick={() => openAbonar(a)} className="px-3 py-1.5 rounded-lg bg-[#0f5c5c] text-white text-xs font-bold hover:bg-[#0a4545] whitespace-nowrap">💳 Abonar</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Teléfono: tarjetas */}
            <div className="md:hidden flex flex-col gap-3">
              {filtered.map(a => (
                <div key={a.customerId} className="border border-slate-200 rounded-xl p-3">
                  <div className="flex justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-bold text-slate-800 truncate">{a.name}</p>
                      <p className="text-xs text-slate-500 truncate">{a.customerId}{a.phone ? ` · ${a.phone}` : ''}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-[10px] text-slate-500">Debe</p>
                      <p className="font-bold text-amber-700">{usd(a.debt)}</p>
                    </div>
                  </div>
                  <div className="h-1.5 bg-slate-100 rounded-full mt-2 overflow-hidden">
                    <div className="h-full bg-emerald-500" style={{ width: `${Math.min(100, a.total > 0 ? (a.paid / a.total) * 100 : 0)}%` }} />
                  </div>
                  <p className="text-[11px] text-slate-500 mt-1">Abonó {usd(a.paid)} de {usd(a.total)}</p>
                  <div className="grid grid-cols-2 gap-2 mt-3">
                    <button type="button" onClick={() => openVer(a)} className="py-2 rounded-lg border border-slate-200 text-slate-700 text-sm font-bold">👁 Ver</button>
                    <button type="button" onClick={() => openAbonar(a)} className="py-2 rounded-lg bg-[#0f5c5c] text-white text-sm font-bold">💳 Abonar</button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {!loading && !loadError && accounts.length > 0 && (
          <p className="text-xs text-slate-500">
            {accounts.length} {accounts.length === 1 ? 'cliente debe' : 'clientes deben'} · quien termina de pagar sale de esta lista
          </p>
        )}
      </div>

      {/* ===== Ver ===== */}
      {verAccount && modalStoreId === storeId && (
        <Sheet onClose={() => { if (!abonarAccount) setVerAccount(null); }} wide title={`👁 ${verAccount.name}`}>
          <p className="text-xs text-slate-500 -mt-2 mb-4">{verAccount.customerId}{verAccount.phone ? ` · ${verAccount.phone}` : ''}</p>
          {detailLoading || !detail ? (
            <p className="py-8 text-center text-slate-500">Cargando historia...</p>
          ) : (
            <>
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                <div className="flex justify-between items-start gap-3">
                  <div>
                    <p className="text-xs text-slate-500">Debe</p>
                    <p className="text-2xl font-bold text-amber-700">{usd(verDebt)}</p>
                  </div>
                  {verDebt > 0.004
                    ? <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-amber-100 text-amber-800 border border-amber-300">Debe</span>
                    : <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-700 border border-emerald-300">✓ Pagado</span>}
                </div>
                <div className="h-2 bg-white rounded-full mt-3 overflow-hidden border border-amber-100">
                  <div className="h-full bg-emerald-500" style={{ width: `${Math.min(100, verTotal > 0 ? (verPaid / verTotal) * 100 : 0)}%` }} />
                </div>
                <p className="text-xs text-slate-600 mt-1.5">Pagó {usd(verPaid)} de {usd(verTotal)}</p>
              </div>

              <div className="mt-4 flex flex-col divide-y divide-slate-100 border border-slate-200 rounded-xl overflow-hidden">
                {timeline.length === 0 && <p className="p-4 text-sm text-slate-500">Sin movimientos.</p>}
                {timeline.map(entry => entry.kind === 'sale' ? (
                  <div key={`s-${entry.sale.id}`} className="p-3 bg-white">
                    <div className="flex items-start gap-3">
                      <span className="w-8 h-8 rounded-lg bg-amber-100 flex items-center justify-center shrink-0">🧾</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-slate-800">
                          <b>Fiado</b> · {fmtDay(entry.sale.created_at)} · {entry.sale.items.reduce((s, it) => s + Math.max(0, it.qty), 0)} productos
                          {entry.sale.paidAt && <span className="ml-2 text-[11px] font-bold text-emerald-700">✓ pagado el {fmtDay(entry.sale.paidAt)}{entry.sale.points > 0 ? ` · +${entry.sale.points} pts` : ''}</span>}
                        </p>
                        <p className="text-xs text-slate-500">{entry.sale.cashier ?? 'Cajero'}</p>
                        <button
                          type="button"
                          onClick={() => setOpenItems(o => ({ ...o, [entry.sale.id]: !o[entry.sale.id] }))}
                          className="mt-1 text-xs font-semibold text-teal-700 hover:underline"
                        >
                          🧾 {openItems[entry.sale.id] ? 'Ocultar productos' : 'Ver productos'}
                        </button>
                        {openItems[entry.sale.id] && (
                          <ul className="mt-2 space-y-1.5 text-xs text-slate-700">
                            {entry.sale.items.map(it => (
                              <li key={it.id} className="flex justify-between gap-3">
                                <span className="min-w-0">
                                  {it.qty}x {it.name}
                                  <span className="block text-[11px] text-slate-500">
                                    {[it.code, it.variant].filter(Boolean).join(' · ') || '—'} · {usd(it.price)}
                                  </span>
                                </span>
                                <span className="font-semibold shrink-0">{usd(it.qty * it.price)}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      <span className="font-bold text-slate-800 whitespace-nowrap">{usd(entry.sale.total)}</span>
                    </div>
                  </div>
                ) : (
                  <div key={`a-${entry.abono.batchId}`} className="p-3 bg-white">
                    <div className="flex items-start gap-3">
                      <span className="w-8 h-8 rounded-lg bg-emerald-100 flex items-center justify-center shrink-0">
                        {FIADO_METHODS.find(m => m.id === entry.abono.rows[0]?.method)?.icon ?? '💵'}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-slate-800">
                          <b>{entry.abono.isInitial ? 'Abono inicial' : 'Abono'}</b> · {fmtDayTime(entry.abono.created_at)} · {
                            entry.abono.rows.length > 1
                              ? entry.abono.rows.map(r => `${FIADO_METHOD_LABEL[r.method] ?? r.method} ${usd(r.amount)}`).join(' + ')
                              : (FIADO_METHOD_LABEL[entry.abono.rows[0]?.method] ?? entry.abono.rows[0]?.method)
                          }
                        </p>
                        <p className="text-xs text-slate-500">
                          {[entry.abono.ref ? `Ref. ${entry.abono.ref}` : null, entry.abono.who].filter(Boolean).join(' · ') || '—'}
                        </p>
                        {access.isOwner && (
                          <button
                            type="button"
                            onClick={() => handleBorrarAbono(entry.abono)}
                            className="mt-1 text-[11px] font-semibold text-rose-600 hover:underline"
                          >
                            Borrar
                          </button>
                        )}
                      </div>
                      <span className="font-bold text-emerald-700 whitespace-nowrap">−{usd(entry.abono.total)}</span>
                    </div>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-2 mt-4">
                <button type="button" onClick={() => setVerAccount(null)} className="py-2.5 rounded-lg border border-slate-200 text-slate-700 text-sm font-bold hover:bg-slate-50">Cerrar</button>
                <button
                  type="button"
                  disabled={verDebt <= 0.004}
                  onClick={() => setAbonarAccount({ ...verAccount, debt: verDebt })}
                  className="py-2.5 rounded-lg bg-[#0f5c5c] text-white text-sm font-bold hover:bg-[#0a4545] disabled:bg-slate-300 disabled:cursor-not-allowed"
                >
                  💳 Abonar
                </button>
              </div>
            </>
          )}
        </Sheet>
      )}

      {/* ===== Abonar ===== */}
      {abonarAccount && modalStoreId === storeId && (
        <AbonarSheet
          key={abonarAccount.customerId}
          account={abonarAccount}
          onClose={() => setAbonarAccount(null)}
          onSave={async (input) => {
            const balance = await registrarAbono(supabase, {
              storeId: currentStore.id,
              customerId: abonarAccount.customerId,
              bcvRate: bcvRate > 0 ? bcvRate : null,
              ...input,
            });
            setAbonarAccount(null);
            showToast({
              type: 'success',
              text: balance <= 0.004
                ? `✓ ${abonarAccount.name} terminó de pagar. Sale de la lista.`
                : `Abono guardado. ${abonarAccount.name} queda debiendo ${usd(balance)}.`,
            });
            setRefreshKey(k => k + 1);
            if (verAccount?.customerId === abonarAccount.customerId) await loadDetail(abonarAccount.customerId);
          }}
        />
      )}
    </div>
  );
}

// Ventana sobre la página: centrada en la computadora, a lo ancho en el teléfono.
function Sheet({ title, onClose, wide, children }: { title: string; onClose: () => void; wide?: boolean; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/40 backdrop-blur-sm sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className={`bg-white w-full ${wide ? 'sm:max-w-2xl' : 'sm:max-w-md'} max-h-[92vh] rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col overflow-hidden`}
      >
        <div className="px-5 py-4 border-b border-slate-100 flex justify-between items-center gap-3">
          <h2 className="text-lg font-bold text-slate-800 truncate">{title}</h2>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700 p-1 rounded-full hover:bg-slate-100" aria-label="Cerrar">✕</button>
        </div>
        <div className="p-5 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

type AbonoForm = {
  amount: number;
  method: FiadoMethod;
  ref: string | null;
  method2: FiadoMethod | null;
  amount2: number | null;
};

function AbonarSheet({ account, onClose, onSave }: {
  account: Account;
  onClose: () => void;
  onSave: (input: AbonoForm) => Promise<void>;
}) {
  const [amountStr, setAmountStr] = useState('');
  const [method, setMethod] = useState<FiadoMethod | null>(null);
  const [split, setSplit] = useState(false);
  const [method2, setMethod2] = useState<FiadoMethod | null>(null);
  const [amount1Str, setAmount1Str] = useState('');
  const [ref, setRef] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const debt = account.debt;
  const total = parseAmount(amountStr);
  const totalOk = Number.isFinite(total) && total > 0 && cents(total) <= debt + 0.004;
  const a1 = parseAmount(amount1Str);
  const a2 = split && Number.isFinite(total) && Number.isFinite(a1) ? cents(total - a1) : NaN;
  const remaining = Number.isFinite(total) && total > 0 ? cents(Math.max(0, debt - total)) : debt;

  const validate = (): string | null => {
    if (!Number.isFinite(total) || total <= 0) return 'Escribe el monto del abono.';
    if (cents(total) > debt + 0.004) return `El abono no puede ser mayor que lo que debe (${usd(debt)}).`;
    if (!method) return 'Elige cómo pagó el abono.';
    if (split) {
      if (!method2) return 'Elige el segundo método.';
      if (method2 === method) return 'Los dos métodos deben ser distintos.';
      if (!Number.isFinite(a1) || a1 <= 0 || a1 >= total) {
        return `El monto con ${FIADO_METHOD_LABEL[method]} debe ser mayor a $0 y menor a ${usd(total)}.`;
      }
    }
    return null;
  };

  const save = async () => {
    const msg = validate();
    if (msg) { setError(msg); return; }
    setSaving(true);
    setError(null);
    try {
      await onSave(split
        ? { amount: cents(a1), method: method!, ref: ref.trim() || null, method2: method2!, amount2: a2 }
        : { amount: cents(total), method: method!, ref: ref.trim() || null, method2: null, amount2: null });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar el abono.');
      setSaving(false);
    }
  };

  const methodButtons = (value: FiadoMethod | null, onPick: (m: FiadoMethod) => void, disabled?: FiadoMethod | null) => (
    <div className="grid grid-cols-2 gap-2">
      {FIADO_METHODS.map(m => (
        <button
          key={m.id}
          type="button"
          disabled={disabled === m.id}
          onClick={() => onPick(m.id)}
          className={`py-2.5 px-2 rounded-lg border-2 text-sm font-semibold transition ${
            value === m.id
              ? 'border-[#0f5c5c] bg-teal-50 text-[#0f5c5c]'
              : 'border-slate-200 text-slate-600 hover:border-teal-300 disabled:opacity-40 disabled:cursor-not-allowed'
          }`}
        >
          {m.icon} {m.label}
        </button>
      ))}
    </div>
  );

  return (
    <Sheet title="💳 Registrar abono" onClose={saving ? () => {} : onClose}>
      <p className="font-bold text-slate-800">{account.name}</p>
      <div className="flex justify-between items-center bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-2">
        <span className="text-sm text-slate-600">Debe hoy</span>
        <span className="text-lg font-bold text-amber-700">{usd(debt)}</span>
      </div>

      <label className="block text-xs font-bold text-slate-600 mt-4 mb-1">Monto del abono ($)</label>
      <div className="flex gap-2">
        <input
          type="text"
          inputMode="decimal"
          autoFocus
          value={amountStr}
          onChange={(e) => { setAmountStr(e.target.value); setError(null); }}
          placeholder="0.00"
          className={`flex-1 min-w-0 border-2 rounded-lg px-3 py-2 text-lg font-bold outline-none ${
            amountStr && !totalOk ? 'border-rose-300' : 'border-slate-200 focus:border-teal-500'
          }`}
        />
        <button
          type="button"
          onClick={() => { setAmountStr(debt.toFixed(2)); setError(null); }}
          className="px-3 rounded-lg border border-teal-300 text-teal-700 text-xs font-bold hover:bg-teal-50 whitespace-nowrap"
        >
          Todo lo que debe
        </button>
      </div>

      <label className="block text-xs font-bold text-slate-600 mt-4 mb-1">Método de pago <span className="text-rose-500">*</span></label>
      {methodButtons(method, (m) => { setMethod(m); setError(null); if (m === method2) setMethod2(null); })}

      <div className="mt-2">
        <button
          type="button"
          onClick={() => { setSplit(s => !s); setMethod2(null); setAmount1Str(''); setError(null); }}
          className="text-xs font-semibold text-teal-700 hover:underline"
        >
          {split ? '✕ No dividir' : '➗ Dividir abono'}
        </button>
      </div>

      {split && (
        <div className="mt-2 border border-slate-200 rounded-lg p-3 bg-slate-50">
          <label className="block text-xs font-bold text-slate-600 mb-1">
            Cuánto con {method ? FIADO_METHOD_LABEL[method] : 'el primer método'} ($)
          </label>
          <input
            type="text"
            inputMode="decimal"
            value={amount1Str}
            onChange={(e) => { setAmount1Str(e.target.value); setError(null); }}
            placeholder="0.00"
            className="w-full border-2 border-slate-200 focus:border-teal-500 rounded-lg px-3 py-2 font-bold outline-none bg-white"
          />
          <label className="block text-xs font-bold text-slate-600 mt-3 mb-1">Segundo método <span className="text-rose-500">*</span></label>
          {methodButtons(method2, (m) => { setMethod2(m); setError(null); }, method)}
          {Number.isFinite(a2) && a2 > 0 && method2 && (
            <p className="text-xs text-slate-600 mt-2">Con {FIADO_METHOD_LABEL[method2]}: <b>{usd(a2)}</b></p>
          )}
        </div>
      )}

      <label className="block text-xs font-bold text-slate-600 mt-4 mb-1">Referencia (opcional)</label>
      <input
        type="text"
        value={ref}
        onChange={(e) => setRef(e.target.value)}
        placeholder="Ej. últimos dígitos del Pago Móvil"
        className="w-full border-2 border-slate-200 focus:border-teal-500 rounded-lg px-3 py-2 text-sm outline-none"
      />

      <div className="flex justify-between items-center bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 mt-4">
        <span className="text-sm text-slate-600">Queda debiendo</span>
        <span className={`text-lg font-bold ${remaining <= 0.004 && totalOk ? 'text-emerald-700' : 'text-slate-800'}`}>
          {remaining <= 0.004 && totalOk ? '✓ $0.00' : usd(remaining)}
        </span>
      </div>

      {error && <p className="mt-3 text-sm font-medium text-rose-600">{error}</p>}

      <div className="grid grid-cols-2 gap-2 mt-4">
        <button type="button" onClick={onClose} disabled={saving} className="py-2.5 rounded-lg border border-slate-200 text-slate-700 text-sm font-bold hover:bg-slate-50 disabled:opacity-50">Cancelar</button>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="py-2.5 rounded-lg bg-[#0f5c5c] text-white text-sm font-bold hover:bg-[#0a4545] disabled:bg-slate-300"
        >
          {saving ? 'Guardando...' : 'Guardar abono'}
        </button>
      </div>
    </Sheet>
  );
}
