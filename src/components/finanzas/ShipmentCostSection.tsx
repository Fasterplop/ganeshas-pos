'use client';

// Costo de envío de una caja (flete, aduana, courier).
//
// POR QUÉ NO ES UNA COLUMNA DE fin_shipments: el flete es dinero que sale, y el
// dinero del módulo tiene UN solo camino, `fin_expenses`. Guardarlo en la caja
// abriría un segundo camino que no entra al gasto del mes ni al calendario. Aquí
// es un egreso con kind='envio' y shipment_id
// apuntando a la caja: el "costo real por caja" es la suma de sus fletes.
//
// Una caja puede tener más de uno (el courier y después la aduana), por eso es
// una lista y no un campo.
//
// El flete NO descuenta del saldo de la cuenta con que se pagó: la cuenta queda
// anotada como información. Ningún pago mueve saldos; el saldo de las cuentas
// se lleva a mano (db/finanzas_06_saldo_manual.sql).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { usePOSStore } from '@/store/usePOSStore';
import { finErrorMessage } from '@/lib/finanzas/errors';
import { caracasToday, formatDate } from '@/lib/finanzas/dates';
import { fmtUSD, toUSD, accountLabel, type Currency } from '@/lib/finanzas/money';
import { fetchAllPages } from '@/lib/finanzas/queries';
import type { Account } from './AccountFormModal';
import type { Shipment } from './ShipmentFormModal';
import { FinField, inputClass, btnPrimary, btnSecondary, PaymentStatusBadge } from './ui';

interface CostRow {
  id: string;
  description: string | null;
  currency: string;
  amount: number;
  bcv_rate: number | null;
  amount_usd: number;
  expense_date: string;
  due_date: string | null;
  status: string;
  paid_usd: number;
}

