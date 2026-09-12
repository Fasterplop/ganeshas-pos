'use client';

// Abonos de una compra.
//
// Aquí se resuelven dos cosas de la propuesta con el mismo mecanismo:
//   - ABONO PARCIAL: un pago que no cubre el total. El estado queda "parcial"
//     con el saldo restante visible.
//   - PAGO MIXTO: dos pagos del mismo día con cuentas distintas (efectivo +
//     tarjeta), igual que el punto de venta divide un cobro.
// No hay dos flujos: son filas de fin_payments. El estado y el saldo los
// recalcula un trigger, así que no pueden quedar desfasados.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Modal from '@/components/Modal';
import { createClient } from '@/lib/supabase/client';
import { usePOSStore } from '@/store/usePOSStore';
import { finErrorMessage } from '@/lib/finanzas/errors';
import { caracasToday, formatDate } from '@/lib/finanzas/dates';
import { fmtUSD, toUSD, accountLabel, round2, type Currency } from '@/lib/finanzas/money';
import { fetchAllPages } from '@/lib/finanzas/queries';
import type { Account } from './AccountFormModal';
import type { Expense } from './ExpenseFormModal';
import {
  FinField,
  inputClass,
  btnPrimary,
  btnSecondary,
  PaymentStatusBadge,
  FinNotice,
  Notice,
} from './ui';

interface Payment {
  id: string;
  account_id: string;
  currency: string;
  amount: number;
  bcv_rate: number | null;
  amount_usd: number;
  paid_at: string;
  reference: string | null;
}

