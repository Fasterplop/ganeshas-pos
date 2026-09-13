'use client';

// Gastos operativos y presupuesto mensual.
//
// El presupuesto se guarda por categoría y mes (fin_budgets) y se edita aquí
// mismo: es del cliente, no nuestro. Lo "gastado" se calcula sumando los
// egresos del mes de esa categoría — incluidas las compras y los fletes que se
// hayan clasificado ahí, porque un presupuesto que ignora parte del gasto no
// sirve para nada.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import FinShell from '@/components/finanzas/FinShell';
import ExpenseFormModal, { Expense, Category } from '@/components/finanzas/ExpenseFormModal';
import ExpensePaymentsModal from '@/components/finanzas/ExpensePaymentsModal';
import CategoriesModal from '@/components/finanzas/CategoriesModal';
import SubscriptionsPanel from '@/components/finanzas/SubscriptionsPanel';
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
import { formatDate, caracasMonthStart } from '@/lib/finanzas/dates';
import { fmtUSD, round2 } from '@/lib/finanzas/money';
import { downloadFinWorkbook, finFilename, FMT_USD } from '@/lib/finanzas/excel';

interface Budget {
  id: string;
  category_id: string;
  period_month: string;
  amount_usd: number;
}

/** Último día del mes de 'YYYY-MM-01', como 'YYYY-MM-DD'. */
function monthEnd(monthStart: string): string {
  const y = Number(monthStart.slice(0, 4));
  const m = Number(monthStart.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${monthStart.slice(0, 7)}-${String(last).padStart(2, '0')}`;
}

export default function GastosPage() {
  const supabase = useMemo(() => createClient(), []);

  const [month, setMonth] = useState(() => caracasMonthStart());
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [exporting, setExporting] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [paying, setPaying] = useState<Expense | null>(null);
  const [catsOpen, setCatsOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const start = month;
    const end = monthEnd(month);

    // Todos los egresos del mes (no solo los operativos): son los que el
    // presupuesto tiene que contar.
    const { rows, error } = await fetchAllPages<Expense>((from, to) =>
      supabase
        .from('fin_expenses')
        .select(
          'id, kind, supplier_id, category_id, shipment_id, description, currency, amount, bcv_rate, amount_usd, expense_date, due_date, paid_usd, status, is_personal, receipt_path, notes, created_at',
        )
        .eq('is_personal', false)
        .gte('expense_date', start)
        .lte('expense_date', end)
        .order('expense_date', { ascending: false })
        .range(from, to),
    );
    if (error) {
      setNotice({ type: 'error', text: finErrorMessage(error) });
      setLoading(false);
      return;
    }

    const [bud, cat, acc] = await Promise.all([
      fetchAllPages<Budget>((from, to) =>
        supabase
          .from('fin_budgets')
          .select('id, category_id, period_month, amount_usd')
          .eq('period_month', start)
          .range(from, to),
      ),
      fetchAllPages<Category>((from, to) =>
        supabase.from('fin_categories').select('id, name, kind, is_active').order('sort_order').range(from, to),
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
    ]);

    setExpenses(rows);
    setBudgets(bud.rows);
    setCategories(cat.rows);
    setAccounts(acc.rows);
    setLoading(false);
  }, [supabase, month]);

  useEffect(() => {
    load();
  }, [load]);

  const categoryName = useCallback(
    (id: string | null) => categories.find((c) => c.id === id)?.name ?? 'Sin categoría',
    [categories],
  );

  const spentByCategory = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of expenses) {
      if (!e.category_id) continue;
      m.set(e.category_id, round2((m.get(e.category_id) ?? 0) + Number(e.amount_usd)));
    }
    return m;
  }, [expenses]);

  const budgetOf = useCallback(
    (categoryId: string) => budgets.find((b) => b.category_id === categoryId) ?? null,
    [budgets],
  );

  // Se listan las categorías activas más cualquiera que tenga movimiento o
  // presupuesto este mes, aunque esté desactivada: si no, un gasto quedaría
  // fuera del cuadro sin explicación.
  const budgetRows = useMemo(() => {
    const ids = new Set<string>([
      ...categories.filter((c) => c.is_active).map((c) => c.id),
      ...budgets.map((b) => b.category_id),
      ...spentByCategory.keys(),
    ]);
    return [...ids]
      .map((id) => {
        const cat = categories.find((c) => c.id === id);
        const presupuesto = Number(budgetOf(id)?.amount_usd ?? 0);
        const gastado = spentByCategory.get(id) ?? 0;
        return {
          id,
          name: cat?.name ?? 'Categoría eliminada',
          kind: cat?.kind ?? 'gasto',
          presupuesto,
          gastado,
          restante: round2(presupuesto - gastado),
          pct: presupuesto > 0 ? Math.round((gastado / presupuesto) * 1000) / 10 : null,
        };
      })
      .sort((a, b) => b.gastado - a.gastado || a.name.localeCompare(b.name, 'es'));
  }, [categories, budgets, spentByCategory, budgetOf]);

  const totales = useMemo(() => {
    const presupuesto = budgetRows.reduce((a, r) => a + r.presupuesto, 0);
    const gastado = budgetRows.reduce((a, r) => a + r.gastado, 0);
    const sinCategoria = expenses
      .filter((e) => !e.category_id)
      .reduce((a, e) => a + Number(e.amount_usd), 0);
    return {
      presupuesto,
      gastado: round2(gastado + sinCategoria),
      sinCategoria: round2(sinCategoria),
      excedidas: budgetRows.filter((r) => r.presupuesto > 0 && r.gastado > r.presupuesto).length,
    };
  }, [budgetRows, expenses]);

  const operativos = useMemo(() => expenses.filter((e) => e.kind === 'gasto'), [expenses]);

  // La categoría Suscripciones queda puesta al crear una: así lo que se
  // registre después cae en el presupuesto correcto.
  const suscripcionesCat = useMemo(
    () => categories.find((c) => c.name.toLowerCase() === 'suscripciones')?.id ?? null,
    [categories],
  );

  const saveBudget = async (categoryId: string, raw: string) => {
    const value = raw.trim() === '' ? 0 : Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      setNotice({ type: 'error', text: 'El presupuesto debe ser un monto válido.' });
      return;
    }
    const existing = budgetOf(categoryId);
    if (existing && Number(existing.amount_usd) === value) return;

    const {
      data: { user },
    } = await supabase.auth.getUser();

    const { data, error } = await supabase
      .from('fin_budgets')
      .upsert(
        {
          category_id: categoryId,
          period_month: month,
          amount_usd: value,
          created_by: user?.id,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'category_id,period_month' },
      )
      .select()
      .single();

    if (error) {
      setNotice({ type: 'error', text: finErrorMessage(error) });
      return;
    }
    setBudgets((p) => {
      const rest = p.filter((b) => b.category_id !== categoryId);
      return [...rest, data as Budget];
    });
  };

  const remove = async (e: Expense) => {
    if (!window.confirm(`¿Eliminar este gasto de ${fmtUSD(e.amount_usd)}?`)) return;
    const { error } = await supabase.from('fin_expenses').delete().eq('id', e.id);
    if (error) {
      setNotice({ type: 'error', text: finErrorMessage(error) });
      return;
    }
    setExpenses((p) => p.filter((x) => x.id !== e.id));
  };

  const handleExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      await downloadFinWorkbook({
        filename: finFilename(`gastos_${month.slice(0, 7)}`),
        cover: {
          title: 'Gastos y presupuesto',
          periodStart: month,
          periodEnd: monthEnd(month),
          extra: [
            ['Presupuestado', fmtUSD(totales.presupuesto)],
            ['Gastado', fmtUSD(totales.gastado)],
            ['Categorías excedidas', String(totales.excedidas)],
          ],
        },
        sheets: [
          {
            name: 'Gastos vs presupuesto',
            columns: [
              { header: 'Categoría', key: 'categoria', width: 24 },
              { header: 'Tipo', key: 'tipo', width: 12 },
              { header: 'Presupuesto', key: 'presupuesto', width: 15, numFmt: FMT_USD },
              { header: 'Gastado', key: 'gastado', width: 15, numFmt: FMT_USD },
              { header: 'Diferencia', key: 'restante', width: 15, numFmt: FMT_USD },
              { header: '% consumido', key: 'pct', width: 13 },
            ],
            rows: budgetRows.map((r) => ({
              categoria: r.name,
              tipo: r.kind === 'compra' ? 'Compra' : 'Gasto',
              presupuesto: r.presupuesto,
              gastado: r.gastado,
              restante: r.restante,
              pct: r.pct != null ? `${r.pct}%` : 'Sin presupuesto',
            })),
            totals: {
              presupuesto: totales.presupuesto,
              gastado: round2(totales.gastado - totales.sinCategoria),
              restante: round2(totales.presupuesto - (totales.gastado - totales.sinCategoria)),
            },
            totalsLabel: 'TOTALES',
            note: 'Lo gastado incluye todo lo clasificado en la categoría: gastos operativos, compras y fletes.',
          },
          {
            name: 'Gastos del mes',
            columns: [
              { header: 'Fecha', key: 'fecha', width: 13 },
              { header: 'Concepto', key: 'concepto', width: 32, wrap: true },
              { header: 'Categoría', key: 'categoria', width: 20 },
              { header: 'Monto USD', key: 'monto', width: 14, numFmt: FMT_USD },
              { header: 'Estado', key: 'estado', width: 12 },
              { header: 'Vence', key: 'vence', width: 13 },
            ],
            rows: operativos.map((e) => ({
              fecha: formatDate(e.expense_date),
              concepto: e.description ?? '',
              categoria: categoryName(e.category_id),
              monto: Number(e.amount_usd),
              estado: { pagada: 'Pagada', parcial: 'Parcial', pendiente: 'Pendiente' }[e.status] ?? e.status,
              vence: formatDate(e.due_date),
            })),
            totals: { monto: operativos.reduce((a, e) => a + Number(e.amount_usd), 0) },
            totalsLabel: 'TOTAL',
          },
        ],
      });
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : 'Error al exportar.' });
    } finally {
      setExporting(false);
    }
  };

  return (
    <FinShell
      title="Gastos y presupuesto"
      subtitle="Lo operativo del mes, contra lo que planeaste gastar."
      actions={
        <>
          <button onClick={() => setCatsOpen(true)} className={btnSecondary}>
            Categorías
          </button>
          <button onClick={handleExport} disabled={exporting} className={btnSecondary}>
            {exporting ? 'Exportando…' : '📥 Exportar a .xlsx'}
          </button>
          <button
            className={btnPrimary}
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            + Registrar gasto
          </button>
        </>
      }
    >
      <div className="space-y-5">
        <FinNotice notice={notice} onClose={() => setNotice(null)} />

        <div className="flex flex-wrap items-center gap-3">
          <label className="text-sm text-slate-600">Mes</label>
          <input
            type="month"
            value={month.slice(0, 7)}
            onChange={(e) => setMonth(e.target.value ? `${e.target.value}-01` : caracasMonthStart())}
            className={`${inputClass} w-auto`}
          />
          <button
            onClick={() => setMonth(caracasMonthStart())}
            className="text-xs text-teal-700 hover:underline cursor-pointer"
          >
            Mes actual
          </button>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <FinStatCard label="Presupuestado" value={fmtUSD(totales.presupuesto)} sub="Para este mes" />
          <FinStatCard
            label="Gastado"
            value={fmtUSD(totales.gastado)}
            tone={
              totales.presupuesto > 0 && totales.gastado > totales.presupuesto ? 'red' : 'default'
            }
            sub="Todo lo del mes, con y sin categoría"
          />
          <FinStatCard
            label="Diferencia"
            value={fmtUSD(round2(totales.presupuesto - totales.gastado))}
            tone={totales.presupuesto - totales.gastado < 0 ? 'red' : 'emerald'}
          />
          <FinStatCard
            label="Categorías excedidas"
            value={totales.excedidas}
            tone={totales.excedidas > 0 ? 'amber' : 'default'}
            sub="Pasaron su límite"
          />
        </div>

        {/* --- Presupuesto por categoría --- */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <h3 className="font-bold text-slate-800 text-sm">Planeado vs. gastado</h3>
            <span className="text-xs text-slate-400">
              Escribe el monto y sal del campo para guardarlo.
            </span>
          </div>

          {loading ? (
            <div className="py-12 text-center text-slate-400 text-sm">Cargando…</div>
          ) : budgetRows.length === 0 ? (
            <EmptyState title="No hay categorías todavía." hint="Créalas con el botón Categorías." />
          ) : (
            <div className="divide-y divide-slate-100">
              {budgetRows.map((r) => {
                const excedido = r.presupuesto > 0 && r.gastado > r.presupuesto;
                const pct = r.pct ?? 0;
                return (
                  <div key={r.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <div className="w-full sm:flex-1 sm:min-w-[140px]">
                        <span className="font-semibold text-slate-800">{r.name}</span>
                        {r.kind === 'compra' && (
                          <span className="ml-2 text-[10px] uppercase tracking-wide font-bold text-slate-400">
                            compra
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-2 text-sm">
                        <span className="text-slate-400 text-xs">Presupuesto</span>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          defaultValue={r.presupuesto > 0 ? r.presupuesto : ''}
                          placeholder="—"
                          onBlur={(e) => saveBudget(r.id, e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                          }}
                          className={`${inputClass} w-28 py-1 text-right`}
                        />
                      </div>

                      <div className="text-sm text-right w-28">
                        <span className="text-slate-400 text-xs block">Gastado</span>
                        <span className={`font-semibold ${excedido ? 'text-red-600' : 'text-slate-800'}`}>
                          {fmtUSD(r.gastado)}
                        </span>
                      </div>

                      <div className="text-sm text-right w-24">
                        {r.presupuesto > 0 ? (
                          <>
                            <span className="text-slate-400 text-xs block">Consumido</span>
                            <span className={`font-semibold ${excedido ? 'text-red-600' : 'text-slate-700'}`}>
                              {pct}%
                            </span>
                          </>
                        ) : (
                          <span className="text-xs text-slate-300">Sin presupuesto</span>
                        )}
                      </div>
                    </div>

                    {r.presupuesto > 0 && (
                      <div className="mt-2 flex items-center gap-3">
                        <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${
                              excedido ? 'bg-red-500' : pct > 80 ? 'bg-amber-400' : 'bg-teal-600'
                            }`}
                            style={{ width: `${Math.min(pct, 100)}%` }}
                          />
                        </div>
                        {excedido && (
                          <span className="text-xs font-semibold text-red-600 whitespace-nowrap">
                            ⚠ Se pasó {fmtUSD(Math.abs(r.restante))}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {totales.sinCategoria > 0 && (
            <p className="px-4 py-3 border-t border-slate-100 text-xs text-amber-700 bg-amber-50">
              Hay {fmtUSD(totales.sinCategoria)} del mes sin categoría, así que no entran en ningún
              presupuesto. Edítalos para asignarles una.
            </p>
          )}
          <p className="px-4 py-2 border-t border-slate-100 text-xs text-slate-400">
            Lo gastado incluye todo lo clasificado en la categoría: gastos operativos, compras y
            fletes.
          </p>
        </div>

        <SubscriptionsPanel accounts={accounts} categoryId={suscripcionesCat} />

        {/* --- Gastos operativos del mes --- */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <h3 className="font-bold text-slate-800 text-sm">Gastos operativos del mes</h3>
            <span className="text-xs text-slate-400">
              {operativos.length} {operativos.length === 1 ? 'gasto' : 'gastos'}
            </span>
          </div>

          {loading ? (
            <div className="py-12 text-center text-slate-400 text-sm">Cargando…</div>
          ) : operativos.length === 0 ? (
            <EmptyState
              title="No hay gastos operativos en este mes."
              hint="Alquiler, nómina, servicios, publicidad, transporte, papelería…"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-100 text-slate-600">
                  <tr>
                    <th className="text-left font-semibold px-3 sm:px-4 py-3">Concepto</th>
                    <th className="text-left font-semibold px-4 py-3 hidden md:table-cell">Fecha</th>
                    <th className="text-left font-semibold px-4 py-3 hidden sm:table-cell">
                      Categoría
                    </th>
                    <th className="text-right font-semibold px-3 sm:px-4 py-3">Monto</th>
                    <th className="text-center font-semibold px-4 py-3 hidden sm:table-cell">Estado</th>
                    <th className="text-center font-semibold px-4 py-3 hidden md:table-cell">Vence</th>
                    <th className="text-right font-semibold px-3 sm:px-4 py-3">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {operativos.map((e) => (
                    <tr key={e.id} className="hover:bg-slate-50 align-top">
                      <td className="px-3 sm:px-4 py-3">
                        <span className="text-slate-800">{e.description || '—'}</span>
                        <div className="sm:hidden mt-1.5 space-y-1">
                          <PaymentStatusBadge status={e.status} />
                          <div className="text-xs text-slate-400">
                            {formatDate(e.expense_date)} · {categoryName(e.category_id)}
                          </div>
                          {e.status !== 'pagada' && e.due_date && <DueBadge dueDate={e.due_date} />}
                        </div>
                        <div className="hidden sm:block md:hidden text-xs text-slate-400 mt-0.5">
                          {formatDate(e.expense_date)}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-600 whitespace-nowrap hidden md:table-cell">
                        {formatDate(e.expense_date)}
                      </td>
                      <td className="px-4 py-3 text-slate-600 hidden sm:table-cell">
                        {categoryName(e.category_id)}
                      </td>
                      <td className="px-3 sm:px-4 py-3 text-right font-semibold text-slate-800 whitespace-nowrap">
                        {fmtUSD(e.amount_usd)}
                      </td>
                      <td className="px-4 py-3 text-center hidden sm:table-cell">
                        <PaymentStatusBadge status={e.status} />
                      </td>
                      <td className="px-4 py-3 text-center hidden md:table-cell">
                        {e.status === 'pagada' ? (
                          <span className="text-slate-300">—</span>
                        ) : (
                          <DueBadge dueDate={e.due_date} />
                        )}
                      </td>
                      <td className="px-3 sm:px-4 py-3">
                        <div className="flex flex-wrap justify-end gap-2">
                          <button className={btnSecondary} onClick={() => setPaying(e)}>
                            Abonos
                          </button>
                          <button
                            className={`${btnSecondary} hidden sm:inline-block`}
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
                            title="Eliminar gasto"
                          >
                            ✕
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
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
        kind="gasto"
        suppliers={[]}
        accounts={accounts}
        categories={categories}
        onSaved={load}
      />

      <ExpensePaymentsModal
        isOpen={!!paying}
        onClose={() => setPaying(null)}
        expense={paying}
        accounts={accounts}
        supplierName={paying?.description ?? null}
        onChanged={load}
      />

      <CategoriesModal
        isOpen={catsOpen}
        onClose={() => setCatsOpen(false)}
        categories={categories}
        onChanged={load}
      />
    </FinShell>
  );
}
