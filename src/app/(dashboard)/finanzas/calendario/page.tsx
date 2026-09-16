'use client';

// Calendario de pagos.
//
// Reúne en una vista de mes todo lo que vence: facturas de proveedores, gastos
// fijos, fletes y los días de pago y corte de las tarjetas. Los avisos son los
// que pide la propuesta: 7 días, 3 días, el mismo día, y en rojo al vencerse.
//
// Lo pendiente entra solo: el calendario lee fin_expenses con status <> pagada
// y due_date no nulo. No hay un paso extra para "mandar algo al calendario".

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import FinShell from '@/components/finanzas/FinShell';
import ExpensePaymentsModal from '@/components/finanzas/ExpensePaymentsModal';
import type { Expense } from '@/components/finanzas/ExpenseFormModal';
import type { Account } from '@/components/finanzas/AccountFormModal';
import type { Supplier } from '@/components/finanzas/SupplierFormModal';
import type { Subscription } from '@/components/finanzas/SubscriptionsPanel';
import { SUBSCRIPTION_SELECT } from '@/components/finanzas/SubscriptionsPanel';
import {
  FinNotice,
  FinStatCard,
  Notice,
  EmptyState,
  DueBadge,
  PaymentStatusBadge,
  btnSecondary,
  inputClass,
  RowActions,
  MobileAmount,
} from '@/components/finanzas/ui';
import { fetchAllPages } from '@/lib/finanzas/queries';
import { finErrorMessage } from '@/lib/finanzas/errors';
import { caracasToday, caracasMonthStart, formatDate, daysUntil } from '@/lib/finanzas/dates';
import { fmtUSD, round2, accountLabel } from '@/lib/finanzas/money';
import { downloadFinWorkbook, finFilename, FMT_USD } from '@/lib/finanzas/excel';

const DOW = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

function monthDays(monthStart: string): string[] {
  const y = Number(monthStart.slice(0, 4));
  const m = Number(monthStart.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: last }, (_, i) => `${monthStart.slice(0, 7)}-${String(i + 1).padStart(2, '0')}`);
}