export default function ShipmentCostSection({
  shipment,
  accounts,
  envioCategoryId,
  onTotalChange,
}: {
  shipment: Shipment;
  accounts: Account[];
  envioCategoryId: string | null;
  onTotalChange?: (total: number) => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const { bcvRate } = usePOSStore();

  const [costs, setCosts] = useState<CostRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [desc, setDesc] = useState('Flete');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<Currency>('USD');
  const [rate, setRate] = useState('');
  const [date, setDate] = useState(caracasToday());
  const [paid, setPaid] = useState(true);
  const [accountId, setAccountId] = useState('');
  const [dueDate, setDueDate] = useState('');

  const usable = accounts.filter((a) => a.is_active && !a.is_personal);

  const load = useCallback(async () => {
    setLoading(true);
    const { rows, error: err } = await fetchAllPages<CostRow>((from, to) =>
      supabase
        .from('fin_expenses')
        .select('id, description, currency, amount, bcv_rate, amount_usd, expense_date, due_date, status, paid_usd')
        .eq('shipment_id', shipment.id)
        .eq('kind', 'envio')
        .order('expense_date')
        .range(from, to),
    );
    if (err) setError(finErrorMessage(err));
    setCosts(rows);
    setLoading(false);
  }, [supabase, shipment.id]);

  useEffect(() => {
    load();
  }, [load]);

  const total = costs.reduce((acc, c) => acc + Number(c.amount_usd), 0);

  useEffect(() => {
    onTotalChange?.(total);
  }, [total, onTotalChange]);

  const resetForm = () => {
    setDesc('Flete');
    setAmount('');
    setCurrency('USD');
    setRate('');
    setDate(caracasToday());
    setPaid(true);
    setAccountId('');
    setDueDate('');
  };

  const save = async () => {
    setError(null);
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setError('Escribe cuánto costó el envío.');
      return;
    }

    // Sin tasa, un monto en bolívares queda imposible de auditar meses después.
    // El CHECK de la tabla es la segunda barrera; esta es la primera.
    const effectiveRate = currency === 'VES' ? Number(rate || bcvRate) : null;
    if (currency === 'VES' && (!effectiveRate || effectiveRate <= 0)) {
      setError('Para un monto en bolívares hace falta la tasa del día de la compra.');
      return;
    }

    const usd = toUSD(value, currency, effectiveRate);
    if (usd === null) {
      setError('No se pudo calcular el equivalente en dólares.');
      return;
    }
    if (paid && !accountId) {
      setError('Elige con qué cuenta se pagó.');
      return;
    }

    setBusy(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setBusy(false);
      setError('Sesión expirada. Vuelve a iniciar sesión.');
      return;
    }

    const { data: expense, error: expError } = await supabase
      .from('fin_expenses')
      .insert({
        kind: 'envio',
        shipment_id: shipment.id,
        category_id: envioCategoryId,
        description: desc.trim() || 'Flete',
        currency,
        amount: value,
        bcv_rate: effectiveRate,
        amount_usd: usd,
        expense_date: date || caracasToday(),
        due_date: paid ? null : dueDate || null,
        created_by: user.id,
      })
      .select()
      .single();

    if (expError) {
      setBusy(false);
      setError(finErrorMessage(expError));
      return;
    }

    // El pago es lo que de verdad mueve el dinero: baja el saldo de la cuenta y
    // el trigger deja la compra en 'pagada'.
    if (paid) {
      const { error: payError } = await supabase.from('fin_payments').insert({
        expense_id: expense.id,
        account_id: accountId,
        currency,
        amount: value,
        bcv_rate: effectiveRate,
        amount_usd: usd,
        paid_at: date || caracasToday(),
        created_by: user.id,
      });
      if (payError) {
        setBusy(false);
        setError(`El costo se guardó, pero el pago no: ${finErrorMessage(payError)}`);
        await load();
        return;
      }
    }

    setBusy(false);
    setAdding(false);
    resetForm();
    await load();
  };

  const remove = async (cost: CostRow) => {
    if (!window.confirm('¿Eliminar este costo de envío? También se borra su pago.')) return;
    const { error: err } = await supabase.from('fin_expenses').delete().eq('id', cost.id);
    if (err) {
      setError(finErrorMessage(err));
      return;
    }
    await load();
  };

  return (
    <div className="border-t border-slate-200 pt-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-bold text-slate-800">Costo del envío</h3>
        <span className="text-xs text-slate-400">
          {total > 0 ? `${fmtUSD(total)} en total` : 'Sin costos registrados'}
        </span>
      </div>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-slate-400 py-3">Cargando…</p>
      ) : (
        costs.length > 0 && (
          <div className="overflow-x-auto border border-slate-200 rounded-lg mb-3">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 text-slate-600">
                <tr>
                  <th className="text-left font-semibold px-2 sm:px-3 py-2">Concepto</th>
                  <th className="text-left font-semibold px-3 py-2 hidden sm:table-cell">Fecha</th>
                  <th className="text-right font-semibold px-3 py-2">Monto</th>
                  <th className="text-center font-semibold px-3 py-2">Estado</th>
                  <th className="px-3 py-2 w-10" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {costs.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50">
                    <td className="px-2 sm:px-3 py-2 text-slate-800">
                      {c.description}
                      <div className="sm:hidden text-xs text-slate-400">
                        {formatDate(c.expense_date)}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-slate-600 hidden sm:table-cell">
                      {formatDate(c.expense_date)}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold text-slate-800">
                      {fmtUSD(c.amount_usd)}
                      {c.currency === 'VES' && (
                        <div className="text-[10px] text-slate-400 font-normal">
                          {Number(c.amount).toLocaleString('es-VE')} Bs @ {c.bcv_rate}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <PaymentStatusBadge status={c.status} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => remove(c)}
                        className="text-slate-400 hover:text-red-600 cursor-pointer"
                        title="Eliminar costo"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {!adding ? (
        <button onClick={() => setAdding(true)} className={btnSecondary} disabled={usable.length === 0}>
          + Agregar costo de envío
        </button>
      ) : (
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FinField label="Concepto">
              <input value={desc} onChange={(e) => setDesc(e.target.value)} className={inputClass} />
            </FinField>
            <FinField label="Fecha">
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputClass} />
            </FinField>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <FinField label="Monto" required>
              <input
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className={inputClass}
                placeholder="85.00"
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
            {currency === 'VES' && (
              <FinField label="Tasa BCV" required hint="La del día de la compra.">
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                  className={inputClass}
                />
              </FinField>
            )}
          </div>

          {currency === 'VES' && Number(amount) > 0 && Number(rate || bcvRate) > 0 && (
            <p className="text-xs text-slate-500">
              Equivale a <strong>{fmtUSD(Number(amount) / Number(rate || bcvRate))}</strong>. Ese es el
              valor que queda congelado en los reportes.
            </p>
          )}

          <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={paid}
              onChange={(e) => setPaid(e.target.checked)}
              className="rounded border-slate-300"
            />
            Ya está pagado
          </label>

          {paid ? (
            <FinField
              label="Con qué cuenta se pagó"
              required
              hint="Solo para tenerlo anotado: un flete no descuenta del saldo de la cuenta."
            >
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={inputClass}>
                <option value="">Selecciona…</option>
                {usable.map((a) => (
                  <option key={a.id} value={a.id}>
                    {accountLabel(a)}
                  </option>
                ))}
              </select>
            </FinField>
          ) : (
            <FinField label="Vence el" hint="Entra solo al calendario de pagos.">
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className={inputClass}
              />
            </FinField>
          )}

          <div className="flex justify-end gap-2">
            <button
              onClick={() => {
                setAdding(false);
                resetForm();
                setError(null);
              }}
              className={btnSecondary}
              disabled={busy}
            >
              Cancelar
            </button>
            <button onClick={save} className={btnPrimary} disabled={busy}>
              {busy ? 'Guardando…' : 'Guardar costo'}
            </button>
          </div>
        </div>
      )}

      {usable.length === 0 && !adding && (
        <p className="text-xs text-slate-400 mt-2">
          Para registrar el flete hace falta al menos una cuenta activa del negocio. Créala en la
          pestaña Cuentas.
        </p>
      )}
    </div>
  );
}
