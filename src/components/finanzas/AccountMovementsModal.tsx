'use client';

// Abonos y cargos manuales sobre una cuenta o tarjeta.
//
// Antes, la única forma de bajar la deuda de una tarjeta era editar su saldo
// inicial, y eso borraba el historial: quedaba un número sin explicación. Aquí
// cada movimiento tiene su fecha y su nota, y el saldo se sigue derivando.
//
// El tipo se lee siempre igual — "le meto dinero" o "le saco dinero" — pero el
// efecto depende de qué es la cuenta: en una tarjeta el saldo es la DEUDA, así
// que un abono la baja; en un banco es lo disponible, así que lo sube. Las
// etiquetas cambian para que no haya que pensarlo.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Modal from '@/components/Modal';
import { createClient } from '@/lib/supabase/client';
import { finErrorMessage } from '@/lib/finanzas/errors';
import { caracasToday, formatDate } from '@/lib/finanzas/dates';
import { fmtUSD, accountLabel } from '@/lib/finanzas/money';
import { fetchAllPages } from '@/lib/finanzas/queries';
import type { Account } from './AccountFormModal';
import { FinField, FinNotice, Notice, inputClass, btnPrimary, btnSecondary } from './ui';

export interface AccountMovement {
  id: string;
  account_id: string;
  kind: 'abono' | 'cargo';
  amount_usd: number;
  moved_at: string;
  note: string | null;
}

