'use client';

// Estado de cuenta de un proveedor: historial completo de una marca con sus
// compras, lo abonado y el saldo corriente.
//
// Lo abierto se muestra primero porque es lo que se consulta: "¿cuánto le
// debo a Kancan y cuándo vence?".

import { useCallback, useEffect, useMemo, useState } from 'react';
import Modal from '@/components/Modal';
import { createClient } from '@/lib/supabase/client';
import { finErrorMessage } from '@/lib/finanzas/errors';
import { formatDate, caracasToday } from '@/lib/finanzas/dates';
import { fmtUSD, round2, PAYMENT_TERMS_LABEL } from '@/lib/finanzas/money';
import { fetchAllPages } from '@/lib/finanzas/queries';
import { downloadFinWorkbook, FMT_USD } from '@/lib/finanzas/excel';
import type { Supplier } from './SupplierFormModal';
import type { Expense } from './ExpenseFormModal';
import { PaymentStatusBadge, DueBadge, btnPrimary, btnSecondary, EmptyState } from './ui';

export default function SupplierStatementModal({
  isOpen,
  onClose,
  supplier,
}: {
  isOpen: boolean;
  onClose: () => void;
  supplier: Supplier | null;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    if (!supplier) return;
    setLoading(true);
    setError(null);
    const { rows: data, error: err } = await fetchAllPages<Expense>((from, to) =>
      supabase
        .from('fin_expenses')
        .select(
          'id, kind, supplier_id, category_id, shipment_id, description, currency, amount, bcv_rate, amount_usd, expense_date, due_date, paid_usd, status, is_personal, receipt_path, notes, created_at',
        )
        .eq('supplier_id', supplier.id)
        .eq('is_personal', false)
        .order('expense_date', { ascending: false })
        .range(from, to),
    );
    if (err) setError(finErrorMessage(err));
    setRows(data);
    setLoading(false);
  }, [supplier, supabase]);

  useEffect(() => {
    if (!isOpen || !supplier) return;
    load();
  }, [isOpen, supplier, load]);

  const saldoDe = (e: Expense) => round2(Number(e.amount_usd) - Number(e.paid_usd));

  const resumen = useMemo(() => {
    const abiertas = rows.filter((e) => e.status !== 'pagada');
    const hoy = caracasToday();
    const vencidas = abiertas.filter((e) => e.due_date && e.due_date < hoy);
    const proximos = abiertas
      .filter((e) => e.due_date)
      .map((e) => e.due_date as string)
      .sort();
    return {
      comprado: rows.reduce((a, e) => a + Number(e.amount_usd), 0),
      saldo: abiertas.reduce((a, e) => a + saldoDe(e), 0),
      abiertas: abiertas.length,
      vencido: vencidas.reduce((a, e) => a + saldoDe(e), 0),
      proximo: proximos[0] ?? null,
    };
  }, [rows]);

  // Lo abierto arriba: es lo que se viene a consultar.
  const ordenadas = useMemo(
    () =>
      [...rows].sort((a, b) => {
        const aOpen = a.status !== 'pagada' ? 0 : 1;
        const bOpen = b.status !== 'pagada' ? 0 : 1;
        if (aOpen !== bOpen) return aOpen - bOpen;
        return b.expense_date.localeCompare(a.expense_date);
      }),
    [rows],
  );

  const handleExport = async () => {
    if (!supplier || exporting) return;
    setExporting(true);
    try {
      await downloadFinWorkbook({
        filename: `estado_cuenta_${supplier.name.replace(/\s+/g, '_').toLowerCase()}.xlsx`,
        cover: {
          title: `Estado de cuenta — ${supplier.name}`,
          extra: [
            ['Condiciones de pago', PAYMENT_TERMS_LABEL[supplier.payment_terms] ?? supplier.payment_terms],
            ['Total comprado', fmtUSD(resumen.comprado)],
            ['Saldo pendiente', fmtUSD(resumen.saldo)],
            ['Facturas abiertas', String(resumen.abiertas)],
            ['Vencido', fmtUSD(resumen.vencido)],
          ],
        },
        sheets: [
          {
            name: 'Estado de cuenta',
            columns: [
              { header: 'Fecha', key: 'fecha', width: 13 },
              { header: 'Concepto', key: 'concepto', width: 32, wrap: true },
              { header: 'Moneda', key: 'moneda', width: 14 },
              { header: 'Total USD', key: 'total', width: 14, numFmt: FMT_USD },
              { header: 'Abonado', key: 'abonado', width: 14, numFmt: FMT_USD },
              { header: 'Saldo', key: 'saldo', width: 14, numFmt: FMT_USD },
              { header: 'Estado', key: 'estado', width: 12 },
              { header: 'Vence', key: 'vence', width: 13 },
            ],
            rows: ordenadas.map((e) => ({
              fecha: formatDate(e.expense_date),
              concepto: e.description ?? '',
              moneda: e.currency === 'VES' ? `Bs @ ${e.bcv_rate}` : 'USD',
              total: Number(e.amount_usd),
              abonado: Number(e.paid_usd),
              saldo: saldoDe(e),
              estado:
                { pagada: 'Pagada', parcial: 'Parcial', pendiente: 'Pendiente' }[e.status] ?? e.status,
              vence: formatDate(e.due_date),
            })),
            totals: {
              total: resumen.comprado,
              abonado: rows.reduce((a, e) => a + Number(e.paid_usd), 0),
              saldo: resumen.saldo,
            },
            totalsLabel: 'TOTALES',
          },
        ],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al exportar.');
    } finally {
      setExporting(false);
    }
  };

  if (!supplier) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Estado de cuenta — ${supplier.name}`}>
      <div className="space-y-5">
        {error && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-slate-50 border border-slate-200 rounded-lg p-4">
          <div>
            <p className="text-[11px] uppercase tracking-widest text-slate-400 font-bold">Le debes</p>
            <p className={`text-lg font-bold ${resumen.saldo > 0 ? 'text-red-600' : 'text-slate-400'}`}>
              {fmtUSD(resumen.saldo)}
            </p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-widest text-slate-400 font-bold">Facturas abiertas</p>
            <p className="text-lg font-bold text-slate-800">{resumen.abiertas}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-widest text-slate-400 font-bold">Vencido</p>
            <p className={`text-lg font-bold ${resumen.vencido > 0 ? 'text-red-600' : 'text-slate-400'}`}>
              {fmtUSD(resumen.vencido)}
            </p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-widest text-slate-400 font-bold">Total comprado</p>
            <p className="text-lg font-bold text-slate-800">{fmtUSD(resumen.comprado)}</p>
          </div>
        </div>

        <p className="text-xs text-slate-500">
          Condiciones: <strong>{PAYMENT_TERMS_LABEL[supplier.payment_terms] ?? supplier.payment_terms}</strong>
          {resumen.proximo && <> · Próximo vencimiento: <strong>{formatDate(resumen.proximo)}</strong></>}
        </p>

        {loading ? (
          <p className="text-sm text-slate-400 py-8 text-center">Cargando movimientos…</p>
        ) : ordenadas.length === 0 ? (
          <EmptyState
            title="Todavía no hay compras a esta marca."
            hint="Regístralas desde la pestaña Compras."
          />
        ) : (
          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="w-full text-sm min-w-[640px]">
              <thead className="bg-slate-100 text-slate-600">
                <tr>
                  <th className="text-left font-semibold px-3 py-2">Fecha</th>
                  <th className="text-left font-semibold px-3 py-2">Concepto</th>
                  <th className="text-right font-semibold px-3 py-2">Total</th>
                  <th className="text-right font-semibold px-3 py-2">Saldo</th>
                  <th className="text-center font-semibold px-3 py-2">Estado</th>
                  <th className="text-center font-semibold px-3 py-2">Vence</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {ordenadas.map((e) => {
                  const saldo = saldoDe(e);
                  return (
                    <tr key={e.id} className={`hover:bg-slate-50 ${e.status === 'pagada' ? 'opacity-60' : ''}`}>
                      <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{formatDate(e.expense_date)}</td>
                      <td className="px-3 py-2 text-slate-800">{e.description || '—'}</td>
                      <td className="px-3 py-2 text-right font-semibold text-slate-800">
                        {fmtUSD(e.amount_usd)}
                      </td>
                      <td className={`px-3 py-2 text-right font-semibold ${saldo > 0 ? 'text-red-600' : 'text-slate-300'}`}>
                        {saldo > 0 ? fmtUSD(saldo) : '—'}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <PaymentStatusBadge status={e.status} />
                      </td>
                      <td className="px-3 py-2 text-center">
                        {e.status === 'pagada' ? <span className="text-slate-300">—</span> : <DueBadge dueDate={e.due_date} />}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button onClick={handleExport} disabled={exporting || rows.length === 0} className={btnSecondary}>
            {exporting ? 'Exportando…' : '📥 Exportar a .xlsx'}
          </button>
          <button onClick={onClose} className={btnPrimary}>
            Cerrar
          </button>
        </div>
      </div>
    </Modal>
  );
}
