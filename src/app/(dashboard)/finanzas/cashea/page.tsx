'use client';

// Finanzas → Cashea: lo vendido con Cashea, por período y día por día.
//
// Es SOLO un reporte (pedido de Gerardo: «solo poner el reporte, sin tantas
// cosas»). Sale entero de las ventas que la caja ya registra: no hay nada que
// anotar a mano, ni pagos de Cashea, ni clientes.
//
//   Vendido con Cashea = lo que fue por Cashea (en un pago dividido, solo esa parte)
//   Inicial, en caja   = sales.cashea_initial_usd, la cobró la tienda
//   Cashea financió    = lo vendido menos la inicial: lo que Cashea tiene que pagar
//
// Las tres cuentas viven en src/lib/cashea.ts, las mismas que usa Reportes.
//
// A diferencia del resto de Finanzas, aquí SÍ hay filtro de tienda: Cashea se
// cobra en cada caja. El filtro es local a esta pantalla; no se toca la tienda
// activa del POS (cambiarla vacía el carrito).

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import FinShell from '@/components/finanzas/FinShell';
import CasheaLogo from '@/components/CasheaLogo';
import { FinNotice, FinStatCard, Notice, btnSecondary, inputClass } from '@/components/finanzas/ui';
import { fetchAllPages } from '@/lib/finanzas/queries';
import { finErrorMessage } from '@/lib/finanzas/errors';
import {
  CARACAS_TZ,
  caracasBounds,
  caracasMonthStart,
  caracasToday,
  formatDate,
  parseSupabaseDate,
} from '@/lib/finanzas/dates';
import { fmtUSD, round2 } from '@/lib/finanzas/money';
import { downloadFinWorkbook, finFilename, FMT_INT, FMT_USD } from '@/lib/finanzas/excel';
import { CASHEA_INITIAL_SINCE, casheaFinancedOf, casheaInitialOf, casheaLeg } from '@/lib/cashea';
import { fetchStores } from '@/lib/transfers';

type Period = 'hoy' | 'semana' | 'mes' | 'mes_pasado' | 'fechas';

const PERIOD_LABEL: Record<Period, string> = {
  hoy: 'Hoy',
  semana: 'Esta semana',
  mes: 'Este mes',
  mes_pasado: 'Mes pasado',
  fechas: 'Elegir fechas',
};

interface SaleItemRow {
  quantity: number;
  custom_name: string | null;
  // PostgREST devuelve la relación como objeto; el tipo generado a veces la
  // declara como lista. Se aceptan las dos.
  products: { name: string } | { name: string }[] | null;
}

interface CasheaSaleRow {
  id: string;
  created_at: string;
  store_id: string;
  total_amount: number;
  payment_method: string;
  payment_method_2: string | null;
  payment_amount_1: number | null;
  payment_amount_2: number | null;
  cashea_initial_usd: number;
  sale_items: SaleItemRow[] | null;
}

interface DayGroup {
  day: string; // 'YYYY-MM-DD' en Caracas
  sales: CasheaSaleRow[];
  vendido: number;
  inicial: number;
  financio: number;
}

// --- Fechas como texto 'YYYY-MM-DD' (sin la hora del navegador) ---

const ymdToUTC = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
const utcToYmd = (t: number) => new Date(t).toISOString().slice(0, 10);
const addDays = (s: string, n: number) => utcToYmd(ymdToUTC(s) + n * 86_400_000);

/** Rango de días de un período, con «hoy» en Caracas. La semana empieza el lunes, como en Reportes. */
function periodRange(period: Period, custom: { start: string; end: string }): { start: string; end: string } {
  const hoy = caracasToday();
  switch (period) {
    case 'hoy':
      return { start: hoy, end: hoy };
    case 'semana': {
      const dow = new Date(ymdToUTC(hoy)).getUTCDay(); // 0 = domingo
      return { start: addDays(hoy, -(dow === 0 ? 6 : dow - 1)), end: hoy };
    }
    case 'mes':
      return { start: caracasMonthStart(hoy), end: hoy };
    case 'mes_pasado': {
      const finAnterior = addDays(caracasMonthStart(hoy), -1);
      return { start: caracasMonthStart(finAnterior), end: finAnterior };
    }
    case 'fechas':
      return custom;
  }
}

/** Día de una venta en Caracas, 'YYYY-MM-DD'. */
const saleDay = (createdAt: string) =>
  parseSupabaseDate(createdAt).toLocaleDateString('en-CA', { timeZone: CARACAS_TZ });

