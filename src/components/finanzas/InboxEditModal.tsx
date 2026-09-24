'use client';

// Corregir una propuesta de la Bandeja antes de aprobarla.
//
// Edita la fila de fin_inbox (RLS del dueño), no registra nada: el registro lo
// hace el botón Aprobar con el RPC. La línea del banco (raw_text) y la llave de
// repetidos (dedup_key) no se tocan: representan lo que vino del banco.

import { useEffect, useMemo, useState } from 'react';
import Modal from '@/components/Modal';
import { createClient } from '@/lib/supabase/client';
import { FinField, inputClass, btnPrimary, btnSecondary, FinNotice, Notice } from '@/components/finanzas/ui';
import { accountLabel, fmtUSD, toUSD, type Currency } from '@/lib/finanzas/money';
import { formatDate } from '@/lib/finanzas/dates';
import { finErrorMessage } from '@/lib/finanzas/errors';

export interface Option {
  id: string;
  name: string;
}

export interface InboxRow {
  id: string;
  batch_id: string;
  source_file: string | null;
  line_no: number | null;
  raw_text: string;
  kind: 'compra' | 'gasto' | 'abono';
  supplier_id: string | null;
  supplier_name_new: string | null;
  category_id: string | null;
  expense_id: string | null;
  account_id: string | null;
  description: string | null;
  currency: Currency;
  amount: number;
  bcv_rate: number | null;
  amount_usd: number;
  movement_date: string;
  due_date: string | null;
  paid: boolean;
  is_personal: boolean;
  reference: string | null;
  warning: string | null;
  ai_note: string | null;
  status: 'pendiente' | 'aprobada' | 'descartada';
  approve_error: string | null;
  result_expense_id: string | null;
  created_at: string;
  reviewed_at: string | null;
}

interface OpenExpense {
  id: string;
  expense_date: string;
  amount_usd: number;
  paid_usd: number;
  description: string | null;
  supplier: { name: string } | null;
}

const NEW_SUPPLIER = '__nuevo__';

interface Props {
  row: InboxRow | null;
  onClose: () => void;
  onSaved: () => void;
  suppliers: Option[];
  categories: (Option & { kind: string })[];
  accounts: (Option & { last4: string | null })[];
}

// El formulario se monta de nuevo con cada fila (key): así arranca siempre con
// los datos de esa fila, sin sincronizar estado a mano.
export default function InboxEditModal(props: Props) {
  if (!props.row) return null;
  return <InboxEditForm key={props.row.id} {...props} row={props.row} />;
}

