'use client';

// Bandeja de revisión: lo que ChatGPT propone registrar a partir de los
// estados de cuenta. NADA de esto existe en compras, gastos ni pagos hasta que
// el dueño lo aprueba aquí (RPC fin_inbox_approve, db/finanzas_07_chatgpt.sql).
//
// Cada propuesta muestra la línea del banco tal cual al lado de lo que se va a
// registrar, para revisarla de un vistazo. Se puede corregir antes de aprobar.
//
// Recordatorio de la regla del negocio: aprobar NUNCA mueve el saldo de una
// cuenta o tarjeta. La cuenta es solo la forma de pago.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import FinShell from '@/components/finanzas/FinShell';
import InboxEditModal, { type InboxRow, type Option } from '@/components/finanzas/InboxEditModal';
import ConnectChatGPTModal from '@/components/finanzas/ConnectChatGPTModal';
import {
  FinNotice,
  FinStatCard,
  Notice,
  EmptyState,
  btnPrimary,
  btnSecondary,
  btnDanger,
  usePaged,
  Pagination,
} from '@/components/finanzas/ui';
import { fetchAllPages } from '@/lib/finanzas/queries';
import { finErrorMessage, isMissingTableError } from '@/lib/finanzas/errors';
import { caracasMonthStart, caracasToday, formatDate, formatDateTime } from '@/lib/finanzas/dates';
import { useFinanceFilters } from '@/store/useFinanceFilters';
import { accountLabel, fmtUSD, fmtVES } from '@/lib/finanzas/money';

type Estado = 'pendiente' | 'aprobada' | 'descartada';

const KIND_LABEL: Record<string, string> = { compra: 'Compra', gasto: 'Gasto', abono: 'Abono' };
const KIND_TONE: Record<string, string> = {
  compra: 'bg-teal-50 text-teal-800 border-teal-200',
  gasto: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  abono: 'bg-amber-50 text-amber-800 border-amber-300',
};

interface ApproveResult {
  id: string;
  ok: boolean;
  error?: string;
}

