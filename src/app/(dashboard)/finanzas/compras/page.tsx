'use client';

// Registro de compras y cuentas por pagar.
//
// El periodo filtra el HISTORIAL, igual que en cajas: una compra que sigue
// debiéndose se muestra siempre, aunque sea de hace tres meses. Ocultarla por
// el rango de fechas sería esconder justo la deuda que el módulo existe para
// controlar.
//
// Lo personal no aparece aquí nunca: los reportes del negocio lo excluyen
// siempre (va en la pestaña Personal).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { usePOSStore } from '@/store/usePOSStore';
import { useFinanceFilters } from '@/store/useFinanceFilters';
import FinShell from '@/components/finanzas/FinShell';
import ExpenseFormModal, { Expense, Category } from '@/components/finanzas/ExpenseFormModal';
import ExpensePaymentsModal from '@/components/finanzas/ExpensePaymentsModal';
import type { Supplier } from '@/components/finanzas/SupplierFormModal';
import type { Account } from '@/components/finanzas/AccountFormModal';
import {
  FinNotice,
  FinStatCard,
  Notice,
  EmptyState,
  PaymentStatusBadge,
  DueBadge,
  btnPrimary,
  btnSecondary,
  inputClass,
} from '@/components/finanzas/ui';
import { fetchAllPages } from '@/lib/finanzas/queries';
import { finErrorMessage } from '@/lib/finanzas/errors';
import { formatDate, caracasToday } from '@/lib/finanzas/dates';
import { fmtUSD, round2 } from '@/lib/finanzas/money';
import { downloadFinWorkbook, finFilename, FMT_USD } from '@/lib/finanzas/excel';
import { signedUrl } from '@/lib/finanzas/storage';

type EstadoFiltro = 'todas' | 'pendiente' | 'parcial' | 'pagada' | 'vencidas';

