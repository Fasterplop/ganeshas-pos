'use client';

// Estado financiero personal, separado del negocio.
//
// Es la misma maquinaria (las mismas tablas, los mismos abonos), con la
// bandera is_personal en true. Lo que cambia es que TODO reporte del negocio
// filtra is_personal = false, así que nada de lo que está aquí se mezcla con
// las finanzas de la tienda. Esta pantalla es el único lugar donde se ve.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import FinShell from '@/components/finanzas/FinShell';
import AccountFormModal, { Account } from '@/components/finanzas/AccountFormModal';
import ExpenseFormModal, { Expense, Category } from '@/components/finanzas/ExpenseFormModal';
import ExpensePaymentsModal from '@/components/finanzas/ExpensePaymentsModal';
import {
  FinNotice,
  FinStatCard,
  Notice,
  EmptyState,
  PaymentStatusBadge,
  DueBadge,
  btnPrimary,
  btnSecondary,
  RowActions,
  MobileAmount,
  inputClass,
} from '@/components/finanzas/ui';
import { fetchAllPages } from '@/lib/finanzas/queries';
import { finErrorMessage } from '@/lib/finanzas/errors';
import { formatDate, caracasToday, caracasMonthStart } from '@/lib/finanzas/dates';
import { fmtUSD, round2, ACCOUNT_KIND_LABEL } from '@/lib/finanzas/money';
import { downloadFinWorkbook, finFilename, FMT_USD } from '@/lib/finanzas/excel';

interface BalanceRow {
  account_id: string;
  balance_usd: number;
  available_usd: number | null;
}