function InboxEditForm({
  row,
  onClose,
  onSaved,
  suppliers,
  categories,
  accounts,
}: Props & { row: InboxRow }) {
  const supabase = useMemo(() => createClient(), []);
  const [form, setForm] = useState<InboxRow>(row);
  const [supplierChoice, setSupplierChoice] = useState(
    row.supplier_id ?? (row.supplier_name_new ? NEW_SUPPLIER : ''),
  );
  const [openExpenses, setOpenExpenses] = useState<OpenExpense[]>([]);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  // Compras abiertas, solo si hace falta elegir a cuál va un abono.
  const isAbono = form.kind === 'abono';
  useEffect(() => {
    if (!isAbono) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('fin_expenses')
        .select('id, expense_date, amount_usd, paid_usd, description, supplier:fin_suppliers(name)')
        .neq('status', 'pagada')
        .order('expense_date', { ascending: false })
        .limit(500);
      if (!cancelled) setOpenExpenses((data ?? []) as unknown as OpenExpense[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [isAbono, supabase]);

  const set = <K extends keyof InboxRow>(key: K, value: InboxRow[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const usd = toUSD(Number(form.amount), form.currency, form.bcv_rate);
  const kindCategories = categories.filter((c) => c.kind === (form.kind === 'compra' ? 'compra' : 'gasto'));
  const paid = form.kind === 'abono' || form.paid;

  const save = async () => {
    setNotice(null);
    if (!usd) {
      setNotice({
        type: 'error',
        text: form.currency === 'VES' ? 'Falta el monto o la tasa BCV.' : 'El monto debe ser mayor que 0.',
      });
      return;
    }
    const newName = (form.supplier_name_new ?? '').trim();
    if (form.kind === 'compra' && !supplierChoice) {
      setNotice({ type: 'error', text: 'Una compra necesita proveedor.' });
      return;
    }
    if (supplierChoice === NEW_SUPPLIER && !newName) {
      setNotice({ type: 'error', text: 'Escribe el nombre del proveedor nuevo.' });
      return;
    }
    if (form.kind === 'abono' && !form.expense_id) {
      setNotice({ type: 'error', text: 'Elige la compra a la que va el abono.' });
      return;
    }

    setSaving(true);
    const isNew = supplierChoice === NEW_SUPPLIER;
    const { error } = await supabase
      .from('fin_inbox')
      .update({
        kind: form.kind,
        supplier_id: form.kind === 'abono' || isNew ? null : supplierChoice || null,
        supplier_name_new: form.kind !== 'abono' && isNew ? newName : null,
        category_id: form.kind === 'abono' ? null : form.category_id || null,
        expense_id: form.kind === 'abono' ? form.expense_id : null,
        account_id: form.account_id || null,
        description: form.description?.trim() || null,
        currency: form.currency,
        amount: Number(form.amount),
        bcv_rate: form.currency === 'VES' ? Number(form.bcv_rate) : null,
        amount_usd: usd,
        movement_date: form.movement_date,
        due_date: paid ? null : form.due_date || null,
        paid,
        is_personal: form.is_personal,
        reference: form.reference?.trim() || null,
        approve_error: null,
      })
      .eq('id', form.id);
    setSaving(false);
    if (error) {
      setNotice({ type: 'error', text: finErrorMessage(error) });
      return;
    }
    onSaved();
  };

  return (
    <Modal isOpen onClose={onClose} title="Corregir propuesta">
      <div className="space-y-4">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-slate-400 font-bold">Línea del banco</p>
          <p className="font-mono text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-md px-2 py-1.5 mt-1 break-words">
            {row.raw_text}
          </p>
        </div>

        <FinNotice notice={notice} onClose={() => setNotice(null)} />

        <div className="grid gap-4 sm:grid-cols-2">
          <FinField label="Tipo" required>
            <select
              className={inputClass}
              value={form.kind}
              onChange={(e) => set('kind', e.target.value as InboxRow['kind'])}
            >
              <option value="compra">Compra a proveedor</option>
              <option value="gasto">Gasto</option>
              <option value="abono">Abono a una compra ya registrada</option>
            </select>
          </FinField>

          <FinField label="Fecha" required>
            <input
              type="date"
              className={inputClass}
              value={form.movement_date}
              onChange={(e) => set('movement_date', e.target.value)}
            />
          </FinField>

          {form.kind === 'abono' ? (
            <FinField label="Compra que se abona" required className="sm:col-span-2">
              <select
                className={inputClass}
                value={form.expense_id ?? ''}
                onChange={(e) => set('expense_id', e.target.value || null)}
              >
                <option value="">— Elegir —</option>
                {openExpenses.map((e) => (
                  <option key={e.id} value={e.id}>
                    {(e.supplier?.name ?? e.description ?? 'Compra') +
                      ` · ${formatDate(e.expense_date)} · falta ${fmtUSD(Number(e.amount_usd) - Number(e.paid_usd))}`}
                  </option>
                ))}
              </select>
            </FinField>
          ) : (
            <>
              <FinField label="Proveedor" required={form.kind === 'compra'}>
                <select
                  className={inputClass}
                  value={supplierChoice}
                  onChange={(e) => setSupplierChoice(e.target.value)}
                >
                  <option value="">{form.kind === 'compra' ? '— Elegir —' : 'Sin proveedor'}</option>
                  <option value={NEW_SUPPLIER}>+ Proveedor nuevo…</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                {supplierChoice === NEW_SUPPLIER && (
                  <input
                    className={`${inputClass} mt-2`}
                    placeholder="Nombre del proveedor"
                    value={form.supplier_name_new ?? ''}
                    onChange={(e) => set('supplier_name_new', e.target.value)}
                  />
                )}
              </FinField>

              <FinField label="Categoría">
                <select
                  className={inputClass}
                  value={form.category_id ?? ''}
                  onChange={(e) => set('category_id', e.target.value || null)}
                >
                  <option value="">Sin categoría</option>
                  {kindCategories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </FinField>
            </>
          )}

          <FinField label="Moneda">
            <select
              className={inputClass}
              value={form.currency}
              onChange={(e) => set('currency', e.target.value as Currency)}
            >
              <option value="USD">Dólares (USD)</option>
              <option value="VES">Bolívares (Bs)</option>
            </select>
          </FinField>

          <FinField label={form.currency === 'VES' ? 'Monto en Bs' : 'Monto'} required>
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              className={inputClass}
              value={form.amount}
              onChange={(e) => set('amount', Number(e.target.value))}
            />
          </FinField>

          {form.currency === 'VES' && (
            <FinField label="Tasa BCV del día" required hint={usd ? `= ${fmtUSD(usd)}` : undefined}>
              <input
                type="number"
                inputMode="decimal"
                step="0.0001"
                min="0"
                className={inputClass}
                value={form.bcv_rate ?? ''}
                onChange={(e) => set('bcv_rate', e.target.value ? Number(e.target.value) : null)}
              />
            </FinField>
          )}

          {form.kind !== 'abono' && (
            <FinField label="¿Ya está pagado?">
              <label className="flex items-center gap-2 text-sm text-slate-700 py-2">
                <input
                  type="checkbox"
                  className="w-4 h-4 accent-teal-700"
                  checked={form.paid}
                  onChange={(e) => set('paid', e.target.checked)}
                />
                Sí, pagado completo
              </label>
            </FinField>
          )}

          {paid ? (
            <FinField
              label="Pagado con"
              required
              hint="Solo queda anotado como forma de pago: no cambia el saldo de la cuenta."
            >
              <select
                className={inputClass}
                value={form.account_id ?? ''}
                onChange={(e) => set('account_id', e.target.value || null)}
              >
                <option value="">— Elegir —</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {accountLabel(a)}
                  </option>
                ))}
              </select>
            </FinField>
          ) : (
            <FinField label="Vence">
              <input
                type="date"
                className={inputClass}
                value={form.due_date ?? ''}
                onChange={(e) => set('due_date', e.target.value || null)}
              />
            </FinField>
          )}

          <FinField label="Descripción" className="sm:col-span-2">
            <input
              className={inputClass}
              value={form.description ?? ''}
              onChange={(e) => set('description', e.target.value)}
            />
          </FinField>

          <FinField label="Referencia del banco">
            <input
              className={inputClass}
              value={form.reference ?? ''}
              onChange={(e) => set('reference', e.target.value)}
            />
          </FinField>

          <FinField label="Personal">
            <label className="flex items-center gap-2 text-sm text-slate-700 py-2">
              <input
                type="checkbox"
                className="w-4 h-4 accent-teal-700"
                checked={form.is_personal}
                onChange={(e) => set('is_personal', e.target.checked)}
              />
              Es un gasto personal
            </label>
          </FinField>
        </div>

        <div className="flex flex-wrap justify-end gap-2 pt-2 *:flex-auto sm:*:flex-none">
          <button className={btnSecondary} onClick={onClose}>
            Cancelar
          </button>
          <button className={btnPrimary} onClick={save} disabled={saving}>
            {saving ? 'Guardando…' : 'Guardar corrección'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