export default function ComprasPage() {
  const supabase = useMemo(() => createClient(), []);
  const { currentStore } = usePOSStore();
  const { scope, dateRange, setDateRange } = useFinanceFilters();

  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [stores, setStores] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [exporting, setExporting] = useState(false);

  const [estado, setEstado] = useState<EstadoFiltro>('todas');
  const [supplierFilter, setSupplierFilter] = useState('');
  const [search, setSearch] = useState('');

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [paying, setPaying] = useState<Expense | null>(null);

  const load = useCallback(async () => {
    if (scope === 'tienda' && !currentStore) return;
    setLoading(true);

    const { rows, error } = await fetchAllPages<Expense>((from, to) => {
      let q = supabase
        .from('fin_expenses')
        .select(
          'id, store_id, kind, supplier_id, category_id, shipment_id, description, currency, amount, bcv_rate, amount_usd, expense_date, due_date, paid_usd, status, is_personal, receipt_path, notes, created_at',
        )
        .eq('kind', 'compra')
        .eq('is_personal', false);
      if (scope === 'tienda' && currentStore) q = q.eq('store_id', currentStore.id);
      return q.order('expense_date', { ascending: false }).range(from, to);
    });

    if (error) {
      setNotice({ type: 'error', text: finErrorMessage(error) });
      setLoading(false);
      return;
    }

    const [sup, acc, cat, st] = await Promise.all([
      fetchAllPages<Supplier>((from, to) =>
        supabase
          .from('fin_suppliers')
          .select('id, name, contact_name, phone, email, payment_terms, notes, is_active')
          .order('name')
          .range(from, to),
      ),
      fetchAllPages<Account>((from, to) =>
        supabase
          .from('fin_accounts')
          .select(
            'id, name, kind, bank_name, last4, currency, opening_balance_usd, opening_balance_date, credit_limit_usd, statement_day, due_day, is_personal, is_active, notes',
          )
          .order('name')
          .range(from, to),
      ),
      fetchAllPages<Category>((from, to) =>
        supabase.from('fin_categories').select('id, name, kind, is_active').order('sort_order').range(from, to),
      ),
      supabase.from('stores').select('id, name').order('name'),
    ]);

    setExpenses(rows);
    setSuppliers(sup.rows);
    setAccounts(acc.rows);
    setCategories(cat.rows);
    setStores(st.data ?? []);
    setLoading(false);
  }, [supabase, scope, currentStore]);

  useEffect(() => {
    load();
  }, [load]);

  const supplierName = useCallback(
    (id: string | null) => suppliers.find((s) => s.id === id)?.name ?? '—',
    [suppliers],
  );
  const storeName = useCallback((id: string) => stores.find((s) => s.id === id)?.name ?? '—', [stores]);
  const saldoDe = (e: Expense) => round2(Number(e.amount_usd) - Number(e.paid_usd));

  // La deuda es SIEMPRE total, no del período: es lo que de verdad se debe hoy.
  const deuda = useMemo(() => {
    const abiertas = expenses.filter((e) => e.status !== 'pagada');
    const hoy = caracasToday();
    return {
      total: abiertas.reduce((a, e) => a + saldoDe(e), 0),
      vencido: abiertas
        .filter((e) => e.due_date && e.due_date < hoy)
        .reduce((a, e) => a + saldoDe(e), 0),
      abiertas: abiertas.length,
    };
  }, [expenses]);

  const delPeriodo = useMemo(
    () => expenses.filter((e) => e.expense_date >= dateRange.start && e.expense_date <= dateRange.end),
    [expenses, dateRange],
  );
  const compradoPeriodo = delPeriodo.reduce((a, e) => a + Number(e.amount_usd), 0);

  // Se ven las del período MÁS todas las que sigan debiéndose.
  const enVista = useMemo(
    () =>
      expenses.filter(
        (e) =>
          e.status !== 'pagada' ||
          (e.expense_date >= dateRange.start && e.expense_date <= dateRange.end),
      ),
    [expenses, dateRange],
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const hoy = caracasToday();
    return enVista.filter((e) => {
      if (estado === 'vencidas' && !(e.status !== 'pagada' && e.due_date && e.due_date < hoy)) return false;
      if (estado !== 'todas' && estado !== 'vencidas' && e.status !== estado) return false;
      if (supplierFilter && e.supplier_id !== supplierFilter) return false;
      if (!q) return true;
      return (
        supplierName(e.supplier_id).toLowerCase().includes(q) ||
        (e.description ?? '').toLowerCase().includes(q) ||
        (e.notes ?? '').toLowerCase().includes(q)
      );
    });
  }, [enVista, estado, supplierFilter, search, supplierName]);

  const remove = async (e: Expense) => {
    if (
      !window.confirm(
        `¿Eliminar esta compra de ${fmtUSD(e.amount_usd)} a ${supplierName(e.supplier_id)}?\n\n` +
          'Se borran también sus abonos y su detalle. El contenido de las cajas donde iba se conserva.',
      )
    )
      return;
    const { error } = await supabase.from('fin_expenses').delete().eq('id', e.id);
    if (error) {
      setNotice({ type: 'error', text: finErrorMessage(error) });
      return;
    }
    setExpenses((prev) => prev.filter((x) => x.id !== e.id));
    setNotice({ type: 'success', text: 'Compra eliminada.' });
  };

  const openReceipt = async (e: Expense) => {
    if (!e.receipt_path) return;
    const url = await signedUrl(e.receipt_path, 120);
    if (url) window.open(url, '_blank', 'noopener');
    else setNotice({ type: 'error', text: 'No se pudo abrir el recibo.' });
  };

  const handleExport = async () => {
    if (exporting) return;
    if (visible.length === 0) {
      setNotice({ type: 'error', text: 'No hay compras que exportar con el filtro actual.' });
      return;
    }
    setExporting(true);
    try {
      const rows = visible.map((e) => ({
        fecha: formatDate(e.expense_date),
        proveedor: supplierName(e.supplier_id),
        tienda: storeName(e.store_id),
        concepto: e.description ?? '',
        moneda: e.currency === 'VES' ? `Bs @ ${e.bcv_rate}` : 'USD',
        total: Number(e.amount_usd),
        abonado: Number(e.paid_usd),
        saldo: saldoDe(e),
        estado: { pagada: 'Pagada', parcial: 'Parcial', pendiente: 'Pendiente' }[e.status] ?? e.status,
        vence: formatDate(e.due_date),
        nota: e.notes ?? '',
      }));

      const abiertas = rows.filter((r) => r.saldo > 0);

      await downloadFinWorkbook({
        filename: finFilename(
          'compras',
          scope === 'todas' ? 'todas' : currentStore?.name ?? 'tienda',
          dateRange.start,
          dateRange.end,
        ),
        cover: {
          title: 'Compras y cuentas por pagar',
          storeName: scope === 'todas' ? 'Todas las sucursales' : currentStore?.name ?? '—',
          periodStart: dateRange.start,
          periodEnd: dateRange.end,
          extra: [
            ['Comprado en el período', fmtUSD(compradoPeriodo)],
            ['Deuda abierta total', fmtUSD(deuda.total)],
            ['Vencido', fmtUSD(deuda.vencido)],
            ['Alcance', 'Compras del período, más todas las que siguen debiéndose'],
          ],
        },
        sheets: [
          {
            name: 'Compras',
            columns: [
              { header: 'Fecha', key: 'fecha', width: 13 },
              { header: 'Proveedor', key: 'proveedor', width: 24 },
              { header: 'Sucursal', key: 'tienda', width: 16 },
              { header: 'Concepto', key: 'concepto', width: 30, wrap: true },
              { header: 'Moneda', key: 'moneda', width: 14 },
              { header: 'Total USD', key: 'total', width: 14, numFmt: FMT_USD },
              { header: 'Abonado', key: 'abonado', width: 14, numFmt: FMT_USD },
              { header: 'Saldo', key: 'saldo', width: 14, numFmt: FMT_USD },
              { header: 'Estado', key: 'estado', width: 12 },
              { header: 'Vence', key: 'vence', width: 13 },
              { header: 'Nota', key: 'nota', width: 26, wrap: true },
            ],
            rows,
            totals: {
              total: rows.reduce((a, r) => a + r.total, 0),
              abonado: rows.reduce((a, r) => a + r.abonado, 0),
              saldo: rows.reduce((a, r) => a + r.saldo, 0),
            },
            totalsLabel: 'TOTALES',
          },
          {
            name: 'Cuentas por pagar',
            columns: [
              { header: 'Proveedor', key: 'proveedor', width: 24 },
              { header: 'Fecha', key: 'fecha', width: 13 },
              { header: 'Concepto', key: 'concepto', width: 30, wrap: true },
              { header: 'Total USD', key: 'total', width: 14, numFmt: FMT_USD },
              { header: 'Abonado', key: 'abonado', width: 14, numFmt: FMT_USD },
              { header: 'Saldo', key: 'saldo', width: 14, numFmt: FMT_USD },
              { header: 'Vence', key: 'vence', width: 13 },
            ],
            rows: abiertas,
            totals: { saldo: abiertas.reduce((a, r) => a + r.saldo, 0) },
            totalsLabel: 'DEUDA TOTAL',
            note: 'Solo las facturas con saldo pendiente, ordenadas como en pantalla.',
          },
        ],
      });
    } catch (err) {
      setNotice({
        type: 'error',
        text: err instanceof Error ? err.message : 'Error al exportar las compras.',
      });
    } finally {
      setExporting(false);
    }
  };

  if (scope === 'tienda' && !currentStore) {
    return (
      <FinShell title="Compras" subtitle="Registro de compras y cuentas por pagar" showScope>
        <p className="text-slate-500 text-sm">Selecciona una sucursal para ver sus compras.</p>
      </FinShell>
    );
  }

  const FILTROS: Array<{ key: EstadoFiltro; label: string }> = [
    { key: 'todas', label: 'Todas' },
    { key: 'pendiente', label: 'Pendientes' },
    { key: 'parcial', label: 'Parciales' },
    { key: 'vencidas', label: 'Vencidas' },
    { key: 'pagada', label: 'Pagadas' },
  ];

  return (
    <FinShell
      title="Compras"
      subtitle="Qué compraste, a quién, con qué se pagó y cuánto queda debiendo."
      showScope
      actions={
        <>
          <button onClick={handleExport} disabled={exporting} className={btnSecondary}>
            {exporting ? 'Exportando…' : '📥 Exportar a .xlsx'}
          </button>
          <button
            className={btnPrimary}
            disabled={!currentStore}
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            + Registrar compra
          </button>
        </>
      }
    >
      <div className="space-y-5">
        <FinNotice notice={notice} onClose={() => setNotice(null)} />

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <FinStatCard
            label="Comprado en el período"
            value={fmtUSD(compradoPeriodo)}
            sub={`${delPeriodo.length} ${delPeriodo.length === 1 ? 'compra' : 'compras'}`}
          />
          <FinStatCard
            label="Deuda total"
            value={fmtUSD(deuda.total)}
            tone={deuda.total > 0 ? 'amber' : 'default'}
            sub={`${deuda.abiertas} ${deuda.abiertas === 1 ? 'factura abierta' : 'facturas abiertas'}`}
          />
          <FinStatCard
            label="Vencido"
            value={fmtUSD(deuda.vencido)}
            tone={deuda.vencido > 0 ? 'red' : 'default'}
            sub="Ya pasó su fecha de pago"
            active={estado === 'vencidas'}
            onClick={() => setEstado(estado === 'vencidas' ? 'todas' : 'vencidas')}
          />
          <FinStatCard
            label="Proveedores con saldo"
            value={new Set(expenses.filter((e) => e.status !== 'pagada').map((e) => e.supplier_id)).size}
          />
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200">
          <div className="p-4 border-b border-slate-100 flex flex-wrap gap-3 items-center">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por proveedor, concepto o nota…"
              className={`${inputClass} max-w-xs`}
            />
            <select
              value={supplierFilter}
              onChange={(e) => setSupplierFilter(e.target.value)}
              className={`${inputClass} w-auto`}
            >
              <option value="">Todos los proveedores</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <div className="flex items-center gap-2 text-sm">
              <input
                type="date"
                value={dateRange.start}
                onChange={(e) => setDateRange({ ...dateRange, start: e.target.value })}
                className={`${inputClass} w-auto`}
              />
              <span className="text-slate-400">al</span>
              <input
                type="date"
                value={dateRange.end}
                onChange={(e) => setDateRange({ ...dateRange, end: e.target.value })}
                className={`${inputClass} w-auto`}
              />
            </div>
          </div>

          <div className="px-4 py-3 border-b border-slate-100 flex flex-wrap gap-2 items-center">
            {FILTROS.map((f) => (
              <button
                key={f.key}
                onClick={() => setEstado(f.key)}
                className={`text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors cursor-pointer ${
                  estado === f.key
                    ? 'bg-teal-700 text-white border-teal-700'
                    : 'bg-white text-slate-600 border-slate-200 hover:border-teal-400'
                }`}
              >
                {f.label}
              </button>
            ))}
            <span className="ml-auto text-xs text-slate-400">
              El período filtra el historial. Lo que sigue debiéndose se muestra siempre.
            </span>
          </div>

          {loading ? (
            <div className="py-16 text-center text-slate-400 text-sm">Cargando compras…</div>
          ) : visible.length === 0 ? (
            <EmptyState
              title={
                expenses.length === 0
                  ? 'Todavía no hay compras registradas.'
                  : 'Ninguna compra coincide con el filtro.'
              }
              hint={
                expenses.length === 0
                  ? 'Registra la primera: proveedor, monto, fecha y con qué se pagó. Toma menos que anotarla en el cuaderno.'
                  : undefined
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[980px]">
                <thead className="bg-slate-100 text-slate-600">
                  <tr>
                    <th className="text-left font-semibold px-4 py-3">Fecha</th>
                    <th className="text-left font-semibold px-4 py-3">Proveedor</th>
                    <th className="text-left font-semibold px-4 py-3">Concepto</th>
                    <th className="text-right font-semibold px-4 py-3">Total</th>
                    <th className="text-right font-semibold px-4 py-3">Saldo</th>
                    <th className="text-center font-semibold px-4 py-3">Estado</th>
                    <th className="text-center font-semibold px-4 py-3">Vence</th>
                    <th className="text-right font-semibold px-4 py-3">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visible.map((e) => {
                    const saldo = saldoDe(e);
                    return (
                      <tr key={e.id} className="hover:bg-slate-50 align-top">
                        <td className="px-4 py-3 text-slate-600 whitespace-nowrap">
                          {formatDate(e.expense_date)}
                          {scope === 'todas' && (
                            <div className="text-[10px] uppercase tracking-wide text-slate-400 font-bold">
                              {storeName(e.store_id)}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 font-semibold text-slate-800">
                          {supplierName(e.supplier_id)}
                        </td>
                        <td className="px-4 py-3 text-slate-600">
                          {e.description || <span className="text-slate-300">—</span>}
                          {e.receipt_path && (
                            <button
                              onClick={() => openReceipt(e)}
                              className="block text-xs text-teal-700 hover:underline cursor-pointer mt-0.5"
                            >
                              📎 Ver recibo
                            </button>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right font-semibold text-slate-800 whitespace-nowrap">
                          {fmtUSD(e.amount_usd)}
                          {e.currency === 'VES' && (
                            <div className="text-[10px] text-slate-400 font-normal">
                              {Number(e.amount).toLocaleString('es-VE')} Bs @ {e.bcv_rate}
                            </div>
                          )}
                        </td>
                        <td
                          className={`px-4 py-3 text-right font-semibold ${
                            saldo > 0 ? 'text-red-600' : 'text-slate-300'
                          }`}
                        >
                          {saldo > 0 ? fmtUSD(saldo) : '—'}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <PaymentStatusBadge status={e.status} />
                        </td>
                        <td className="px-4 py-3 text-center">
                          {e.status === 'pagada' ? (
                            <span className="text-slate-300">—</span>
                          ) : (
                            <DueBadge dueDate={e.due_date} />
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex justify-end gap-2">
                            <button className={btnSecondary} onClick={() => setPaying(e)}>
                              Abonos
                            </button>
                            <button
                              className={btnSecondary}
                              onClick={() => {
                                setEditing(e);
                                setFormOpen(true);
                              }}
                            >
                              Editar
                            </button>
                            <button
                              className="text-slate-400 hover:text-red-600 px-1 cursor-pointer"
                              onClick={() => remove(e)}
                              title="Eliminar compra"
                            >
                              ✕
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <ExpenseFormModal
        isOpen={formOpen}
        onClose={() => setFormOpen(false)}
        expense={editing}
        kind="compra"
        storeId={editing?.store_id ?? currentStore?.id ?? ''}
        suppliers={suppliers}
        accounts={accounts}
        categories={categories.filter((c) => c.kind === 'compra')}
        onSaved={load}
        onSupplierCreated={(s) =>
          setSuppliers((prev) => [...prev, s].sort((a, b) => a.name.localeCompare(b.name, 'es')))
        }
      />

      <ExpensePaymentsModal
        isOpen={!!paying}
        onClose={() => setPaying(null)}
        expense={paying}
        accounts={accounts}
        supplierName={paying ? supplierName(paying.supplier_id) : null}
        onChanged={load}
      />
    </FinShell>
  );
}
