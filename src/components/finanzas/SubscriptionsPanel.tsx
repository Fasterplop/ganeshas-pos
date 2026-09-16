'use client';

// Suscripciones recurrentes: YouTube, Spotify, herramientas.
//
// NO generan el gasto del mes solas. Son un recordatorio con monto que se
// marca en el calendario en su día de corte, igual que el día de pago de una
// tarjeta. Si un mes se quiere contar de verdad, se registra el gasto a mano.
//
// Se decidió así porque lo contrario deja gastos fantasma: un mes que no te
// cobran (la tarjeta rebotó, cancelaste a mitad) quedaría contado igual, y un
// número inventado es peor que no tener el número.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { finErrorMessage } from '@/lib/finanzas/errors';
import { fetchAllPages } from '@/lib/finanzas/queries';
import { fmtUSD, accountLabel } from '@/lib/finanzas/money';
import { caracasToday } from '@/lib/finanzas/dates';
import type { Account } from './AccountFormModal';
import {
  FinNotice,
  Notice,
  EmptyState,
  inputClass,
  btnPrimary,
  btnSecondary,
  RowActions,
  MobileAmount,
} from './ui';

export interface Subscription {
  id: string;
  name: string;
  amount_usd: number;
  billing_day: number;
  account_id: string | null;
  category_id: string | null;
  is_personal: boolean;
  is_active: boolean;
  notes: string | null;
}

export const SUBSCRIPTION_SELECT =
  'id, name, amount_usd, billing_day, account_id, category_id, is_personal, is_active, notes';

/** Cuántos días faltan para el próximo corte, mirando desde hoy. */
export function daysToBilling(billingDay: number): number {
  const hoy = caracasToday();
  const diaHoy = Number(hoy.slice(8, 10));
  const y = Number(hoy.slice(0, 4));
  const m = Number(hoy.slice(5, 7));
  const ultimoDia = new Date(Date.UTC(y, m, 0)).getUTCDate();
  // Un corte el 31 en un mes de 30 cae el último día.
  const diaEsteMes = Math.min(billingDay, ultimoDia);
  if (diaEsteMes >= diaHoy) return diaEsteMes - diaHoy;
  const diasDelMes = ultimoDia;
  const sigUltimo = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return diasDelMes - diaHoy + Math.min(billingDay, sigUltimo);
}

