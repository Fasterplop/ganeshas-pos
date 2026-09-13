'use client';

// Registro de una compra a proveedor (o de un gasto operativo).
//
// La propuesta lo define como "menos tiempo que anotarlo en un cuaderno": por
// eso el formulario tiene un solo camino, con la cuenta preseleccionada y el
// vencimiento propuesto solo. Lo opcional (lineas, foto) no estorba.
//
// Se comparte entre kind='compra' y kind='gasto' porque el documento es el
// mismo; solo cambian las etiquetas y si el proveedor es obligatorio.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Modal from '@/components/Modal';
import { createClient } from '@/lib/supabase/client';
import { usePOSStore } from '@/store/usePOSStore';
import { finErrorMessage } from '@/lib/finanzas/errors';
import { caracasToday, formatDate } from '@/lib/finanzas/dates';
import { fmtUSD, toUSD, accountLabel, termDays, type Currency } from '@/lib/finanzas/money';
import { uploadFinanzasFile, signedUrl, removeFinanzasFile } from '@/lib/finanzas/storage';
import type { Supplier } from './SupplierFormModal';
import type { Account } from './AccountFormModal';
import { FinField, inputClass, btnPrimary, btnSecondary } from './ui';

export interface Expense {
  id: string;
  kind: string;
  supplier_id: string | null;
  category_id: string | null;
  shipment_id: string | null;
  description: string | null;
  currency: string;
  amount: number;
  bcv_rate: number | null;
  amount_usd: number;
  expense_date: string;
  due_date: string | null;
  paid_usd: number;
  status: string;
  is_personal: boolean;
  receipt_path: string | null;
  notes: string | null;
  created_at: string;
}

export interface Category {
  id: string;
  name: string;
  kind: string;
  is_active: boolean;
}

interface Line {
  key: string;
  description: string;
  quantity: string;
  unit_cost: string;
}

const newLine = (): Line => ({
  key: crypto.randomUUID(),
  description: '',
  quantity: '1',
  unit_cost: '',
});

/** Suma n dias a 'YYYY-MM-DD' sin que la zona horaria del navegador la corra. */
function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

type PayMode = 'pagada' | 'abono' | 'pendiente';