export default function ExpensePaymentsModal({
  isOpen,
  onClose,
  expense,
  accounts,
  supplierName,
  onChanged,
}: {
  isOpen: boolean;
  onClose: () => void;
  expense: Expense | null;
  accounts: Account[];
  supplierName?: string | null;
  onChanged: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const { bcvRate } = usePOSStore();

  const [payments, setPayments] = useState<Payment[]>([]);
  const [current, setCurrent] = useState<Expense | null>(expense);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const [accountId, setAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<Currency>('USD');
  const [rate, setRate] = useState('');
  const [paidAt, setPaidAt] = useState(caracasToday());
  const [reference, setReference] = useState('');

  const usable = accounts.filter((a) => a.is_active && a.is_personal === (current?.is_personal ?? false));

  const saldo = current ? round2(Number(current.amount_usd) - Number(current.paid_usd)) : 0;

  const load = useCallback(async () => {
    if (!expense) return;
    setLoading(true);

    const { rows, error } = await fetchAllPages<Payment>((from, to) =>
      supabase
        .from('fin_payments')
        .select('id, account_id, currency, amount, bcv_rate, amount_usd, paid_at, reference')
        .eq('expense_id', expense.id)
        .order('paid_at')
        .range(from, to),
    );
    if (error) setNotice({ type: 'error', text: finErrorMessage(error) });
    setPayments(rows);

    // El estado y lo pagado los mantiene el trigger: se releen de la BD en vez
    // de recalcularlos aquí, para que no puedan discrepar.
    const { data: fresh } = await supabase
      .from('fin_expenses')
      .select('*')
      .eq('id', expense.id)
      .single();
    if (fresh) setCurrent(fresh as Expense);

    setLoading(false);
  }, [expense, supabase]);

  useEffect(() => {
    if (!isOpen || !expense) return;
    setCurrent(expense);
    setNotice(null);
    setAmount('');
    setReference('');
    setCurrency((expense.currency as Currency) ?? 'USD');
    setRate(expense.bcv_rate != null ? String(expense.bcv_rate) : '');
    setPaidAt(caracasToday());
    load();
  }, [isOpen, expense, load]);

  // El saldo restante es el abono que se quiere hacer casi siempre.
  useEffect(() => {
    if (!isOpen || !current || loading) return;
    if (currency === 'USD') setAmount(saldo > 0 ? String(saldo) : '');
  }, [isOpen, current, loading, saldo, currency]);

  const addPayment = async () => {
    if (!current) return;
    setNotice(null);

    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setNotice({ type: 'error', text: 'Escribe cuánto estás abonando.' });
      return;
    }
    if (!accountId) {
      setNotice({ type: 'error', text: 'Elige con qué cuenta pagaste.' });
      return;
    }
    const effRate = currency === 'VES' ? Number(rate || bcvRate) || 0 : 0;
    if (currency === 'VES' && effRate <= 0) {
      setNotice({ type: 'error', text: 'Para un abono en bolívares hace falta la tasa del día.' });
      return;
    }
    const usd = toUSD(value, currency, effRate);
    if (usd === null) {
      setNotice({ type: 'error', text: 'No se pudo calcular el equivalente en dólares.' });
      return;
    }
    // Se avisa, no se bloquea: a veces se paga de más y queda saldo a favor
    // que se arregla editando el monto de la compra.
    if (usd > saldo + 0.005) {
      const ok = window.confirm(
        `Estás abonando ${fmtUSD(usd)} cuando el saldo es ${fmtUSD(saldo)}.\n\n¿Registrarlo igual?`,
      );
      if (!ok) return;
    }

    setBusy(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { error } = await supabase.from('fin_payments').insert({
      expense_id: current.id,
      account_id: accountId,
      currency,
      amount: value,
      bcv_rate: currency === 'VES' ? effRate : null,
      amount_usd: usd,
      paid_at: paidAt || caracasToday(),
      reference: reference.trim() || null,
      created_by: user?.id,
    });
    setBusy(false);

    if (error) {
      setNotice({ type: 'error', text: finErrorMessage(error) });
      return;
    }
    setAmount('');
    setReference('');
    await load();
    onChanged();
  };

  const removePayment = async (p: Payment) => {
    if (!window.confirm(`¿Eliminar el abono de ${fmtUSD(p.amount_usd)}?`)) return;
    const { error } = await supabase.from('fin_payments').delete().eq('id', p.id);
    if (error) {
      setNotice({ type: 'error', text: finErrorMessage(error) });
      return;
    }
    await load();
    onChanged();
  };

  if (!current) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Abonos — ${supplierName || current.description || 'Compra'}`}
    >
      <div className="space-y-5">
        <FinNotice notice={notice} onClose={() => setNotice(null)} />

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-slate-50 border border-slate-200 rounded-lg p-4">
          <div>
            <p className="text-[11px] uppercase tracking-widest text-slate-400 font-bold">Total</p>
            <p className="text-lg font-bold text-slate-800">{fmtUSD(current.amount_usd)}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-widest text-slate-400 font-bold">Abonado</p>
            <p className="text-lg font-bold text-emerald-700">{fmtUSD(current.paid_usd)}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-widest text-slate-400 font-bold">Saldo</p>
            <p className={`text-lg font-bold ${saldo > 0 ? 'text-red-600' : 'text-slate-400'}`}>
              {fmtUSD(saldo)}
            </p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-widest text-slate-400 font-bold mb-1">Estado</p>
            <PaymentStatusBadge status={current.status} />
          </div>
        </div>

        {loading ? (
          <p className="text-sm text-slate-400 py-4 text-center">Cargando abonos…</p>
        ) : payments.length === 0 ? (
          <p className="text-sm text-slate-500 py-2">Todavía no hay abonos registrados.</p>
        ) : (
          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 text-slate-600">
                <tr>
                  <th className="text-left font-semibold px-2 sm:px-3 py-2 hidden sm:table-cell">
                    Fecha
                  </th>
                  <th className="text-left font-semibold px-2 sm:px-3 py-2">Cuenta</th>
                  <th className="text-left font-semibold px-3 py-2 hidden md:table-cell">
                    Referencia
                  </th>
                  <th className="text-right font-semibold px-3 py-2">Monto</th>
                  <th className="px-3 py-2 w-10" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {payments.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50">
                    <td className="px-2 sm:px-3 py-2 text-slate-600 hidden sm:table-cell">
                      {formatDate(p.paid_at)}
                    </td>
                    <td className="px-2 sm:px-3 py-2 text-slate-800">
                      {accountLabel(accounts.find((a) => a.id === p.account_id))}
                      <div className="sm:hidden text-xs text-slate-400">{formatDate(p.paid_at)}</div>
                    </td>
                    <td className="px-3 py-2 text-slate-500 hidden md:table-cell">
                      {p.reference || '—'}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold text-slate-800">
                      {fmtUSD(p.amount_usd)}
                      {p.currency === 'VES' && (
                        <div className="text-[10px] text-slate-400 font-normal">
                          {Number(p.amount).toLocaleString('es-VE')} Bs @ {p.bcv_rate}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => removePayment(p)}
                        className="text-slate-400 hover:text-red-600 cursor-pointer"
                        title="Eliminar abono"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="border-t border-slate-200 pt-4 space-y-3">
          <h4 className="font-bold text-slate-800 text-sm">Registrar un abono</h4>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <FinField label="Monto" required>
              <input
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className={inputClass}
              />
            </FinField>
            <FinField label="Moneda">
              <select
                value={currency}
                onChange={(e) => {
                  const c = e.target.value as Currency;
                  setCurrency(c);
                  if (c === 'VES' && !rate && bcvRate > 0) setRate(String(bcvRate));
                }}
                className={inputClass}
              >
                <option value="USD">Dólares</option>
                <option value="VES">Bolívares</option>
              </select>
            </FinField>
            {currency === 'VES' ? (
              <FinField label="Tasa BCV" required>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                  className={inputClass}
                />
              </FinField>
            ) : (
              <FinField label="Fecha">
                <input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} className={inputClass} />
              </FinField>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <FinField label="Cuenta" required className="sm:col-span-2">
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={inputClass}>
                <option value="">Selecciona…</option>
                {usable.map((a) => (
                  <option key={a.id} value={a.id}>
                    {accountLabel(a)}
                  </option>
                ))}
              </select>
            </FinField>
            {currency === 'VES' ? (
              <FinField label="Fecha">
                <input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} className={inputClass} />
              </FinField>
            ) : (
              <FinField label="Referencia">
                <input value={reference} onChange={(e) => setReference(e.target.value)} className={inputClass} />
              </FinField>
            )}
          </div>

          <p className="text-xs text-slate-500">
            Para un <strong>pago mixto</strong> (efectivo + tarjeta), registra un abono por cada
            cuenta con la misma fecha.
          </p>

          <div className="flex justify-end gap-2">
            <button onClick={onClose} className={btnSecondary} disabled={busy}>
              Cerrar
            </button>
            <button onClick={addPayment} className={btnPrimary} disabled={busy}>
              {busy ? 'Guardando…' : 'Registrar abono'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