export default function SubscriptionsPanel({
  accounts,
  categoryId,
  personal = false,
  onChanged,
}: {
  accounts: Account[];
  /** Categoría "Suscripciones", para dejarla puesta al registrar el gasto. */
  categoryId: string | null;
  personal?: boolean;
  onChanged?: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);

  const [subs, setSubs] = useState<Subscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Subscription | null>(null);

  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [billingDay, setBillingDay] = useState('1');
  const [accountId, setAccountId] = useState('');

  const usable = accounts.filter((a) => a.is_active && a.is_personal === personal);

  const load = useCallback(async () => {
    setLoading(true);
    const { rows, error } = await fetchAllPages<Subscription>((from, to) =>
      supabase
        .from('fin_subscriptions')
        .select(SUBSCRIPTION_SELECT)
        .eq('is_personal', personal)
        .order('billing_day')
        .range(from, to),
    );
    if (error) setNotice({ type: 'error', text: finErrorMessage(error) });
    setSubs(rows);
    setLoading(false);
  }, [supabase, personal]);

  useEffect(() => {
    load();
  }, [load]);

  const visibles = useMemo(
    () => subs.filter((s) => showInactive || s.is_active),
    [subs, showInactive],
  );

  const totalMes = useMemo(
    () => subs.filter((s) => s.is_active).reduce((a, s) => a + Number(s.amount_usd), 0),
    [subs],
  );

  const resetForm = () => {
    setName('');
    setAmount('');
    setBillingDay('1');
    setAccountId('');
    setEditing(null);
    setAdding(false);
  };

  const startEdit = (s: Subscription) => {
    setEditing(s);
    setAdding(true);
    setName(s.name);
    setAmount(String(s.amount_usd));
    setBillingDay(String(s.billing_day));
    setAccountId(s.account_id ?? '');
  };

  const save = async () => {
    setNotice(null);
    const nombre = name.trim();
    if (nombre.length < 2) {
      setNotice({ type: 'error', text: 'Escribe el nombre de la suscripción.' });
      return;
    }
    const monto = Number(amount);
    if (!Number.isFinite(monto) || monto <= 0) {
      setNotice({ type: 'error', text: 'Escribe cuánto cobran al mes.' });
      return;
    }
    const dia = Math.round(Number(billingDay));
    if (!Number.isFinite(dia) || dia < 1 || dia > 31) {
      setNotice({ type: 'error', text: 'El día de corte va del 1 al 31.' });
      return;
    }

    setBusy(true);
    const payload = {
      name: nombre,
      amount_usd: monto,
      billing_day: dia,
      account_id: accountId || null,
      category_id: categoryId,
      is_personal: personal,
    };

    if (editing) {
      const { error } = await supabase.from('fin_subscriptions').update(payload).eq('id', editing.id);
      setBusy(false);
      if (error) {
        setNotice({ type: 'error', text: finErrorMessage(error) });
        return;
      }
    } else {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const { error } = await supabase
        .from('fin_subscriptions')
        .insert({ ...payload, created_by: user?.id });
      setBusy(false);
      if (error) {
        setNotice({ type: 'error', text: finErrorMessage(error) });
        return;
      }
    }

    resetForm();
    await load();
    onChanged?.();
  };

  const toggle = async (s: Subscription) => {
    const next = !s.is_active;
    const { error } = await supabase
      .from('fin_subscriptions')
      .update({ is_active: next })
      .eq('id', s.id);
    if (error) {
      setNotice({ type: 'error', text: finErrorMessage(error) });
      return;
    }
    setSubs((p) => p.map((x) => (x.id === s.id ? { ...x, is_active: next } : x)));
    onChanged?.();
  };

  const remove = async (s: Subscription) => {
    if (!window.confirm(`¿Eliminar la suscripción "${s.name}"?`)) return;
    const { error } = await supabase.from('fin_subscriptions').delete().eq('id', s.id);
    if (error) {
      setNotice({ type: 'error', text: finErrorMessage(error) });
      return;
    }
    setSubs((p) => p.filter((x) => x.id !== s.id));
    onChanged?.();
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200">
      <div className="px-3 sm:px-4 py-3 border-b border-slate-100 flex flex-wrap items-center gap-3">
        <h3 className="font-bold text-slate-800 text-sm">Suscripciones</h3>
        <span className="text-xs text-slate-400">
          {totalMes > 0 ? `${fmtUSD(totalMes)} al mes` : 'Sin suscripciones activas'}
        </span>
        <div className="ml-auto flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-slate-500 cursor-pointer">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="rounded border-slate-300"
            />
            Ver canceladas
          </label>
          {!adding && (
            <button onClick={() => setAdding(true)} className={btnSecondary}>
              + Agregar
            </button>
          )}
        </div>
      </div>

      <div className="p-3 sm:p-4 space-y-3">
        <FinNotice notice={notice} onClose={() => setNotice(null)} />

        {adding && (
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,2fr)_100px_90px] gap-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="YouTube Premium"
                className={inputClass}
                autoFocus
              />
              <input
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="$ al mes"
                className={inputClass}
              />
              <input
                type="number"
                min="1"
                max="31"
                value={billingDay}
                onChange={(e) => setBillingDay(e.target.value)}
                placeholder="Día"
                className={`${inputClass} text-center`}
                title="Día de corte"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto_auto] gap-2">
              <select
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className={inputClass}
              >
                <option value="">Con qué se paga (opcional)</option>
                {usable.map((a) => (
                  <option key={a.id} value={a.id}>
                    {accountLabel(a)}
                  </option>
                ))}
              </select>
              <button onClick={resetForm} className={btnSecondary} disabled={busy}>
                Cancelar
              </button>
              <button onClick={save} className={btnPrimary} disabled={busy}>
                {busy ? 'Guardando…' : editing ? 'Guardar' : 'Agregar'}
              </button>
            </div>
            <p className="text-xs text-slate-400">
              El día de corte es el día del mes en que te cobran. Se marca solo en el calendario
              todos los meses.
            </p>
          </div>
        )}

        {loading ? (
          <p className="text-sm text-slate-400 py-6 text-center">Cargando suscripciones…</p>
        ) : visibles.length === 0 ? (
          <EmptyState
            title="Todavía no hay suscripciones."
            hint="YouTube, Spotify, el hosting, las herramientas que pagas todos los meses."
          />
        ) : (
          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 text-slate-600">
                <tr>
                  <th className="text-left font-semibold px-3 py-2">Suscripción</th>
                  <th className="text-center font-semibold px-2 py-2 hidden sm:table-cell">Corte</th>
                  <th className="text-left font-semibold px-3 py-2 hidden md:table-cell">Se paga con</th>
                  <th className="text-right font-semibold px-3 py-2 hidden sm:table-cell">Al mes</th>
                  <th className="text-right font-semibold px-3 py-2 hidden sm:table-cell">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visibles.map((s) => {
                  const faltan = daysToBilling(s.billing_day);
                  const acciones = (
                    <>
                      <button className={btnSecondary} onClick={() => startEdit(s)}>
                        Editar
                      </button>
                      <button className={btnSecondary} onClick={() => toggle(s)}>
                        {s.is_active ? 'Cancelar' : 'Reactivar'}
                      </button>
                    </>
                  );
                  return (
                    <tr key={s.id} className={`hover:bg-slate-50 ${!s.is_active ? 'opacity-55' : ''}`}>
                      <td className="px-3 py-2">
                        <span className="font-semibold text-slate-800">{s.name}</span>
                        <div className="sm:hidden text-xs text-slate-400 mt-0.5">
                          Corte el {s.billing_day}
                          {s.is_active && faltan <= 7 && ` · en ${faltan} d`}
                        </div>
                        {!s.is_active && (
                          <span className="text-[10px] uppercase tracking-wide font-bold text-slate-500">
                            Cancelada
                          </span>
                        )}
                        <MobileAmount label="Al mes" value={fmtUSD(s.amount_usd)} />
                        <RowActions mobile onDelete={() => remove(s)}>
                          {acciones}
                        </RowActions>
                      </td>
                      <td className="px-2 py-2 text-center hidden sm:table-cell">
                        <span className="font-semibold text-slate-700">{s.billing_day}</span>
                        {s.is_active && faltan <= 7 && (
                          <div className="text-[10px] text-amber-700 font-semibold">
                            {faltan === 0 ? 'hoy' : `en ${faltan} d`}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-slate-600 hidden md:table-cell">
                        {s.account_id
                          ? accountLabel(accounts.find((a) => a.id === s.account_id))
                          : '—'}
                      </td>
                      <td className="px-3 py-2 text-right font-semibold text-slate-800 whitespace-nowrap hidden sm:table-cell">
                        {fmtUSD(s.amount_usd)}
                      </td>
                      <td className="px-3 py-2 hidden sm:table-cell">
                        <RowActions onDelete={() => remove(s)}>{acciones}</RowActions>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-xs text-slate-400">
          Las suscripciones se marcan solas en el calendario en su día de corte, pero{' '}
          <strong>no crean el gasto del mes</strong>: eso se registra a mano, para que un mes que no
          te cobren no deje un gasto que nunca pasó.
        </p>
      </div>
    </div>
  );
}