export default function AccountMovementsModal({
  isOpen,
  onClose,
  account,
  balance,
  onChanged,
}: {
  isOpen: boolean;
  onClose: () => void;
  account: Account | null;
  /** Saldo actual según la vista, para verlo cambiar al registrar. */
  balance: number;
  onChanged: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);

  const [movements, setMovements] = useState<AccountMovement[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const [kind, setKind] = useState<'abono' | 'cargo'>('abono');
  const [amount, setAmount] = useState('');
  const [movedAt, setMovedAt] = useState(caracasToday());
  const [note, setNote] = useState('');

  const isCard = account?.kind === 'tarjeta_credito';

  const load = useCallback(async () => {
    if (!account) return;
    setLoading(true);
    const { rows, error } = await fetchAllPages<AccountMovement>((from, to) =>
      supabase
        .from('fin_account_movements')
        .select('id, account_id, kind, amount_usd, moved_at, note')
        .eq('account_id', account.id)
        .order('moved_at', { ascending: false })
        .range(from, to),
    );
    if (error) setNotice({ type: 'error', text: finErrorMessage(error) });
    setMovements(rows);
    setLoading(false);
  }, [account, supabase]);

  useEffect(() => {
    if (!isOpen || !account) return;
    setNotice(null);
    setKind('abono');
    setAmount('');
    setNote('');
    setMovedAt(caracasToday());
    load();
  }, [isOpen, account, load]);

  const save = async () => {
    if (!account) return;
    setNotice(null);

    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setNotice({ type: 'error', text: 'Escribe el monto.' });
      return;
    }

    setBusy(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { error } = await supabase.from('fin_account_movements').insert({
      account_id: account.id,
      kind,
      amount_usd: value,
      moved_at: movedAt || caracasToday(),
      note: note.trim() || null,
      created_by: user?.id,
    });
    setBusy(false);

    if (error) {
      setNotice({ type: 'error', text: finErrorMessage(error) });
      return;
    }
    setAmount('');
    setNote('');
    await load();
    onChanged();
    setNotice({
      type: 'success',
      text: isCard
        ? kind === 'abono'
          ? `Abono de ${fmtUSD(value)} registrado. La deuda baja.`
          : `Cargo de ${fmtUSD(value)} registrado. La deuda sube.`
        : kind === 'abono'
          ? `Ingreso de ${fmtUSD(value)} registrado.`
          : `Salida de ${fmtUSD(value)} registrada.`,
    });
  };

  const remove = async (m: AccountMovement) => {
    if (!window.confirm(`¿Eliminar este movimiento de ${fmtUSD(m.amount_usd)}?`)) return;
    const { error } = await supabase.from('fin_account_movements').delete().eq('id', m.id);
    if (error) {
      setNotice({ type: 'error', text: finErrorMessage(error) });
      return;
    }
    await load();
    onChanged();
  };

  if (!account) return null;

  const etiqueta = (k: 'abono' | 'cargo') =>
    isCard
      ? k === 'abono'
        ? 'Abono (baja la deuda)'
        : 'Cargo (sube la deuda)'
      : k === 'abono'
        ? 'Entra dinero'
        : 'Sale dinero';

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Movimientos — ${accountLabel(account)}`}>
      <div className="space-y-5">
        <FinNotice notice={notice} onClose={() => setNotice(null)} />

        <div className="bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-2">
          <div>
            <p className="text-[11px] uppercase tracking-widest text-slate-400 font-bold">
              {isCard ? 'Deuda actual' : 'Saldo actual'}
            </p>
            <p className={`text-xl font-bold ${isCard ? 'text-amber-700' : 'text-emerald-700'}`}>
              {fmtUSD(balance)}
            </p>
          </div>
          {isCard && account.credit_limit_usd != null && (
            <div>
              <p className="text-[11px] uppercase tracking-widest text-slate-400 font-bold">
                Disponible
              </p>
              <p className="text-xl font-bold text-slate-800">
                {fmtUSD(Number(account.credit_limit_usd) - balance)}
              </p>
            </div>
          )}
        </div>

        {/* --- Registrar --- */}
        <div className="border border-slate-200 rounded-lg p-3 sm:p-4 space-y-3">
          <h4 className="font-bold text-slate-800 text-sm">
            {isCard ? 'Abonar a la tarjeta' : 'Registrar movimiento'}
          </h4>

          <div className="flex flex-wrap gap-2">
            {(['abono', 'cargo'] as const).map((k) => (
              <button
                key={k}
                onClick={() => setKind(k)}
                className={`text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors cursor-pointer ${
                  kind === k
                    ? 'bg-teal-700 text-white border-teal-700'
                    : 'bg-white text-slate-600 border-slate-200 hover:border-teal-400'
                }`}
              >
                {etiqueta(k)}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <FinField label="Monto (USD)" required>
              <input
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className={inputClass}
                placeholder="150.00"
              />
            </FinField>
            <FinField label="Fecha">
              <input
                type="date"
                value={movedAt}
                onChange={(e) => setMovedAt(e.target.value)}
                className={inputClass}
              />
            </FinField>
            <FinField label="Nota">
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className={inputClass}
                placeholder="Pago del corte de septiembre"
              />
            </FinField>
          </div>

          <div className="flex justify-end">
            <button onClick={save} disabled={busy} className={btnPrimary}>
              {busy ? 'Guardando…' : 'Registrar'}
            </button>
          </div>
        </div>

        {/* --- Historial --- */}
        <div>
          <h4 className="font-bold text-slate-800 text-sm mb-2">Historial</h4>
          {loading ? (
            <p className="text-sm text-slate-400 py-4 text-center">Cargando…</p>
          ) : movements.length === 0 ? (
            <p className="text-sm text-slate-500 py-2">
              Todavía no hay movimientos manuales en esta cuenta.
            </p>
          ) : (
            <div className="overflow-x-auto border border-slate-200 rounded-lg">
              <table className="w-full text-sm">
                <thead className="bg-slate-100 text-slate-600">
                  <tr>
                    <th className="text-left font-semibold px-2 sm:px-3 py-2">Fecha</th>
                    <th className="text-left font-semibold px-3 py-2">Tipo</th>
                    <th className="text-left font-semibold px-3 py-2 hidden sm:table-cell">Nota</th>
                    <th className="text-right font-semibold px-2 sm:px-3 py-2">Monto</th>
                    <th className="px-2 py-2 w-8" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {movements.map((m) => (
                    <tr key={m.id} className="hover:bg-slate-50">
                      <td className="px-2 sm:px-3 py-2 text-slate-600 whitespace-nowrap">
                        {formatDate(m.moved_at)}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${
                            m.kind === 'abono'
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                              : 'bg-amber-50 text-amber-800 border-amber-300'
                          }`}
                        >
                          {m.kind === 'abono' ? 'Abono' : 'Cargo'}
                        </span>
                        {m.note && <div className="sm:hidden text-xs text-slate-400 mt-0.5">{m.note}</div>}
                      </td>
                      <td className="px-3 py-2 text-slate-500 hidden sm:table-cell">{m.note || '—'}</td>
                      <td
                        className={`px-2 sm:px-3 py-2 text-right font-semibold whitespace-nowrap ${
                          m.kind === 'abono' ? 'text-emerald-700' : 'text-amber-700'
                        }`}
                      >
                        {m.kind === 'abono' ? '−' : '+'}
                        {fmtUSD(m.amount_usd)}
                      </td>
                      <td className="px-2 py-2 text-right">
                        <button
                          onClick={() => remove(m)}
                          className="text-slate-400 hover:text-red-600 cursor-pointer"
                          title="Eliminar movimiento"
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
          <p className="text-xs text-slate-400 mt-2">
            El signo es sobre {isCard ? 'la deuda' : 'el saldo'}: un abono{' '}
            {isCard ? 'la baja' : 'lo sube'}.
          </p>
        </div>

        <div className="flex justify-end">
          <button onClick={onClose} className={btnSecondary}>
            Cerrar
          </button>
        </div>
      </div>
    </Modal>
  );
}