/** '29-oct' */
function dayShort(ymd: string): string {
  const d = new Date(ymdToUTC(ymd) + 12 * 3_600_000);
  const month = d.toLocaleDateString('es-VE', { month: 'short', timeZone: 'UTC' }).replace('.', '');
  return `${ymd.slice(8, 10)}-${month}`;
}

/** 'Jueves' o, corto, 'Jue'. */
function weekdayOf(ymd: string, short = false): string {
  const d = new Date(ymdToUTC(ymd) + 12 * 3_600_000);
  const w = d.toLocaleDateString('es-VE', { weekday: short ? 'short' : 'long', timeZone: 'UTC' }).replace('.', '');
  return `${w.charAt(0).toUpperCase()}${w.slice(1)}`;
}

/** 'Jueves 29-oct' */
const dayLabel = (ymd: string) => `${weekdayOf(ymd)} ${dayShort(ymd)}`;

/** '9:40 a. m.' */
const saleTime = (createdAt: string) =>
  parseSupabaseDate(createdAt).toLocaleTimeString('es-VE', {
    timeZone: CARACAS_TZ,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

const itemName = (it: SaleItemRow) => {
  const p = Array.isArray(it.products) ? it.products[0] : it.products;
  return p?.name ?? it.custom_name ?? 'Artículo';
};

/** 'Zapatos Nike + 1': el primer artículo y cuántos más llevó. */
function itemsSummary(sale: CasheaSaleRow): string {
  const items = (sale.sale_items ?? []).filter((it) => it.quantity > 0);
  if (items.length === 0) return '—';
  const first = items[0];
  const name = `${itemName(first)}${first.quantity > 1 ? ` ×${first.quantity}` : ''}`;
  return items.length > 1 ? `${name} + ${items.length - 1}` : name;
}

const shortStore = (name?: string | null) => (name ?? '').replace(/^tienda de /i, '') || '—';

export default function CasheaPage() {
  const supabase = useMemo(() => createClient(), []);

  const [period, setPeriod] = useState<Period>('mes');
  const [custom, setCustom] = useState(() => ({ start: caracasMonthStart(), end: caracasToday() }));
  const [storeId, setStoreId] = useState('');
  const [stores, setStores] = useState<{ id: string; name: string; is_active?: boolean | null }[]>([]);
  // Las ventas se guardan junto con la consulta que las trajo: mientras no
  // coincida con la actual, la pantalla está cargando. Así un cambio rápido de
  // período no pinta los números del período anterior.
  const [result, setResult] = useState<{ key: string; sales: CasheaSaleRow[] } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [exporting, setExporting] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const range = useMemo(() => periodRange(period, custom), [period, custom]);
  const rangeOk = !!range.start && !!range.end && range.start <= range.end;
  const queryKey = `${range.start}|${range.end}|${storeId}`;
  const loading = !result || result.key !== queryKey;
  const sales = useMemo(() => (loading ? [] : result.sales), [loading, result]);

  useEffect(() => {
    fetchStores(supabase).then((rows) => setStores(rows.filter((s) => s.is_active !== false)));
  }, [supabase]);

  useEffect(() => {
    if (!rangeOk) return;
    let cancelled = false;
    const { fromISO, toISO } = caracasBounds(range.start, range.end);

    // Solo lectura y paginado: PostgREST corta en 1000 filas sin avisar.
    // El .or() toma también los pagos divididos donde Cashea es la segunda parte.
    fetchAllPages<CasheaSaleRow>((from, to) => {
      let q = supabase
        .from('sales')
        .select(
          'id, created_at, store_id, total_amount, payment_method, payment_method_2, payment_amount_1, payment_amount_2, cashea_initial_usd, sale_items (quantity, custom_name, products (name))',
        )
        .or('payment_method.eq.cashea,payment_method_2.eq.cashea')
        .gte('created_at', fromISO)
        .lte('created_at', toISO);
      if (storeId) q = q.eq('store_id', storeId);
      return q.order('created_at', { ascending: false }).range(from, to);
    }).then(({ rows, error }) => {
      if (cancelled) return;
      if (error) setNotice({ type: 'error', text: `Ventas: ${finErrorMessage(error)}` });
      setResult({ key: queryKey, sales: rows });
    });

    return () => {
      cancelled = true;
    };
  }, [supabase, range, rangeOk, storeId, queryKey]);

  const storeName = useCallback((id: string) => stores.find((s) => s.id === id)?.name ?? '', [stores]);

  const kpi = useMemo(() => {
    let vendido = 0;
    let inicial = 0;
    let financio = 0;
    for (const s of sales) {
      vendido += casheaLeg(s);
      inicial += casheaInitialOf(s);
      financio += casheaFinancedOf(s);
    }
    const count = sales.length;
    return {
      vendido: round2(vendido),
      inicial: round2(inicial),
      financio: round2(financio),
      count,
      promedio: count > 0 ? round2(vendido / count) : 0,
    };
  }, [sales]);

  // Un grupo por día, del más reciente al más viejo; dentro del día, en orden de hora.
  const days = useMemo<DayGroup[]>(() => {
    const map = new Map<string, DayGroup>();
    for (const s of sales) {
      const day = saleDay(s.created_at);
      let g = map.get(day);
      if (!g) {
        g = { day, sales: [], vendido: 0, inicial: 0, financio: 0 };
        map.set(day, g);
      }
      g.sales.push(s);
      g.vendido += casheaLeg(s);
      g.inicial += casheaInitialOf(s);
      g.financio += casheaFinancedOf(s);
    }
    const out = [...map.values()].sort((a, b) => b.day.localeCompare(a.day));
    for (const g of out) g.sales.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return out;
  }, [sales]);

  // Antes de que existiera la columna, la inicial quedó en 0: todo cuenta como financiado.
  const hasOldSales = useMemo(
    () => days.some((g) => g.day < CASHEA_INITIAL_SINCE),
    [days],
  );

  const toggleDay = (day: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      return next;
    });

  const scopeText = storeId ? storeName(storeId) : 'Las dos tiendas';

  const exportExcel = async () => {
    setExporting(true);
    try {
      await downloadFinWorkbook({
        filename: finFilename('cashea', range.start, range.end),
        cover: {
          title: 'Ventas con Cashea',
          periodStart: range.start,
          periodEnd: range.end,
          scope: scopeText,
          extra: [
            ['Vendido con Cashea', fmtUSD(kpi.vendido)],
            ['Inicial, en caja', fmtUSD(kpi.inicial)],
            ['Cashea financió', fmtUSD(kpi.financio)],
            ['Ventas con Cashea', `${kpi.count} · promedio ${fmtUSD(kpi.promedio)}`],
          ],
        },
        sheets: [
          {
            name: 'Por día',
            columns: [
              { header: 'Día', key: 'dia', width: 14 },
              { header: 'Ventas', key: 'ventas', width: 10, numFmt: FMT_INT },
              { header: 'Vendido con Cashea', key: 'vendido', width: 18, numFmt: FMT_USD },
              { header: 'Inicial (en caja)', key: 'inicial', width: 18, numFmt: FMT_USD },
              { header: 'Cashea financió', key: 'financio', width: 18, numFmt: FMT_USD },
            ],
            rows: [...days]
              .sort((a, b) => a.day.localeCompare(b.day))
              .map((g) => ({
                dia: formatDate(g.day),
                ventas: g.sales.length,
                vendido: round2(g.vendido),
                inicial: round2(g.inicial),
                financio: round2(g.financio),
              })),
            totals: { ventas: kpi.count, vendido: kpi.vendido, inicial: kpi.inicial, financio: kpi.financio },
            totalsLabel: 'TOTAL',
          },
          {
            name: 'Ventas',
            columns: [
              { header: 'Fecha', key: 'fecha', width: 12 },
              { header: 'Hora', key: 'hora', width: 11 },
              { header: 'Tienda', key: 'tienda', width: 12 },
              { header: 'Artículos', key: 'articulos', width: 40, wrap: true },
              { header: 'Vendido con Cashea', key: 'vendido', width: 18, numFmt: FMT_USD },
              { header: 'Inicial (en caja)', key: 'inicial', width: 18, numFmt: FMT_USD },
              { header: 'Cashea financió', key: 'financio', width: 18, numFmt: FMT_USD },
              { header: 'Total de la venta', key: 'total', width: 16, numFmt: FMT_USD },
            ],
            rows: [...sales]
              .sort((a, b) => a.created_at.localeCompare(b.created_at))
              .map((s) => ({
                fecha: formatDate(saleDay(s.created_at)),
                hora: saleTime(s.created_at),
                tienda: shortStore(storeName(s.store_id)),
                articulos: (s.sale_items ?? [])
                  .filter((it) => it.quantity > 0)
                  .map((it) => `${itemName(it)}${it.quantity > 1 ? ` ×${it.quantity}` : ''}`)
                  .join(', '),
                vendido: casheaLeg(s),
                inicial: casheaInitialOf(s),
                financio: casheaFinancedOf(s),
                total: Number(s.total_amount) || 0,
              })),
            totals: { vendido: kpi.vendido, inicial: kpi.inicial, financio: kpi.financio },
            totalsLabel: 'TOTAL',
            note: 'En un pago dividido, «Vendido con Cashea» es solo la parte que fue por Cashea; «Total de la venta» incluye la otra parte.',
          },
        ],
      });
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : 'Error al exportar.' });
    } finally {
      setExporting(false);
    }
  };

  const showStoreColumn = !storeId;

  return (
    <FinShell
      title="Ventas con Cashea"
      subtitle="Lo vendido con Cashea, lo que entró de inicial y lo que financió Cashea."
      actions={
        <button onClick={exportExcel} disabled={exporting || loading || sales.length === 0} className={btnSecondary}>
          {exporting ? 'Exportando…' : '📥 Excel'}
        </button>
      }
    >
      <div className="space-y-5">
        <FinNotice notice={notice} onClose={() => setNotice(null)} />

        {/* --- Período y tienda --- */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {(Object.keys(PERIOD_LABEL) as Period[]).map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-3 py-1.5 rounded-full text-sm font-semibold transition cursor-pointer ${
                  period === p ? 'bg-[#0f5c5c] text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {PERIOD_LABEL[p]}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {period === 'fechas' ? (
              <>
                <input
                  type="date"
                  value={custom.start}
                  onChange={(e) => setCustom({ ...custom, start: e.target.value })}
                  className={`${inputClass} w-auto`}
                />
                <span className="text-slate-400">al</span>
                <input
                  type="date"
                  value={custom.end}
                  onChange={(e) => setCustom({ ...custom, end: e.target.value })}
                  className={`${inputClass} w-auto`}
                />
              </>
            ) : (
              <span className="text-slate-500">
                {range.start === range.end
                  ? formatDate(range.start)
                  : `${formatDate(range.start)} al ${formatDate(range.end)}`}
              </span>
            )}
            <span className="text-slate-300 mx-1 hidden sm:inline">·</span>
            <label className="flex items-center gap-2">
              <span className="text-slate-500">Tienda</span>
              <select
                value={storeId}
                onChange={(e) => setStoreId(e.target.value)}
                className={`${inputClass} w-auto`}
              >
                <option value="">Las dos</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {!rangeOk ? (
          <FinNotice notice={{ type: 'info', text: 'Elige una fecha de inicio anterior o igual a la final.' }} />
        ) : loading ? (
          <div className="py-20 text-center text-slate-400 text-sm">Cargando las ventas con Cashea…</div>
        ) : (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <FinStatCard label="Vendido con Cashea" value={fmtUSD(kpi.vendido)} tone="amber" sub="Lo que se llevaron" />
              <FinStatCard label="🏪 Inicial, en caja" value={fmtUSD(kpi.inicial)} tone="emerald" sub="La cobró la tienda" />
              <FinStatCard label="Cashea financió" value={fmtUSD(kpi.financio)} tone="teal" sub="Lo que tiene que pagarnos" />
              <FinStatCard
                label="🧾 Ventas con Cashea"
                value={kpi.count}
                sub={kpi.count > 0 ? `Promedio ${fmtUSD(kpi.promedio)} por venta` : 'Ninguna en el período'}
              />
            </div>

            {hasOldSales && (
              <FinNotice
                notice={{
                  type: 'info',
                  text: `Antes del ${formatDate(CASHEA_INITIAL_SINCE)} la caja no guardaba la inicial: en esas ventas todo aparece como financiado por Cashea.`,
                }}
              />
            )}

            {/* --- Día por día --- */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-100">
                <CasheaLogo className="w-7 h-7 rounded-md shrink-0" />
                <div className="min-w-0">
                  <h3 className="font-bold text-slate-800 text-sm">Ventas con Cashea, día por día</h3>
                  <p className="text-xs text-slate-500">Un toque en el día y salen sus ventas.</p>
                </div>
              </div>

              {days.length === 0 ? (
                <p className="text-sm text-slate-400 py-12 text-center">No hubo ventas con Cashea en el período.</p>
              ) : (
                <div className="overflow-x-auto">
                  {/* En el teléfono los tres montos tienen que caber sin deslizar:
                      títulos cortos, día abreviado y menos relleno. */}
                  <table className="w-full text-xs sm:text-sm">
                    <thead className="bg-slate-100 text-slate-600 text-[11px] sm:text-xs uppercase sm:tracking-wide">
                      <tr>
                        <th className="text-left font-semibold pl-2 pr-1 sm:px-4 py-2.5">Día</th>
                        <th className="text-right font-semibold px-3 py-2.5 hidden sm:table-cell">Ventas</th>
                        <th className="text-right font-semibold px-1.5 sm:px-3 py-2.5">Vendido</th>
                        <th className="text-right font-semibold px-1.5 sm:px-3 py-2.5">
                          Inicial<span className="hidden sm:inline"> (en caja)</span>
                        </th>
                        <th className="text-right font-semibold pl-1.5 pr-2 sm:px-4 py-2.5">
                          <span className="hidden sm:inline">Cashea </span>financió
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {days.map((g) => {
                        const open = expanded.has(g.day);
                        return (
                          <Fragment key={g.day}>
                            <tr
                              onClick={() => toggleDay(g.day)}
                              className={`cursor-pointer hover:bg-slate-50 ${open ? 'bg-slate-100' : ''}`}
                            >
                              <td className="pl-2 pr-1 sm:px-4 py-2.5 font-semibold text-slate-800 whitespace-nowrap">
                                <span className="inline-flex items-center gap-1 sm:gap-1.5">
                                  {open ? (
                                    <ChevronDown className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-slate-500 shrink-0" />
                                  ) : (
                                    <ChevronRight className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-slate-500 shrink-0" />
                                  )}
                                  <span className="sm:hidden">{dayShort(g.day)}</span>
                                  <span className="hidden sm:inline">{dayLabel(g.day)}</span>
                                </span>
                                {/* En el teléfono el día de la semana baja a la segunda línea. */}
                                <span className="sm:hidden block text-[11px] font-normal text-slate-500">
                                  {weekdayOf(g.day, true)} · {g.sales.length} {g.sales.length === 1 ? 'venta' : 'ventas'}
                                </span>
                              </td>
                              <td className="px-3 py-2.5 text-right text-slate-600 hidden sm:table-cell">{g.sales.length}</td>
                              <td className="px-1.5 sm:px-3 py-2.5 text-right font-semibold text-amber-600">{fmtUSD(g.vendido)}</td>
                              <td className="px-1.5 sm:px-3 py-2.5 text-right text-emerald-700">{fmtUSD(g.inicial)}</td>
                              <td className="pl-1.5 pr-2 sm:px-4 py-2.5 text-right text-teal-700">{fmtUSD(g.financio)}</td>
                            </tr>
                            {open &&
                              g.sales.map((s) => (
                                <tr key={s.id} className="bg-slate-50/60">
                                  <td className="pl-7 sm:pl-10 pr-1 sm:pr-3 py-2 text-slate-600">
                                    <span className="text-slate-800">{saleTime(s.created_at)}</span>
                                    {showStoreColumn && <> · {shortStore(storeName(s.store_id))}</>}
                                    <span className="block text-slate-500">{itemsSummary(s)}</span>
                                  </td>
                                  <td className="hidden sm:table-cell" />
                                  <td className="px-1.5 sm:px-3 py-2 text-right text-slate-700">{fmtUSD(casheaLeg(s))}</td>
                                  <td className="px-1.5 sm:px-3 py-2 text-right text-slate-700">{fmtUSD(casheaInitialOf(s))}</td>
                                  <td className="pl-1.5 pr-2 sm:px-4 py-2 text-right text-slate-700">{fmtUSD(casheaFinancedOf(s))}</td>
                                </tr>
                              ))}
                          </Fragment>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="bg-emerald-50 font-bold text-slate-800 border-t border-slate-200">
                        <td className="pl-2 pr-1 sm:px-4 py-3">
                          Total
                          <span className="sm:hidden block text-[11px] font-normal text-slate-500">
                            {kpi.count} {kpi.count === 1 ? 'venta' : 'ventas'}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-right hidden sm:table-cell">{kpi.count}</td>
                        <td className="px-1.5 sm:px-3 py-3 text-right">{fmtUSD(kpi.vendido)}</td>
                        <td className="px-1.5 sm:px-3 py-3 text-right">{fmtUSD(kpi.inicial)}</td>
                        <td className="pl-1.5 pr-2 sm:px-4 py-3 text-right">{fmtUSD(kpi.financio)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </FinShell>
  );
}