function monthEnd(monthStart: string): string {
  const y = Number(monthStart.slice(0, 4));
  const m = Number(monthStart.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${monthStart.slice(0, 7)}-${String(last).padStart(2, '0')}`;
}

export default function PersonalPage() {
  const supabase = useMemo(() => createClient(), []);

  const [month, setMonth] = useState(() => caracasMonthStart());
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [balances, setBalances] = useState<Map<string, BalanceRow>>(new Map());
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [exporting, setExporting] = useState(false);

  const [accountOpen, setAccountOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [expenseOpen, setExpenseOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);
  const [paying, setPaying] = useState<Expense | null>(null);

  const hoy = caracasToday();

  const load = useCallback(async () => {
    setLoading(true);

    const [acc, bal, exp, cat] = await Promise.all([
      fetchAllPages<Account>((from, to) =>
        supabase
          .from('fin_accounts')
          .select(
            'id, name, kind, bank_name, last4, currency, opening_balance_usd, opening_balance_date, credit_limit_usd, statement_day, due_day, is_personal, is_active, notes',
          )
          .eq('is_personal', true)
          .order('name')
          .range(from, to),
      ),
      fetchAllPages<BalanceRow>((from, to) =>
        supabase
          .from('fin_v_account_balance')
          .select('account_id, balance_usd, available_usd')
          .eq('is_personal', true)
          .range(from, to),
      ),
      // Lo pendiente se trae completo, no solo del mes: una deuda personal de
      // hace tres meses sigue siendo deuda.
      fetchAllPages<Expense>((from, to) =>
        supabase
          .from('fin_expenses')
          .select(
            'id, kind, supplier_id, category_id, shipment_id, description, currency, amount, bcv_rate, amount_usd, expense_date, due_date, paid_usd, status, is_personal, receipt_path, notes, created_at',
          )
          .eq('is_personal', true)
          .order('expense_date', { ascending: false })
          .range(from, to),
      ),
      fetchAllPages<Category>((from, to) =>
        supabase.from('fin_categories').select('id, name, kind, is_active').order('sort_order').range(from, to),
      ),
    ]);

    if (acc.error) setNotice({ type: 'error', text: finErrorMessage(acc.error) });

    setAccounts(acc.rows);
    setBalances(new Map(bal.rows.map((b) => [b.account_id, b])));
    setExpenses(exp.rows);
    setCategories(cat.rows);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  const categoryName = useCallback(
    (id: string | null) => categories.find((c) => c.id === id)?.name ?? '—',
    [categories],
  );
  const saldoDe = (e: Expense) => round2(Number(e.amount_usd) - Number(e.paid_usd));

  const delMes = useMemo(
    () => expenses.filter((e) => e.expense_date >= month && e.expense_date <= monthEnd(month)),
    [expenses, month],
  );

  // Se ven los del mes más todo lo que siga debiéndose.
  const visibles = useMemo(
    () =>
      expenses.filter(
        (e) => e.status !== 'pagada' || (e.expense_date >= month && e.expense_date <= monthEnd(month)),
      ),
    [expenses, month],
  );

  const resumen = useMemo(() => {
    const activas = accounts.filter((a) => a.is_active);
    const efectivo = activas
      .filter((a) => a.kind !== 'tarjeta_credito')
      .reduce((a, x) => a + Number(balances.get(x.id)?.balance_usd ?? x.opening_balance_usd ?? 0), 0);
    const tarjetas = activas
      .filter((a) => a.kind === 'tarjeta_credito')
      .reduce((a, x) => a + Number(balances.get(x.id)?.balance_usd ?? x.opening_balance_usd ?? 0), 0);
    const abiertas = expenses.filter((e) => e.status !== 'pagada');
    return {
      efectivo: round2(efectivo),
      tarjetas: round2(tarjetas),
      gastadoMes: round2(delMes.reduce((a, e) => a + Number(e.amount_usd), 0)),
      deuda: round2(abiertas.reduce((a, e) => a + saldoDe(e), 0)),
      vencido: round2(
        abiertas.filter((e) => e.due_date && e.due_date < hoy).reduce((a, e) => a + saldoDe(e), 0),
      ),
    };
  }, [accounts, balances, expenses, delMes, hoy]);

  const removeExpense = async (e: Expense) => {
    if (!window.confirm(`¿Eliminar este movimiento personal de ${fmtUSD(e.amount_usd)}?`)) return;
    const { error } = await supabase.from('fin_expenses').delete().eq('id', e.id);
    if (error) {
      setNotice({ type: 'error', text: finErrorMessage(error) });
      return;
    }
    setExpenses((p) => p.filter((x) => x.id !== e.id));
  };

  const toggleAccount = async (a: Account) => {
    const next = !a.is_active;
    const { error } = await supabase.from('fin_accounts').update({ is_active: next }).eq('id', a.id);
    if (error) {
      setNotice({ type: 'error', text: finErrorMessage(error) });
      return;
    }
    setAccounts((p) => p.map((x) => (x.id === a.id ? { ...x, is_active: next } : x)));
  };

  const handleExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      await downloadFinWorkbook({
        filename: finFilename(`personal_${month.slice(0, 7)}`),
        cover: {
          title: 'Estado financiero personal',
          periodStart: month,
          periodEnd: monthEnd(month),
          extra: [
            ['Efectivo y bancos', fmtUSD(resumen.efectivo)],
            ['Deuda en tarjetas', fmtUSD(resumen.tarjetas)],
            ['Gastado en el mes', fmtUSD(resumen.gastadoMes)],
            ['Nota', 'Nada de esto entra en los reportes del negocio'],
          ],
        },
        sheets: [
          {
            name: 'Cuentas personales',
            columns: [
              { header: 'Cuenta', key: 'cuenta', width: 26 },
              { header: 'Tipo', key: 'tipo', width: 20 },
              { header: 'Últimos 4', key: 'last4', width: 12 },
              { header: 'Saldo / Consumo', key: 'saldo', width: 16, numFmt: FMT_USD },
              { header: 'Disponible', key: 'disponible', width: 14, numFmt: FMT_USD },
            ],
            rows: accounts.map((a) => ({
              cuenta: a.name,
              tipo: ACCOUNT_KIND_LABEL[a.kind] ?? a.kind,
              last4: a.last4 ?? '',
              saldo: Number(balances.get(a.id)?.balance_usd ?? a.opening_balance_usd ?? 0),
              disponible: Number(balances.get(a.id)?.available_usd ?? 0),
            })),
          },
          {
            name: 'Movimientos personales',
            columns: [
              { header: 'Fecha', key: 'fecha', width: 13 },
              { header: 'Concepto', key: 'concepto', width: 30, wrap: true },
              { header: 'Categoría', key: 'categoria', width: 20 },
              { header: 'Total USD', key: 'total', width: 14, numFmt: FMT_USD },
              { header: 'Saldo', key: 'saldo', width: 14, numFmt: FMT_USD },
              { header: 'Estado', key: 'estado', width: 12 },
            ],
            rows: visibles.map((e) => ({
              fecha: formatDate(e.expense_date),
              concepto: e.description ?? '',
              categoria: categoryName(e.category_id),
              total: Number(e.amount_usd),
              saldo: saldoDe(e),
              estado:
                { pagada: 'Pagada', parcial: 'Parcial', pendiente: 'Pendiente' }[e.status] ?? e.status,
            })),
            totals: {
              total: visibles.reduce((a, e) => a + Number(e.amount_usd), 0),
              saldo: visibles.reduce((a, e) => a + saldoDe(e), 0),
            },
            totalsLabel: 'TOTALES',
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
      title="Personal"
      subtitle="Tus cuentas y gastos, aparte de los del negocio."
      actions={
        <>
          <button onClick={handleExport} disabled={exporting} className={btnSecondary}>
            {exporting ? 'Exportando…' : '📥 Exportar a .xlsx'}
          </button>
          <button
            className={btnSecondary}
            onClick={() => {
              setEditingAccount(null);
              setAccountOpen(true);
            }}
          >
            + Cuenta personal
          </button>
          <button
            className={btnPrimary}
            onClick={() => {
              setEditingExpense(null);
              setExpenseOpen(true);
            }}
          >
            + Registrar gasto
          </button>
        </>
      }
    >
      <div className="space-y-5">
        <FinNotice notice={notice} onClose={() => setNotice(null)} />

        <p className="text-sm text-slate-600 bg-teal-50 border border-teal-200 rounded-lg px-4 py-3">
          El dinero de la tienda y el tuyo <strong>nunca se mezclan</strong>. Nada de lo que registres
          aquí aparece en el resumen del negocio, ni en compras, ni en gastos, ni en los presupuestos,
          ni en el estado de cuenta de un proveedor.
        </p>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <FinStatCard
            label="Efectivo y bancos"
            value={fmtUSD(resumen.efectivo)}
            tone={resumen.efectivo < 0 ? 'red' : 'emerald'}
          />
          <FinStatCard
            label="Deuda en tarjetas"
            value={fmtUSD(resumen.tarjetas)}
            tone={resumen.tarjetas > 0 ? 'amber' : 'default'}
          />
          <FinStatCard label="Gastado en el mes" value={fmtUSD(resumen.gastadoMes)} />
          <FinStatCard
            label="Pendiente por pagar"
            value={fmtUSD(resumen.deuda)}
            tone={resumen.vencido > 0 ? 'red' : resumen.deuda > 0 ? 'amber' : 'default'}
            sub={resumen.vencido > 0 ? `${fmtUSD(resumen.vencido)} vencido` : undefined}
          />
        </div>

        {/* --- Cuentas personales --- */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200">
          <h3 className="px-4 py-3 border-b border-slate-100 font-bold text-slate-800 text-sm">
            Cuentas y tarjetas personales
          </h3>
          {loading ? (
            <div className="py-12 text-center text-slate-400 text-sm">Cargando…</div>
          ) : accounts.length === 0 ? (
            <EmptyState
              title="No hay cuentas personales."
              hint="Créalas aquí, o marca una existente como personal desde la pestaña Cuentas."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-100 text-slate-600">
                  <tr>
                    <th className="text-left font-semibold px-3 sm:px-4 py-3">Cuenta</th>
                    <th className="text-left font-semibold px-4 py-3 hidden md:table-cell">Tipo</th>
                    <th className="text-right font-semibold px-4 py-3 hidden sm:table-cell">Saldo</th>
                    <th className="text-right font-semibold px-4 py-3 hidden sm:table-cell">
                      Disponible
                    </th>
                    <th className="text-right font-semibold px-4 py-3 hidden sm:table-cell">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {accounts.map((a) => {
                    const b = balances.get(a.id);
                    const saldo = Number(b?.balance_usd ?? a.opening_balance_usd ?? 0);
                    const card = a.kind === 'tarjeta_credito';
                    const acciones = (
                      <>
                        <button
                          className={btnSecondary}
                          onClick={() => {
                            setEditingAccount(a);
                            setAccountOpen(true);
                          }}
                        >
                          Editar
                        </button>
                        <button className={btnSecondary} onClick={() => toggleAccount(a)}>
                          {a.is_active ? 'Desactivar' : 'Reactivar'}
                        </button>
                      </>
                    );
                    return (
                      <tr key={a.id} className={`hover:bg-slate-50 ${!a.is_active ? 'opacity-55' : ''}`}>
                        <td className="px-3 sm:px-4 py-3">
                          <span className="font-semibold text-slate-800">{a.name}</span>
                          {a.last4 && <span className="text-slate-400"> ···· {a.last4}</span>}
                          {a.bank_name && <div className="text-xs text-slate-400">{a.bank_name}</div>}
                          <div className="md:hidden text-xs text-slate-500 mt-0.5">
                            {ACCOUNT_KIND_LABEL[a.kind] ?? a.kind}
                          </div>
                          <MobileAmount
                            label={card ? 'Consumo' : 'Saldo'}
                            value={fmtUSD(saldo)}
                            className={card ? 'text-amber-700' : saldo < 0 ? 'text-red-600' : 'text-emerald-700'}
                          />
                          {b?.available_usd != null && (
                            <MobileAmount label="Disponible" value={fmtUSD(b.available_usd)} className="text-slate-600" />
                          )}
                          <RowActions mobile>{acciones}</RowActions>
                        </td>
                        <td className="px-4 py-3 text-slate-600 hidden md:table-cell">
                          {ACCOUNT_KIND_LABEL[a.kind] ?? a.kind}
                        </td>
                        <td
                          className={`px-4 py-3 text-right font-semibold whitespace-nowrap hidden sm:table-cell ${
                            card ? 'text-amber-700' : saldo < 0 ? 'text-red-600' : 'text-emerald-700'
                          }`}
                        >
                          {fmtUSD(saldo)}
                        </td>
                        <td className="px-4 py-3 text-right text-slate-600 hidden sm:table-cell">
                          {b?.available_usd != null ? fmtUSD(b.available_usd) : '—'}
                        </td>
                        <td className="px-4 py-3 hidden sm:table-cell">
                          <RowActions>{acciones}</RowActions>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* --- Movimientos personales --- */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200">
          <div className="px-3 sm:px-4 py-3 border-b border-slate-100 flex flex-wrap items-center gap-3">
            <h3 className="font-bold text-slate-800 text-sm">Movimientos personales</h3>
            <input
              type="month"
              value={month.slice(0, 7)}
              onChange={(e) => setMonth(e.target.value ? `${e.target.value}-01` : caracasMonthStart())}
              className={`${inputClass} w-auto sm:ml-auto`}
            />
            <span className="text-xs text-slate-400">
              Del mes, más lo que siga pendiente.
            </span>
          </div>

          {loading ? (
            <div className="py-12 text-center text-slate-400 text-sm">Cargando…</div>
          ) : visibles.length === 0 ? (
            <EmptyState title="No hay movimientos personales en este mes." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-100 text-slate-600">
                  <tr>
                    <th className="text-left font-semibold px-3 sm:px-4 py-3">Concepto</th>
                    <th className="text-left font-semibold px-4 py-3 hidden md:table-cell">Fecha</th>
                    <th className="text-left font-semibold px-4 py-3 hidden lg:table-cell">
                      Categoría
                    </th>
                    <th className="text-right font-semibold px-4 py-3 hidden sm:table-cell">Monto</th>
                    <th className="text-right font-semibold px-4 py-3 hidden sm:table-cell">Saldo</th>
                    <th className="text-center font-semibold px-4 py-3 hidden sm:table-cell">Estado</th>
                    <th className="text-center font-semibold px-4 py-3 hidden lg:table-cell">Vence</th>
                    <th className="text-right font-semibold px-4 py-3 hidden sm:table-cell">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visibles.map((e) => {
                    const saldo = saldoDe(e);
                    const accionesMov = (
                      <>
                        <button className={btnSecondary} onClick={() => setPaying(e)}>
                          Abonos
                        </button>
                        <button
                          className={btnSecondary}
                          onClick={() => {
                            setEditingExpense(e);
                            setExpenseOpen(true);
                          }}
                        >
                          Editar
                        </button>
                      </>
                    );
                    return (
                      <tr key={e.id} className="hover:bg-slate-50 align-top">
                        <td className="px-3 sm:px-4 py-3">
                          <span className="text-slate-800">{e.description || '—'}</span>
                          <div className="sm:hidden mt-1.5 space-y-1">
                            <PaymentStatusBadge status={e.status} />
                            <div className="text-xs text-slate-400">
                              {formatDate(e.expense_date)} · {categoryName(e.category_id)}
                            </div>
                          </div>
                          <MobileAmount label="Monto" value={fmtUSD(e.amount_usd)} />
                          {saldo > 0 && (
                            <MobileAmount label="Saldo" value={fmtUSD(saldo)} className="text-red-600" />
                          )}
                          <div className="hidden sm:block md:hidden text-xs text-slate-400 mt-0.5">
                            {formatDate(e.expense_date)}
                          </div>
                          <RowActions mobile onDelete={() => removeExpense(e)}>
                            {accionesMov}
                          </RowActions>
                        </td>
                        <td className="px-4 py-3 text-slate-600 whitespace-nowrap hidden md:table-cell">
                          {formatDate(e.expense_date)}
                        </td>
                        <td className="px-4 py-3 text-slate-600 hidden lg:table-cell">
                          {categoryName(e.category_id)}
                        </td>
                        <td className="px-4 py-3 text-right font-semibold text-slate-800 whitespace-nowrap hidden sm:table-cell">
                          {fmtUSD(e.amount_usd)}
                        </td>
                        <td
                          className={`px-4 py-3 text-right font-semibold whitespace-nowrap hidden sm:table-cell ${
                            saldo > 0 ? 'text-red-600' : 'text-slate-300'
                          }`}
                        >
                          {saldo > 0 ? fmtUSD(saldo) : '—'}
                        </td>
                        <td className="px-4 py-3 text-center hidden sm:table-cell">
                          <PaymentStatusBadge status={e.status} />
                        </td>
                        <td className="px-4 py-3 text-center hidden lg:table-cell">
                          {e.status === 'pagada' ? (
                            <span className="text-slate-300">—</span>
                          ) : (
                            <DueBadge dueDate={e.due_date} />
                          )}
                        </td>
                        <td className="px-4 py-3 hidden sm:table-cell">
                          <RowActions onDelete={() => removeExpense(e)}>{accionesMov}</RowActions>
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

      <AccountFormModal
        isOpen={accountOpen}
        onClose={() => setAccountOpen(false)}
        account={editingAccount}
        defaultPersonal
        onSaved={load}
      />

      <ExpenseFormModal
        isOpen={expenseOpen}
        onClose={() => setExpenseOpen(false)}
        expense={editingExpense}
        kind="gasto"
        defaultPersonal
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
    </FinShell>
  );
}