export default function BandejaPage() {
  const supabase = useMemo(() => createClient(), []);
  const { dateRange, setDateRange } = useFinanceFilters();

  const [estado, setEstado] = useState<Estado>('pendiente');
  const [rows, setRows] = useState<InboxRow[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [suppliers, setSuppliers] = useState<Option[]>([]);
  const [categories, setCategories] = useState<(Option & { kind: string })[]>([]);
  const [accounts, setAccounts] = useState<(Option & { last4: string | null })[]>([]);
  const [expenseLabels, setExpenseLabels] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<InboxRow | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { rows: inbox, error } = await fetchAllPages<InboxRow>((from, to) =>
      supabase
        .from('fin_inbox')
        .select(
          'id, batch_id, source_file, line_no, raw_text, kind, supplier_id, supplier_name_new, category_id, expense_id, account_id, description, currency, amount, bcv_rate, amount_usd, movement_date, due_date, paid, is_personal, reference, warning, ai_note, status, approve_error, result_expense_id, created_at, reviewed_at',
        )
        .eq('status', estado)
        .order('created_at', { ascending: false })
        .order('line_no', { ascending: true })
        .range(from, to),
    );

    if (error) {
      if (isMissingTableError(error)) setMissing(true);
      else setNotice({ type: 'error', text: finErrorMessage(error) });
      setLoading(false);
      return;
    }

    const [sup, cat, acc, count] = await Promise.all([
      fetchAllPages<Option>((from, to) =>
        supabase.from('fin_suppliers').select('id, name').order('name').range(from, to),
      ),
      supabase.from('fin_categories').select('id, name, kind').eq('is_active', true).order('sort_order'),
      supabase
        .from('fin_accounts')
        .select('id, name, last4')
        .eq('is_active', true)
        .order('name'),
      supabase.from('fin_inbox').select('id', { count: 'exact', head: true }).eq('status', 'pendiente'),
    ]);

    // Etiquetas de las compras a las que van los abonos.
    const expIds = [...new Set(inbox.map((r) => r.expense_id).filter(Boolean))] as string[];
    const labels: Record<string, string> = {};
    if (expIds.length) {
      const { data } = await supabase
        .from('fin_expenses')
        .select('id, expense_date, amount_usd, paid_usd, supplier:fin_suppliers(name), description')
        .in('id', expIds);
      for (const e of (data ?? []) as unknown as {
        id: string;
        expense_date: string;
        amount_usd: number;
        paid_usd: number;
        supplier: { name: string } | null;
        description: string | null;
      }[]) {
        labels[e.id] =
          `${e.supplier?.name ?? e.description ?? 'Compra'} del ${formatDate(e.expense_date)} · ` +
          `falta ${fmtUSD(Number(e.amount_usd) - Number(e.paid_usd))}`;
      }
    }

    setRows(inbox);
    setSuppliers(sup.rows);
    setCategories((cat.data ?? []) as (Option & { kind: string })[]);
    setAccounts((acc.data ?? []) as (Option & { last4: string | null })[]);
    setExpenseLabels(labels);
    setPendingCount(count.count ?? 0);
    setSelected(new Set());
    setLoading(false);
  }, [supabase, estado]);

  useEffect(() => {
    load();
  }, [load]);

  const nameOf = useCallback((list: Option[], id: string | null) => list.find((o) => o.id === id)?.name ?? null, []);

  // Se dibujan de a 100 líneas (un estado de cuenta puede traer 300). Los
  // botones de lote usan TODAS las líneas del lote, estén en la página que
  // estén: "Aprobar todo el lote" no puede aprobar solo la mitad.
  const paged = usePaged(rows, estado, 100);
  const pendingByBatch = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const r of rows) {
      if (r.status !== 'pendiente') continue;
      map.set(r.batch_id, [...(map.get(r.batch_id) ?? []), r.id]);
    }
    return map;
  }, [rows]);
  const batchSize = useMemo(() => {
    const map = new Map<string, { n: number; usd: number }>();
    for (const r of rows) {
      const cur = map.get(r.batch_id) ?? { n: 0, usd: 0 };
      map.set(r.batch_id, { n: cur.n + 1, usd: cur.usd + Number(r.amount_usd) });
    }
    return map;
  }, [rows]);

  // Agrupado por lote (una subida de un archivo), solo con las líneas de la página.
  const batches = useMemo(() => {
    const map = new Map<string, InboxRow[]>();
    for (const r of paged.slice) {
      const list = map.get(r.batch_id) ?? [];
      list.push(r);
      map.set(r.batch_id, list);
    }
    return [...map.entries()].map(([id, list]) => ({
      id,
      file: list[0].source_file,
      createdAt: list[0].created_at,
      rows: list.sort((a, b) => (a.line_no ?? 0) - (b.line_no ?? 0)),
      total: list.reduce((s, r) => s + Number(r.amount_usd), 0),
    }));
  }, [paged.slice]);

  const pendingTotal = useMemo(
    () => (estado === 'pendiente' ? rows.reduce((s, r) => s + Number(r.amount_usd), 0) : 0),
    [rows, estado],
  );

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const approve = async (ids: string[]) => {
    if (!ids.length || busy) return;
    setBusy(true);
    setNotice(null);
    const { data, error } = await supabase.rpc('fin_inbox_approve', { p_ids: ids });
    setBusy(false);
    if (error) {
      setNotice({ type: 'error', text: finErrorMessage(error) });
      return;
    }
    const results = (data ?? []) as ApproveResult[];
    const ok = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    setNotice(
      failed.length
        ? {
            type: ok ? 'info' : 'error',
            text:
              `${ok ? `${ok} aprobada${ok === 1 ? '' : 's'}. ` : ''}` +
              `${failed.length} no se ${failed.length === 1 ? 'pudo' : 'pudieron'} aprobar: el motivo está en rojo en cada una.`,
          }
        : {
            type: 'success',
            text:
              `${ok} aprobada${ok === 1 ? '' : 's'}: ya están en Compras y Gastos. ` +
              'Los saldos de tus cuentas no cambian.',
          },
    );
    load();
  };

  const setStatus = async (ids: string[], status: Estado) => {
    if (!ids.length || busy) return;
    if (status === 'descartada' && ids.length > 1 && !window.confirm(`¿Descartar ${ids.length} propuestas?`)) return;
    setBusy(true);
    const { error } = await supabase
      .from('fin_inbox')
      .update({
        status,
        reviewed_at: status === 'pendiente' ? null : new Date().toISOString(),
      })
      .in('id', ids);
    setBusy(false);
    if (error) {
      setNotice({ type: 'error', text: finErrorMessage(error) });
      return;
    }
    setNotice({
      type: 'success',
      text: status === 'descartada' ? 'Descartado. Si vuelve a venir en otro archivo, no se propondrá de nuevo.' : 'Devuelto a pendientes.',
    });
    load();
  };

  const FILTROS: Array<{ key: Estado; label: string }> = [
    { key: 'pendiente', label: `Pendientes${pendingCount ? ` (${pendingCount})` : ''}` },
    { key: 'aprobada', label: 'Aprobadas' },
    { key: 'descartada', label: 'Descartadas' },
  ];

  const selectedIds = [...selected];

  return (
    <FinShell
      title="Bandeja"
      subtitle="Lo que ChatGPT propone registrar desde tus estados de cuenta. Nada entra hasta que lo apruebes."
      actions={
        <button className={btnSecondary} onClick={() => setConnectOpen(true)}>
          🤖 Conectar ChatGPT
        </button>
      }
    >
      {missing ? (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 max-w-2xl">
          <h2 className="font-bold text-amber-900 mb-2">La Bandeja todavía no está instalada</h2>
          <p className="text-sm text-amber-800">
            Falta correr <span className="font-mono">db/finanzas_07_chatgpt.sql</span> en el SQL Editor de Supabase.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          <FinNotice notice={notice} onClose={() => setNotice(null)} />

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            <FinStatCard
              label="Por revisar"
              value={pendingCount}
              tone={pendingCount ? 'amber' : 'default'}
              sub={estado === 'pendiente' && pendingCount ? fmtUSD(pendingTotal) : 'Nada esperando'}
            />
            <div className="col-span-1 lg:col-span-3 bg-white p-3.5 sm:p-5 rounded-xl shadow-sm border border-slate-200 text-xs sm:text-sm text-slate-600 leading-relaxed">
              Aprobar crea la compra o el gasto (ya pagado con la cuenta indicada) o el abono a la compra
              elegida. <b>No cambia el saldo de ninguna cuenta ni tarjeta</b>: esos los sigues poniendo tú en
              Cuentas.
            </div>
          </div>

          <div className="flex flex-wrap gap-2 items-center">
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
            {estado === 'pendiente' && selectedIds.length > 0 && (
              <div className="w-full sm:w-auto sm:ml-auto flex flex-wrap gap-2 *:flex-auto">
                <button className={btnPrimary} disabled={busy} onClick={() => approve(selectedIds)}>
                  ✓ Aprobar {selectedIds.length}
                </button>
                <button className={btnDanger} disabled={busy} onClick={() => setStatus(selectedIds, 'descartada')}>
                  Descartar {selectedIds.length}
                </button>
              </div>
            )}
          </div>

          {loading ? (
            <div className="py-16 text-center text-slate-400 text-sm">Cargando bandeja…</div>
          ) : batches.length === 0 ? (
            <div className="bg-white rounded-xl shadow-sm border border-slate-200">
              <EmptyState
                title={
                  estado === 'pendiente'
                    ? 'No hay nada por revisar.'
                    : estado === 'aprobada'
                      ? 'Todavía no se ha aprobado nada.'
                      : 'No hay propuestas descartadas.'
                }
                hint={
                  estado === 'pendiente'
                    ? 'Súbele a ChatGPT el estado de cuenta del banco y lo que proponga aparece aquí.'
                    : undefined
                }
              />
            </div>
          ) : (
            batches.map((b) => {
              const pendingIds = pendingByBatch.get(b.id) ?? [];
              const size = batchSize.get(b.id) ?? { n: b.rows.length, usd: b.total };
              const allSelected = pendingIds.length > 0 && pendingIds.every((id) => selected.has(id));
              return (
                <section key={b.id} className="bg-white rounded-xl shadow-sm border border-slate-200">
                  <header className="p-3 sm:p-4 border-b border-slate-100 flex flex-wrap gap-3 items-center">
                    {estado === 'pendiente' && (
                      <input
                        type="checkbox"
                        className="w-5 h-5 accent-teal-700 cursor-pointer"
                        checked={allSelected}
                        onChange={() =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            pendingIds.forEach((id) => (allSelected ? next.delete(id) : next.add(id)));
                            return next;
                          })
                        }
                        aria-label="Seleccionar todo el lote"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-slate-800 truncate">📄 {b.file || 'Estado de cuenta'}</p>
                      <p className="text-xs text-slate-500">
                        {formatDateTime(b.createdAt)} · {size.n} {size.n === 1 ? 'línea' : 'líneas'} ·{' '}
                        {fmtUSD(size.usd)}
                        {size.n > b.rows.length && ` · en esta página: ${b.rows.length}`}
                      </p>
                    </div>
                    {estado === 'pendiente' && (
                      <div className="w-full sm:w-auto flex flex-wrap gap-2 *:flex-auto">
                        <button className={btnPrimary} disabled={busy} onClick={() => approve(pendingIds)}>
                          ✓ Aprobar todo el lote
                        </button>
                        <button className={btnDanger} disabled={busy} onClick={() => setStatus(pendingIds, 'descartada')}>
                          Descartar lote
                        </button>
                      </div>
                    )}
                  </header>

                  <ul className="divide-y divide-slate-100">
                    {b.rows.map((r) => {
                      const supplier = nameOf(suppliers, r.supplier_id) ?? r.supplier_name_new;
                      const category = nameOf(categories, r.category_id);
                      const account = accounts.find((a) => a.id === r.account_id);
                      return (
                        <li key={r.id} className="p-3 sm:p-4 flex gap-3">
                          {estado === 'pendiente' && (
                            <input
                              type="checkbox"
                              className="w-5 h-5 mt-1 accent-teal-700 cursor-pointer shrink-0"
                              checked={selected.has(r.id)}
                              onChange={() => toggle(r.id)}
                              aria-label="Seleccionar"
                            />
                          )}
                          <div className="flex-1 min-w-0 grid gap-3 md:grid-cols-2">
                            {/* Izquierda: lo que dice el banco, tal cual. */}
                            <div className="min-w-0">
                              <p className="text-[10px] uppercase tracking-widest text-slate-400 font-bold">
                                Banco{r.line_no ? ` · línea ${r.line_no}` : ''}
                              </p>
                              <p className="font-mono text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-md px-2 py-1.5 mt-1 break-words">
                                {r.raw_text}
                              </p>
                              {r.reference && <p className="text-[11px] text-slate-400 mt-1">Ref. {r.reference}</p>}
                            </div>

                            {/* Derecha: lo que se va a registrar. */}
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span
                                  className={`inline-block text-xs font-semibold px-2.5 py-0.5 rounded-full border ${KIND_TONE[r.kind] ?? ''}`}
                                >
                                  {KIND_LABEL[r.kind] ?? r.kind}
                                </span>
                                {r.is_personal && (
                                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full border bg-slate-100 text-slate-600 border-slate-200">
                                    Personal
                                  </span>
                                )}
                                <span className="ml-auto font-bold text-slate-800 whitespace-nowrap">
                                  {fmtUSD(r.amount_usd)}
                                </span>
                              </div>
                              {r.currency === 'VES' && (
                                <p className="text-[11px] text-slate-400 text-right">
                                  {fmtVES(r.amount)} @ {r.bcv_rate}
                                </p>
                              )}
                              <p className="text-sm text-slate-800 mt-1">
                                {r.kind === 'abono' ? (
                                  <>
                                    Abono a{' '}
                                    <b>{r.expense_id ? expenseLabels[r.expense_id] ?? 'compra' : '— falta elegir la compra —'}</b>
                                  </>
                                ) : (
                                  <>
                                    <b>{supplier ?? (r.kind === 'compra' ? '— falta proveedor —' : 'Sin proveedor')}</b>
                                    {r.supplier_name_new && !r.supplier_id && (
                                      <span className="ml-1 text-[11px] text-teal-700">(nuevo)</span>
                                    )}
                                    {category && <span className="text-slate-500"> · {category}</span>}
                                  </>
                                )}
                              </p>
                              {r.description && <p className="text-xs text-slate-500">{r.description}</p>}
                              <p className="text-xs text-slate-500 mt-0.5">
                                {formatDate(r.movement_date)} ·{' '}
                                {r.paid || r.kind === 'abono' ? (
                                  <>Pagado con {account ? accountLabel(account) : <b className="text-red-600">— falta la cuenta —</b>}</>
                                ) : (
                                  <>Sin pagar{r.due_date ? `, vence ${formatDate(r.due_date)}` : ''}</>
                                )}
                              </p>
                              {r.ai_note && <p className="text-xs text-slate-500 italic mt-1">ChatGPT: {r.ai_note}</p>}
                              {r.warning && (
                                <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2 py-1 mt-1.5">
                                  ⚠️ {r.warning}
                                </p>
                              )}
                              {r.approve_error && r.status === 'pendiente' && (
                                <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-2 py-1 mt-1.5">
                                  No se pudo aprobar: {r.approve_error}
                                </p>
                              )}

                              <div className="mt-2 flex flex-wrap gap-2 *:flex-auto sm:*:flex-none">
                                {r.status === 'pendiente' && (
                                  <>
                                    <button className={btnPrimary} disabled={busy} onClick={() => approve([r.id])}>
                                      Aprobar
                                    </button>
                                    <button className={btnSecondary} onClick={() => setEditing(r)}>
                                      Corregir
                                    </button>
                                    <button className={btnDanger} disabled={busy} onClick={() => setStatus([r.id], 'descartada')}>
                                      Descartar
                                    </button>
                                  </>
                                )}
                                {r.status === 'descartada' && (
                                  <button className={btnSecondary} disabled={busy} onClick={() => setStatus([r.id], 'pendiente')}>
                                    Devolver a pendientes
                                  </button>
                                )}
                                {r.status === 'aprobada' && r.result_expense_id && (
                                  <Link
                                    href={r.kind === 'gasto' ? '/finanzas/gastos' : '/finanzas/compras'}
                                    // Compras filtra por período y esconde lo ya pagado fuera de él:
                                    // si el período actual no incluye esta compra, se amplía (nunca
                                    // se achica) para que no parezca perdida.
                                    onClick={() => {
                                      const start = caracasMonthStart(r.movement_date);
                                      if (start < dateRange.start || dateRange.end < caracasToday()) {
                                        setDateRange({ start: start < dateRange.start ? start : dateRange.start, end: caracasToday() });
                                      }
                                    }}
                                    className="text-xs text-teal-700 hover:underline"
                                  >
                                    Aprobada {formatDateTime(r.reviewed_at)} · ver en {r.kind === 'gasto' ? 'Gastos' : 'Compras'} →
                                  </Link>
                                )}
                              </div>
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })
          )}

          {paged.pages > 1 && (
            <div className="bg-white rounded-xl shadow-sm border border-slate-200">
              <Pagination paged={paged} className="border-t-0" />
            </div>
          )}
        </div>
      )}

      <InboxEditModal
        row={editing}
        onClose={() => setEditing(null)}
        suppliers={suppliers}
        categories={categories}
        accounts={accounts}
        onSaved={() => {
          setEditing(null);
          setNotice({ type: 'success', text: 'Corrección guardada. Ahora puedes aprobarla.' });
          load();
        }}
      />

      <ConnectChatGPTModal isOpen={connectOpen} onClose={() => setConnectOpen(false)} />
    </FinShell>
  );
}