export default function ExpenseFormModal({
  isOpen,
  onClose,
  expense,
  kind,
  defaultPersonal = false,
  suppliers,
  accounts,
  categories,
  onSaved,
  onSupplierCreated,
}: {
  isOpen: boolean;
  onClose: () => void;
  expense?: Expense | null;
  kind: 'compra' | 'gasto';
  /** Arranca marcado como personal (pestaña Personal). */
  defaultPersonal?: boolean;
  suppliers: Supplier[];
  accounts: Account[];
  categories: Category[];
  onSaved: () => void;
  onSupplierCreated?: (s: Supplier) => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const { bcvRate } = usePOSStore();
  const isEdit = !!expense;

  const [supplierId, setSupplierId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<Currency>('USD');
  const [rate, setRate] = useState('');
  const [expenseDate, setExpenseDate] = useState(caracasToday());
  const [dueDate, setDueDate] = useState('');
  const [payMode, setPayMode] = useState<PayMode>('pendiente');
  const [accountId, setAccountId] = useState('');
  const [abono, setAbono] = useState('');
  const [notes, setNotes] = useState('');
  const [isPersonal, setIsPersonal] = useState(false);

  const [lines, setLines] = useState<Line[]>([]);
  const [showLines, setShowLines] = useState(false);

  const [file, setFile] = useState<File | null>(null);
  const [receiptPath, setReceiptPath] = useState<string | null>(null);
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null);

  const [newSupplierName, setNewSupplierName] = useState('');
  const [creatingSupplier, setCreatingSupplier] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usableAccounts = accounts.filter((a) => a.is_active && a.is_personal === isPersonal);
  const usableCategories = categories.filter((c) => c.is_active);

  const effectiveRate = currency === 'VES' ? Number(rate || bcvRate) || 0 : 0;
  const usd = toUSD(Number(amount), currency, effectiveRate);

  // --- carga inicial ---------------------------------------------------------
  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setFile(null);
    setReceiptUrl(null);
    setCreatingSupplier(false);
    setNewSupplierName('');

    if (expense) {
      setSupplierId(expense.supplier_id ?? '');
      setCategoryId(expense.category_id ?? '');
      setDescription(expense.description ?? '');
      setAmount(String(expense.amount));
      setCurrency((expense.currency as Currency) ?? 'USD');
      setRate(expense.bcv_rate != null ? String(expense.bcv_rate) : '');
      setExpenseDate(expense.expense_date);
      setDueDate(expense.due_date ?? '');
      setNotes(expense.notes ?? '');
      setIsPersonal(expense.is_personal);
      setReceiptPath(expense.receipt_path);
      // Al editar no se vuelve a cobrar: los abonos se manejan aparte.
      setPayMode('pendiente');
      setAccountId('');
      setAbono('');
      setLines([]);
      setShowLines(false);
    } else {
      setSupplierId('');
      setCategoryId('');
      setDescription('');
      setAmount('');
      setCurrency('USD');
      setRate('');
      setExpenseDate(caracasToday());
      setDueDate('');
      setNotes('');
      setIsPersonal(defaultPersonal);
      setReceiptPath(null);
      setPayMode('pendiente');
      setAccountId('');
      setAbono('');
      setLines([]);
      setShowLines(false);
    }
  }, [isOpen, expense, defaultPersonal]);

  useEffect(() => {
    let cancelled = false;
    if (!isOpen || !receiptPath) {
      setReceiptUrl(null);
      return;
    }
    signedUrl(receiptPath).then((u) => {
      if (!cancelled) setReceiptUrl(u);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, receiptPath]);

  // --- al elegir proveedor: cuenta preseleccionada y vencimiento propuesto ----
  const onSupplierChange = useCallback(
    async (id: string) => {
      setSupplierId(id);
      if (!id || isEdit) return;

      const sup = suppliers.find((s) => s.id === id);

      // "Queda pre-seleccionada la ultima usada con ese proveedor": se busca el
      // ultimo pago hecho a una compra suya.
      const { data } = await supabase
        .from('fin_payments')
        .select('account_id, paid_at, fin_expenses!inner(supplier_id)')
        .eq('fin_expenses.supplier_id', id)
        .order('paid_at', { ascending: false })
        .limit(1);
      if (data?.[0]?.account_id) setAccountId(data[0].account_id as string);

      // Y el vencimiento sale solo de las condiciones de pago de la marca.
      const days = termDays(sup?.payment_terms);
      if (days && days > 0) {
        setPayMode('pendiente');
        setDueDate(addDays(expenseDate || caracasToday(), days));
      } else if (days === 0) {
        setPayMode('pagada');
        setDueDate('');
      }
    },
    [suppliers, supabase, expenseDate, isEdit],
  );

  const createSupplierInline = async () => {
    const name = newSupplierName.trim();
    if (name.length < 2) {
      setError('Escribe el nombre de la marca.');
      return;
    }
    setBusy(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { data, error: err } = await supabase
      .from('fin_suppliers')
      .insert({ name, payment_terms: 'contado', created_by: user?.id })
      .select()
      .single();
    setBusy(false);
    if (err) {
      setError(err.code === '23505' ? 'Ya existe una marca con ese nombre.' : finErrorMessage(err));
      return;
    }
    onSupplierCreated?.(data as Supplier);
    setSupplierId(data.id);
    setCreatingSupplier(false);
    setNewSupplierName('');
    setError(null);
  };

  // --- guardar ---------------------------------------------------------------
  const save = async () => {
    setError(null);

    if (kind === 'compra' && !supplierId) {
      setError('Elige el proveedor.');
      return;
    }
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setError('Escribe el monto de la compra.');
      return;
    }
    if (currency === 'VES' && effectiveRate <= 0) {
      setError('Para un monto en bolívares hace falta la tasa del día de la compra.');
      return;
    }
    if (usd === null) {
      setError('No se pudo calcular el equivalente en dólares.');
      return;
    }
    if ((payMode === 'pagada' || payMode === 'abono') && !accountId) {
      setError('Elige con qué cuenta se pagó.');
      return;
    }
    const abonoUsd = payMode === 'abono' ? toUSD(Number(abono), currency, effectiveRate) : null;
    if (payMode === 'abono' && (abonoUsd === null || abonoUsd <= 0)) {
      setError('Escribe cuánto abonaste.');
      return;
    }
    if (payMode === 'abono' && abonoUsd !== null && abonoUsd > usd) {
      setError('El abono no puede ser mayor que el total de la compra.');
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

    const payload = {
      kind,
      supplier_id: supplierId || null,
      category_id: categoryId || null,
      description: description.trim() || null,
      currency,
      amount: value,
      bcv_rate: currency === 'VES' ? effectiveRate : null,
      amount_usd: usd,
      expense_date: expenseDate || caracasToday(),
      due_date: payMode === 'pagada' ? null : dueDate || null,
      is_personal: isPersonal,
      notes: notes.trim() || null,
    };

    // --- edicion ---
    if (expense) {
      const { error: err } = await supabase.from('fin_expenses').update(payload).eq('id', expense.id);
      if (err) {
        setBusy(false);
        setError(finErrorMessage(err));
        return;
      }
      if (file) {
        const { path, error: upErr } = await uploadFinanzasFile(file, 'receipts', expense.id);
        if (!upErr && path) {
          await supabase.from('fin_expenses').update({ receipt_path: path }).eq('id', expense.id);
          if (expense.receipt_path && expense.receipt_path !== path) {
            await removeFinanzasFile(expense.receipt_path);
          }
        } else if (upErr) {
          setBusy(false);
          setError(`La compra se guardó, pero la foto no subió: ${upErr}`);
          onSaved();
          return;
        }
      }
      setBusy(false);
      onSaved();
      onClose();
      return;
    }

    // --- alta: aviso de duplicado ---
    // "Si se repite proveedor, monto y fecha, el sistema avisa antes de
    // duplicar el gasto." Avisa, no bloquea: a veces se le compra dos veces lo
    // mismo a la misma marca el mismo dia.
    if (supplierId) {
      const { data: dupes } = await supabase
        .from('fin_expenses')
        .select('id, description, amount_usd')
        .eq('supplier_id', supplierId)
        .eq('expense_date', payload.expense_date)
        .eq('amount_usd', usd)
        .limit(1);
      if (dupes && dupes.length > 0) {
        const sup = suppliers.find((s) => s.id === supplierId)?.name ?? 'ese proveedor';
        const ok = window.confirm(
          `Ya tienes una compra a ${sup} por ${fmtUSD(usd)} con fecha ${formatDate(payload.expense_date)}.\n\n` +
            '¿Es una compra distinta y quieres registrarla igual?',
        );
        if (!ok) {
          setBusy(false);
          return;
        }
      }
    }

    const { data: created, error: err } = await supabase
      .from('fin_expenses')
      .insert({ ...payload, created_by: user.id })
      .select()
      .single();
    if (err) {
      setBusy(false);
      setError(finErrorMessage(err));
      return;
    }

    // Lineas opcionales: informativas, no tienen que sumar el total.
    const validLines = lines.filter((l) => l.description.trim());
    if (validLines.length > 0) {
      const { error: lineErr } = await supabase.from('fin_purchase_lines').insert(
        validLines.map((l, i) => {
          const qty = Number(l.quantity) || 1;
          const unit = l.unit_cost.trim() === '' ? null : Number(l.unit_cost);
          return {
            expense_id: created.id,
            description: l.description.trim(),
            quantity: qty,
            unit_cost_usd: unit,
            line_total_usd: unit != null ? Math.round(qty * unit * 100) / 100 : null,
            sort_order: i,
          };
        }),
      );
      if (lineErr) setError(`La compra se guardó, pero el detalle no: ${finErrorMessage(lineErr)}`);
    }

    // El pago es lo que mueve el dinero; el trigger deja el estado en pagada o
    // parcial segun lo que cubra.
    if (payMode === 'pagada' || payMode === 'abono') {
      const payAmount = payMode === 'pagada' ? value : Number(abono);
      const payUsd = payMode === 'pagada' ? usd : abonoUsd!;
      const { error: payErr } = await supabase.from('fin_payments').insert({
        expense_id: created.id,
        account_id: accountId,
        currency,
        amount: payAmount,
        bcv_rate: currency === 'VES' ? effectiveRate : null,
        amount_usd: payUsd,
        paid_at: payload.expense_date,
        created_by: user.id,
      });
      if (payErr) {
        setBusy(false);
        setError(`La compra se guardó, pero el pago no: ${finErrorMessage(payErr)}`);
        onSaved();
        return;
      }
    }

    if (file) {
      const { path, error: upErr } = await uploadFinanzasFile(file, 'receipts', created.id);
      if (!upErr && path) {
        await supabase.from('fin_expenses').update({ receipt_path: path }).eq('id', created.id);
      } else if (upErr) {
        setBusy(false);
        setError(`La compra se guardó, pero la foto no subió: ${upErr}`);
        onSaved();
        return;
      }
    }

    setBusy(false);
    onSaved();
    onClose();
  };

  const clearReceipt = async () => {
    if (!expense || !receiptPath) return;
    if (!window.confirm('¿Quitar la foto del recibo?')) return;
    await supabase.from('fin_expenses').update({ receipt_path: null }).eq('id', expense.id);
    await removeFinanzasFile(receiptPath);
    setReceiptPath(null);
    setReceiptUrl(null);
  };

  const title = isEdit
    ? kind === 'compra'
      ? 'Editar compra'
      : 'Editar gasto'
    : kind === 'compra'
      ? 'Registrar compra'
      : 'Registrar gasto';

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title}>
      <div className="space-y-4">
        {/* 1. Proveedor */}
        {kind === 'compra' && (
          <FinField label="Proveedor" required>
            {creatingSupplier ? (
              <div className="flex gap-2">
                <input
                  value={newSupplierName}
                  onChange={(e) => setNewSupplierName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      createSupplierInline();
                    }
                  }}
                  placeholder="Nombre de la marca"
                  className={inputClass}
                  autoFocus
                />
                <button onClick={createSupplierInline} disabled={busy} className={btnPrimary}>
                  Crear
                </button>
                <button onClick={() => setCreatingSupplier(false)} className={btnSecondary}>
                  ✕
                </button>
              </div>
            ) : (
              <div className="flex gap-2">
                <select
                  value={supplierId}
                  onChange={(e) => onSupplierChange(e.target.value)}
                  className={inputClass}
                >
                  <option value="">Selecciona…</option>
                  {suppliers
                    .filter((s) => s.is_active || s.id === supplierId)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </select>
                <button onClick={() => setCreatingSupplier(true)} className={btnSecondary} title="Crear proveedor">
                  + Nuevo
                </button>
              </div>
            )}
          </FinField>
        )}

        {/* 2. Monto y fecha */}
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <FinField label="Monto" required>
            <input
              type="number"
              step="0.01"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className={inputClass}
              placeholder="300.00"
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
          ) : (
            <div className="hidden sm:block" />
          )}
          <FinField label="Fecha de la compra" required>
            <input
              type="date"
              value={expenseDate}
              onChange={(e) => setExpenseDate(e.target.value)}
              className={inputClass}
            />
          </FinField>
        </div>

        {currency === 'VES' && usd !== null && (
          <p className="text-xs text-slate-500 -mt-1">
            Equivale a <strong>{fmtUSD(usd)}</strong>. Ese valor queda congelado: aunque la tasa
            cambie, esta compra seguirá valiendo lo mismo en los reportes.
          </p>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <FinField label="Concepto">
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className={inputClass}
              placeholder={kind === 'compra' ? 'Pedido de temporada' : 'Alquiler de septiembre'}
            />
          </FinField>
          <FinField label="Categoría" hint="Para que entre en el presupuesto del mes.">
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={inputClass}>
              <option value="">Sin categoría</option>
              {usableCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </FinField>
        </div>

        {/* 3-4. Estado y cuenta */}
        {!isEdit ? (
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 space-y-3">
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ['pagada', 'Pagada completa'],
                  ['abono', 'Abono parcial'],
                  ['pendiente', 'Queda pendiente'],
                ] as Array<[PayMode, string]>
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  onClick={() => setPayMode(mode)}
                  className={`text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors cursor-pointer ${
                    payMode === mode
                      ? 'bg-teal-700 text-white border-teal-700'
                      : 'bg-white text-slate-600 border-slate-200 hover:border-teal-400'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {payMode === 'abono' && (
              <FinField
                label={`Cuánto abonaste (${currency === 'USD' ? 'USD' : 'Bs'})`}
                required
                hint={
                  abono && usd !== null && toUSD(Number(abono), currency, effectiveRate) !== null
                    ? `Quedaría un saldo de ${fmtUSD(usd - toUSD(Number(abono), currency, effectiveRate)!)}.`
                    : undefined
                }
              >
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={abono}
                  onChange={(e) => setAbono(e.target.value)}
                  className={inputClass}
                />
              </FinField>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {payMode !== 'pendiente' && (
                <FinField
                  label="Con qué cuenta se pagó"
                  required
                  hint={
                    'Solo para tenerlo anotado: ningún pago descuenta del saldo de la cuenta.'
                  }
                >
                  <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={inputClass}>
                    <option value="">Selecciona…</option>
                    {usableAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {accountLabel(a)}
                      </option>
                    ))}
                  </select>
                </FinField>
              )}
              {payMode !== 'pagada' && (
                <FinField label="Vence el" hint="Entra solo al calendario de pagos.">
                  <input
                    type="date"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    className={inputClass}
                  />
                </FinField>
              )}
            </div>

            {payMode === 'pendiente' && (
              <p className="text-xs text-slate-500">
                Los abonos se registran después, desde el botón <strong>Abonos</strong> de la lista.
                Ahí también se divide un pago entre dos cuentas.
              </p>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FinField label="Vence el">
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className={inputClass}
              />
            </FinField>
            <p className="text-xs text-slate-500 self-end pb-2">
              Los abonos de esta compra se manejan desde el botón <strong>Abonos</strong>.
            </p>
          </div>
        )}

        {/* 5. Detalle opcional */}
        {!isEdit && (
          <div>
            {!showLines ? (
              <button
                onClick={() => {
                  setShowLines(true);
                  setLines([newLine()]);
                }}
                className="text-sm text-teal-700 hover:underline cursor-pointer"
              >
                + Agregar detalle de qué venía (opcional)
              </button>
            ) : (
              <div className="border border-slate-200 rounded-lg p-3 space-y-2">
                <p className="text-xs text-slate-500">
                  Solo como referencia para saber qué traía. No hace falta que sume el total, y no
                  se enlaza con el catálogo de productos.
                </p>
                {lines.map((l, i) => (
                  <div key={l.key} className="grid grid-cols-[1fr_70px_90px_auto] gap-2">
                    <input
                      value={l.description}
                      onChange={(e) =>
                        setLines((p) =>
                          p.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)),
                        )
                      }
                      placeholder="10 blusas talla M"
                      className={inputClass}
                    />
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={l.quantity}
                      onChange={(e) =>
                        setLines((p) => p.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))
                      }
                      placeholder="Cant."
                      className={inputClass}
                    />
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={l.unit_cost}
                      onChange={(e) =>
                        setLines((p) => p.map((x, j) => (j === i ? { ...x, unit_cost: e.target.value } : x)))
                      }
                      placeholder="c/u $"
                      className={inputClass}
                    />
                    <button
                      onClick={() => setLines((p) => p.filter((_, j) => j !== i))}
                      className="text-slate-400 hover:text-red-600 px-2 cursor-pointer"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <button
                  onClick={() => setLines((p) => [...p, newLine()])}
                  className="text-sm text-teal-700 hover:underline cursor-pointer"
                >
                  + Otra línea
                </button>
              </div>
            )}
          </div>
        )}

        {/* 6. Respaldo */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <FinField label="Foto del recibo" hint="Opcional. Se puede adjuntar después.">
            {receiptPath ? (
              <div className="flex items-center gap-3">
                {receiptUrl ? (
                  <a href={receiptUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-teal-700 underline">
                    Ver recibo adjunto
                  </a>
                ) : (
                  <span className="text-sm text-slate-400">Cargando…</span>
                )}
                <button onClick={clearReceipt} className="text-xs text-red-600 cursor-pointer">
                  Quitar
                </button>
              </div>
            ) : (
              <input
                type="file"
                accept="image/*,application/pdf"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="block w-full text-sm text-slate-600 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-teal-50 file:text-teal-700 hover:file:bg-teal-100 cursor-pointer"
              />
            )}
          </FinField>
          <FinField label="Nota">
            <input value={notes} onChange={(e) => setNotes(e.target.value)} className={inputClass} />
          </FinField>
        </div>

        <label className="flex items-center gap-2.5 text-sm text-slate-700 cursor-pointer">
          <input
            type="checkbox"
            checked={isPersonal}
            onChange={(e) => {
              setIsPersonal(e.target.checked);
              setAccountId('');
            }}
            className="rounded border-slate-300"
          />
          Es personal, no del negocio (queda fuera de todos los reportes del negocio)
        </label>

        {error && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className={btnSecondary} disabled={busy}>
            Cancelar
          </button>
          <button onClick={save} className={btnPrimary} disabled={busy}>
            {busy ? 'Guardando…' : isEdit ? 'Guardar cambios' : 'Registrar'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