/** Hueco inicial de la cuadrícula, con la semana empezando en lunes. */
function leadingBlanks(monthStart: string): number {
  const y = Number(monthStart.slice(0, 4));
  const m = Number(monthStart.slice(5, 7));
  return (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
}

function monthLabel(monthStart: string): string {
  const d = new Date(`${monthStart}T12:00:00Z`);
  const s = d.toLocaleDateString('es-VE', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function shiftMonth(monthStart: string, delta: number): string {
  const y = Number(monthStart.slice(0, 4));
  const m = Number(monthStart.slice(5, 7));
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

interface CardEvent {
  kind: 'pago' | 'corte';
  account: Account;
}

export default function CalendarioPage() {
  const supabase = useMemo(() => createClient(), []);

  const [month, setMonth] = useState(() => caracasMonthStart());
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [paying, setPaying] = useState<Expense | null>(null);
  const [exporting, setExporting] = useState(false);

  const hoy = caracasToday();

  const load = useCallback(async () => {
    setLoading(true);

    // TODO lo que sigue debiendose, sin filtrar por mes: el calendario cambia
    // de mes sin volver a consultar, y los vencidos de meses anteriores tienen
    // que seguir a la vista.
    const { rows, error } = await fetchAllPages<Expense>((from, to) =>
      supabase
        .from('fin_expenses')
        .select(
          'id, kind, supplier_id, category_id, shipment_id, description, currency, amount, bcv_rate, amount_usd, expense_date, due_date, paid_usd, status, is_personal, receipt_path, notes, created_at',
        )
        .eq('is_personal', false)
        .neq('status', 'pagada')
        .not('due_date', 'is', null)
        .order('due_date')
        .range(from, to),
    );
    if (error) {
      setNotice({ type: 'error', text: finErrorMessage(error) });
      setLoading(false);
      return;
    }

    const [acc, sup, sus] = await Promise.all([
      fetchAllPages<Account>((from, to) =>
        supabase
          .from('fin_accounts')
          .select(
            'id, name, kind, bank_name, last4, currency, opening_balance_usd, opening_balance_date, credit_limit_usd, statement_day, due_day, is_personal, is_active, notes',
          )
          .order('name')
          .range(from, to),
      ),
      fetchAllPages<Supplier>((from, to) =>
        supabase
          .from('fin_suppliers')
          .select('id, name, contact_name, phone, email, payment_terms, notes, is_active')
          .order('name')
          .range(from, to),
      ),
      fetchAllPages<Subscription>((from, to) =>
        supabase
          .from('fin_subscriptions')
          .select(SUBSCRIPTION_SELECT)
          .eq('is_active', true)
          .eq('is_personal', false)
          .order('billing_day')
          .range(from, to),
      ),
    ]);

    setExpenses(rows);
    setAccounts(acc.rows);
    setSuppliers(sup.rows);
    setSubs(sus.rows);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  const supplierName = useCallback(
    (id: string | null) => suppliers.find((s) => s.id === id)?.name ?? null,
    [suppliers],
  );
  const saldoDe = (e: Expense) => round2(Number(e.amount_usd) - Number(e.paid_usd));
  const labelDe = useCallback(
    (e: Expense) => supplierName(e.supplier_id) || e.description || 'Sin concepto',
    [supplierName],
  );

  const byDay = useMemo(() => {
    const m = new Map<string, Expense[]>();
    for (const e of expenses) {
      if (!e.due_date) continue;
      const list = m.get(e.due_date);
      if (list) list.push(e);
      else m.set(e.due_date, [e]);
    }
    return m;
  }, [expenses]);

  // Las tarjetas no tienen una fila por vencimiento: su dia de pago y de corte
  // se repite todos los meses, asi que se proyecta sobre el mes que se mira.
  const cardsByDayNumber = useMemo(() => {
    const m = new Map<number, CardEvent[]>();
    for (const a of accounts) {
      if (a.kind !== 'tarjeta_credito' || !a.is_active || a.is_personal) continue;
      if (a.due_day) {
        const list = m.get(a.due_day) ?? [];
        list.push({ kind: 'pago', account: a });
        m.set(a.due_day, list);
      }
      if (a.statement_day) {
        const list = m.get(a.statement_day) ?? [];
        list.push({ kind: 'corte', account: a });
        m.set(a.statement_day, list);
      }
    }
    return m;
  }, [accounts]);

  // Las suscripciones tampoco son filas de vencimiento: son una regla mensual
  // que se proyecta sobre el mes que se mira, igual que las tarjetas. Un corte
  // el 31 en un mes de 30 cae el ultimo dia, no desaparece.
  const subsByDayNumber = useMemo(() => {
    const y = Number(month.slice(0, 4));
    const m = Number(month.slice(5, 7));
    const ultimoDia = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const map = new Map<number, Subscription[]>();
    for (const sub of subs) {
      const dia = Math.min(sub.billing_day, ultimoDia);
      const list = map.get(dia) ?? [];
      list.push(sub);
      map.set(dia, list);
    }
    return map;
  }, [subs, month]);

  const totalSubs = useMemo(() => subs.reduce((a, x) => a + Number(x.amount_usd), 0), [subs]);

  const resumen = useMemo(() => {
    const vencidas = expenses.filter((e) => e.due_date && e.due_date < hoy);
    const enSemana = expenses.filter((e) => {
      const d = daysUntil(e.due_date);
      return d !== null && d >= 0 && d <= 7;
    });
    const enTres = expenses.filter((e) => {
      const d = daysUntil(e.due_date);
      return d !== null && d >= 0 && d <= 3;
    });
    return {
      vencido: vencidas.reduce((a, e) => a + saldoDe(e), 0),
      vencidasCount: vencidas.length,
      semana: enSemana.reduce((a, e) => a + saldoDe(e), 0),
      semanaCount: enSemana.length,
      tresCount: enTres.length,
      totalAbierto: expenses.reduce((a, e) => a + saldoDe(e), 0),
    };
  }, [expenses, hoy]);

  const proximos = useMemo(
    () =>
      [...expenses].sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? '')).slice(0, 40),
    [expenses],
  );

  const days = monthDays(month);
  const blanks = leadingBlanks(month);
  const selectedItems = selected ? (byDay.get(selected) ?? []) : [];
  const selectedCards = selected ? (cardsByDayNumber.get(Number(selected.slice(8, 10))) ?? []) : [];
  const selectedSubs = selected ? (subsByDayNumber.get(Number(selected.slice(8, 10))) ?? []) : [];

  const handleExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      await downloadFinWorkbook({
        filename: finFilename('calendario_pagos'),
        cover: {
          title: 'Calendario de pagos',
          extra: [
            ['Deuda abierta', fmtUSD(resumen.totalAbierto)],
            ['Vencido', fmtUSD(resumen.vencido)],
            ['Vence en 7 días', fmtUSD(resumen.semana)],
          ],
        },
        sheets: [
          {
            name: 'Vencimientos',
            columns: [
              { header: 'Vence', key: 'vence', width: 13 },
              { header: 'Días', key: 'dias', width: 10, align: 'center' },
              { header: 'A quién / Concepto', key: 'quien', width: 30, wrap: true },
              { header: 'Tipo', key: 'tipo', width: 12 },
              { header: 'Total USD', key: 'total', width: 14, numFmt: FMT_USD },
              { header: 'Saldo', key: 'saldo', width: 14, numFmt: FMT_USD },
              { header: 'Estado', key: 'estado', width: 12 },
            ],
            rows: proximos.map((e) => {
              const d = daysUntil(e.due_date);
              return {
                vence: formatDate(e.due_date),
                dias: d === null ? '' : d < 0 ? `${-d} vencido` : d === 0 ? 'hoy' : `en ${d}`,
                quien: labelDe(e),
                tipo: { compra: 'Compra', gasto: 'Gasto', envio: 'Envío' }[e.kind] ?? e.kind,
                total: Number(e.amount_usd),
                saldo: saldoDe(e),
                estado:
                  { pagada: 'Pagada', parcial: 'Parcial', pendiente: 'Pendiente' }[e.status] ?? e.status,
              };
            }),
            totals: { saldo: proximos.reduce((a, e) => a + saldoDe(e), 0) },
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
      title="Calendario de pagos"
      subtitle="Qué vence, cuándo y cuánto. Lo pendiente entra solo."
      actions={
        <button onClick={handleExport} disabled={exporting} className={btnSecondary}>
          {exporting ? 'Exportando…' : '📥 Exportar a .xlsx'}
        </button>
      }
    >
      <div className="space-y-5">
        <FinNotice notice={notice} onClose={() => setNotice(null)} />

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <FinStatCard
            label="Vencido"
            value={fmtUSD(resumen.vencido)}
            tone={resumen.vencido > 0 ? 'red' : 'default'}
            sub={`${resumen.vencidasCount} ${resumen.vencidasCount === 1 ? 'factura' : 'facturas'}`}
          />
          <FinStatCard
            label="Vence en 7 días"
            value={fmtUSD(resumen.semana)}
            tone={resumen.semanaCount > 0 ? 'amber' : 'default'}
            sub={`${resumen.semanaCount} por pagar`}
          />
          <FinStatCard
            label="Vence en 3 días"
            value={resumen.tresCount}
            tone={resumen.tresCount > 0 ? 'amber' : 'default'}
            sub="Lo más urgente"
          />
          <FinStatCard
            label="Suscripciones"
            value={fmtUSD(totalSubs)}
            sub={`${subs.length} al mes`}
          />
        </div>

        {/* --- Cuadrícula del mes --- */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200">
          <div className="px-3 sm:px-4 py-3 border-b border-slate-100 flex flex-wrap items-center gap-2 sm:gap-3">
            <button onClick={() => setMonth(shiftMonth(month, -1))} className={btnSecondary}>
              ←
            </button>
            <h3 className="font-bold text-slate-800 flex-1 sm:flex-none sm:min-w-[170px] text-center">
              {monthLabel(month)}
            </h3>
            <button onClick={() => setMonth(shiftMonth(month, 1))} className={btnSecondary}>
              →
            </button>
            <button
              onClick={() => setMonth(caracasMonthStart())}
              className="text-xs text-teal-700 hover:underline cursor-pointer"
            >
              Hoy
            </button>
            <input
              type="month"
              value={month.slice(0, 7)}
              onChange={(e) => setMonth(e.target.value ? `${e.target.value}-01` : caracasMonthStart())}
              className={`${inputClass} w-full sm:w-auto sm:ml-auto`}
            />
          </div>

          {loading ? (
            <div className="py-16 text-center text-slate-400 text-sm">Cargando vencimientos…</div>
          ) : (
            <div className="p-2 sm:p-3">
              <div className="grid grid-cols-7 gap-0.5 sm:gap-1 mb-1">
                {DOW.map((d) => (
                  <div
                    key={d}
                    className="text-center text-[10px] sm:text-[11px] font-bold uppercase tracking-wide text-slate-400 py-1"
                  >
                    <span className="sm:hidden">{d.charAt(0)}</span>
                    <span className="hidden sm:inline">{d}</span>
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-0.5 sm:gap-1">
                {Array.from({ length: blanks }, (_, i) => (
                  <div key={`b${i}`} className="min-h-[52px] sm:min-h-[84px] rounded-lg bg-slate-50/50" />
                ))}
                {days.map((day) => {
                  const items = byDay.get(day) ?? [];
                  const cards = cardsByDayNumber.get(Number(day.slice(8, 10))) ?? [];
                  const daySubs = subsByDayNumber.get(Number(day.slice(8, 10))) ?? [];
                  const total = items.reduce((a, e) => a + saldoDe(e), 0);
                  const vencido = day < hoy && items.length > 0;
                  const esHoy = day === hoy;
                  const d = daysUntil(day) ?? 99;
                  const urgente = items.length > 0 && d >= 0 && d <= 3;
                  const proximo = items.length > 0 && d > 3 && d <= 7;

                  return (
                    <button
                      key={day}
                      onClick={() => setSelected(selected === day ? null : day)}
                      className={`min-h-[52px] sm:min-h-[84px] rounded-md sm:rounded-lg border p-1 sm:p-1.5 text-left transition-colors cursor-pointer ${
                        selected === day
                          ? 'border-teal-500 ring-1 ring-teal-200 bg-teal-50/40'
                          : vencido
                            ? 'border-red-200 bg-red-50 hover:border-red-400'
                            : urgente
                              ? 'border-amber-300 bg-amber-50 hover:border-amber-400'
                              : proximo
                                ? 'border-amber-200 bg-amber-50/40 hover:border-amber-300'
                                : 'border-slate-100 hover:border-slate-300'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span
                          className={`text-xs font-bold ${
                            esHoy
                              ? 'bg-teal-700 text-white rounded-full w-5 h-5 flex items-center justify-center'
                              : 'text-slate-500'
                          }`}
                        >
                          {Number(day.slice(8, 10))}
                        </span>
                        {total > 0 && (
                          <span
                            className={`hidden sm:inline text-[10px] font-bold ${vencido ? 'text-red-700' : 'text-slate-600'}`}
                          >
                            {fmtUSD(total)}
                          </span>
                        )}
                      </div>

                      {/* En movil no cabe el detalle: se resume en puntos y el
                          dia se toca para verlo abajo. */}
                      <div className="sm:hidden mt-1 flex flex-wrap gap-0.5">
                        {items.length > 0 && (
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${vencido ? 'bg-red-500' : urgente ? 'bg-amber-500' : 'bg-teal-600'}`}
                          />
                        )}
                        {cards.length > 0 && <span className="w-1.5 h-1.5 rounded-full bg-indigo-400" />}
                        {daySubs.length > 0 && <span className="w-1.5 h-1.5 rounded-full bg-violet-400" />}
                      </div>

                      <div className="hidden sm:block mt-1 space-y-0.5">
                        {items.slice(0, 2).map((e) => (
                          <div
                            key={e.id}
                            className={`text-[10px] truncate px-1 py-0.5 rounded ${
                              vencido ? 'bg-red-200 text-red-900' : 'bg-slate-100 text-slate-700'
                            }`}
                          >
                            {labelDe(e)}
                          </div>
                        ))}
                        {items.length > 2 && (
                          <div className="text-[10px] text-slate-400 px-1">+{items.length - 2} más</div>
                        )}
                        {cards.map((c, i) => (
                          <div
                            key={`${c.account.id}${i}`}
                            className={`text-[10px] truncate px-1 py-0.5 rounded ${
                              c.kind === 'pago'
                                ? 'bg-indigo-100 text-indigo-800'
                                : 'bg-slate-100 text-slate-500'
                            }`}
                          >
                            {c.kind === 'pago' ? '💳 Pago' : '✂ Corte'} {c.account.name}
                          </div>
                        ))}
                        {daySubs.map((sub) => (
                          <div
                            key={sub.id}
                            className="text-[10px] truncate px-1 py-0.5 rounded bg-violet-100 text-violet-800"
                          >
                            🔁 {sub.name}
                          </div>
                        ))}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* --- Detalle del día --- */}
        {selected && (
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-slate-800">{formatDate(selected)}</h3>
              <button onClick={() => setSelected(null)} className="text-slate-400 hover:text-slate-700 cursor-pointer">
                ✕
              </button>
            </div>

            {selectedItems.length === 0 && selectedCards.length === 0 && selectedSubs.length === 0 ? (
              <p className="text-sm text-slate-400">Nada vence este día.</p>
            ) : (
              <div className="space-y-2">
                {selectedItems.map((e) => (
                  <div
                    key={e.id}
                    className="flex flex-wrap items-center gap-3 border border-slate-100 rounded-lg px-3 py-2"
                  >
                    <div className="flex-1 min-w-[140px]">
                      <p className="font-semibold text-slate-800">{labelDe(e)}</p>
                      <p className="text-xs text-slate-400">
                        {{ compra: 'Compra', gasto: 'Gasto', envio: 'Envío' }[e.kind] ?? e.kind}
                        {e.description && supplierName(e.supplier_id) ? ` · ${e.description}` : ''}
                      </p>
                    </div>
                    <PaymentStatusBadge status={e.status} />
                    <div className="text-right">
                      <p className="font-bold text-slate-800">{fmtUSD(saldoDe(e))}</p>
                      {Number(e.paid_usd) > 0 && (
                        <p className="text-[10px] text-slate-400">de {fmtUSD(e.amount_usd)}</p>
                      )}
                    </div>
                    <button className={btnSecondary} onClick={() => setPaying(e)}>
                      Abonar
                    </button>
                  </div>
                ))}

                {selectedSubs.map((sub) => (
                  <div
                    key={sub.id}
                    className="flex items-center gap-3 border border-slate-100 rounded-lg px-3 py-2 bg-violet-50/50"
                  >
                    <span className="text-lg">🔁</span>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-slate-800">{sub.name}</p>
                      <p className="text-xs text-slate-400">
                        Suscripción · se cobra el {sub.billing_day} de cada mes
                      </p>
                    </div>
                    <p className="font-bold text-slate-800">{fmtUSD(sub.amount_usd)}</p>
                  </div>
                ))}

                {selectedCards.map((c, i) => (
                  <div
                    key={`${c.account.id}${i}`}
                    className="flex items-center gap-3 border border-slate-100 rounded-lg px-3 py-2 bg-slate-50"
                  >
                    <span className="text-lg">{c.kind === 'pago' ? '💳' : '✂'}</span>
                    <div className="flex-1">
                      <p className="font-semibold text-slate-800">
                        {c.kind === 'pago' ? 'Día de pago' : 'Día de corte'} — {accountLabel(c.account)}
                      </p>
                      <p className="text-xs text-slate-400">
                        {c.kind === 'pago'
                          ? 'Se repite todos los meses según la tarjeta.'
                          : 'Cierra el ciclo de consumo de la tarjeta.'}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* --- Próximos vencimientos --- */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200">
          <h3 className="px-4 py-3 border-b border-slate-100 font-bold text-slate-800 text-sm">
            Próximos vencimientos
          </h3>
          {loading ? (
            <div className="py-10 text-center text-slate-400 text-sm">Cargando…</div>
          ) : proximos.length === 0 ? (
            <EmptyState
              title="No hay nada pendiente de pago."
              hint="Las compras y gastos que queden pendientes aparecen aquí solos."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-100 text-slate-600">
                  <tr>
                    <th className="text-left font-semibold px-3 sm:px-4 py-3">A quién</th>
                    <th className="text-left font-semibold px-4 py-3 hidden sm:table-cell">Vence</th>
                    <th className="text-left font-semibold px-4 py-3 hidden lg:table-cell">Tipo</th>
                    <th className="text-right font-semibold px-4 py-3 hidden sm:table-cell">Saldo</th>
                    <th className="text-center font-semibold px-4 py-3 hidden md:table-cell">Estado</th>
                    <th className="text-right font-semibold px-4 py-3 hidden sm:table-cell">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {proximos.map((e) => (
                    <tr key={e.id} className="hover:bg-slate-50 align-top">
                      <td className="px-3 sm:px-4 py-3">
                        <span className="font-semibold text-slate-800">{labelDe(e)}</span>
                        <div className="sm:hidden mt-1.5">
                          <DueBadge dueDate={e.due_date} />
                        </div>
                        <div className="lg:hidden text-xs text-slate-400 mt-1">
                          {{ compra: 'Compra', gasto: 'Gasto', envio: 'Envío' }[e.kind] ?? e.kind}
                        </div>
                        <MobileAmount label="Saldo" value={fmtUSD(saldoDe(e))} className="text-red-600" />
                        <RowActions mobile>
                          <button className={btnSecondary} onClick={() => setPaying(e)}>
                            Abonar
                          </button>
                        </RowActions>
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell">
                        <DueBadge dueDate={e.due_date} />
                      </td>
                      <td className="px-4 py-3 text-slate-600 hidden lg:table-cell">
                        {{ compra: 'Compra', gasto: 'Gasto', envio: 'Envío' }[e.kind] ?? e.kind}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-red-600 whitespace-nowrap hidden sm:table-cell">
                        {fmtUSD(saldoDe(e))}
                      </td>
                      <td className="px-4 py-3 text-center hidden md:table-cell">
                        <PaymentStatusBadge status={e.status} />
                      </td>
                      <td className="px-4 py-3 text-right hidden sm:table-cell">
                        <button className={btnSecondary} onClick={() => setPaying(e)}>
                          Abonar
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <ExpensePaymentsModal
        isOpen={!!paying}
        onClose={() => setPaying(null)}
        expense={paying}
        accounts={accounts}
        supplierName={paying ? labelDe(paying) : null}
        onChanged={load}
      />
    </FinShell>
  );
}
