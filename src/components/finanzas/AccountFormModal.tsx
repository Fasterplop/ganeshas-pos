'use client';

// Alta y edición de una cuenta o tarjeta del negocio.
//
// SEGURIDAD: este formulario NO pide ni guarda el número completo de la
// tarjeta, el CVV ni claves. Solo alias, banco y los últimos 4 dígitos. La
// tabla lo refuerza con un CHECK de exactamente 4 dígitos, para que ni un
// dedazo pueda dejar el número entero ahí.

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Modal from '@/components/Modal';
import { createClient } from '@/lib/supabase/client';
import { finErrorMessage } from '@/lib/finanzas/errors';
import { ACCOUNT_KIND_LABEL } from '@/lib/finanzas/money';
import { caracasToday } from '@/lib/finanzas/dates';
import { FinField, inputClass, btnPrimary, btnSecondary } from './ui';

export interface Account {
  id: string;
  name: string;
  kind: string;
  bank_name: string | null;
  last4: string | null;
  currency: string;
  opening_balance_usd: number;
  opening_balance_date: string | null;
  credit_limit_usd: number | null;
  statement_day: number | null;
  due_day: number | null;
  is_personal: boolean;
  is_active: boolean;
  notes: string | null;
}

/** Saldo derivado (vista fin_v_account_balance). No se guarda, se calcula. */
export interface AccountBalance extends Account {
  account_id: string;
  moved_usd: number;
  balance_usd: number;
  available_usd: number | null;
}

const schema = z
  .object({
    name: z.string().trim().min(2, 'Ponle un nombre para reconocerla'),
    kind: z.enum(['banco', 'zelle', 'efectivo', 'tarjeta_credito', 'otro']),
    bank_name: z.string().trim().optional(),
    last4: z
      .union([z.literal(''), z.string().regex(/^\d{4}$/, 'Son exactamente 4 dígitos')])
      .optional(),
    currency: z.enum(['USD', 'VES']),
    opening_balance_usd: z.string().optional(),
    opening_balance_date: z.string().optional(),
    credit_limit_usd: z.string().optional(),
    statement_day: z.string().optional(),
    due_day: z.string().optional(),
    is_personal: z.boolean(),
    notes: z.string().trim().optional(),
  })
  .refine((v) => v.kind !== 'tarjeta_credito' || !v.credit_limit_usd || Number(v.credit_limit_usd) > 0, {
    message: 'El límite debe ser mayor que 0',
    path: ['credit_limit_usd'],
  });

type FormValues = z.infer<typeof schema>;

const EMPTY: FormValues = {
  name: '',
  kind: 'banco',
  bank_name: '',
  last4: '',
  currency: 'USD',
  opening_balance_usd: '0',
  opening_balance_date: '',
  credit_limit_usd: '',
  statement_day: '',
  due_day: '',
  is_personal: false,
  notes: '',
};

const num = (s?: string) => {
  if (!s || s.trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

export default function AccountFormModal({
  isOpen,
  onClose,
  account,
  defaultPersonal = false,
  onSaved,
}: {
  isOpen: boolean;
  onClose: () => void;
  account?: Account | null;
  defaultPersonal?: boolean;
  onSaved: (account: Account, isNew: boolean) => void;
}) {
  const {
    register,
    handleSubmit,
    reset,
    watch,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: EMPTY });

  const kind = watch('kind');
  const isCard = kind === 'tarjeta_credito';

  useEffect(() => {
    if (!isOpen) return;
    reset(
      account
        ? {
            name: account.name,
            kind: (account.kind as FormValues['kind']) ?? 'banco',
            bank_name: account.bank_name ?? '',
            last4: account.last4 ?? '',
            currency: (account.currency as FormValues['currency']) ?? 'USD',
            opening_balance_usd: String(account.opening_balance_usd ?? 0),
            opening_balance_date: account.opening_balance_date ?? '',
            credit_limit_usd: account.credit_limit_usd != null ? String(account.credit_limit_usd) : '',
            statement_day: account.statement_day != null ? String(account.statement_day) : '',
            due_day: account.due_day != null ? String(account.due_day) : '',
            is_personal: account.is_personal,
            notes: account.notes ?? '',
          }
        : { ...EMPTY, is_personal: defaultPersonal, opening_balance_date: caracasToday() },
    );
  }, [isOpen, account, defaultPersonal, reset]);

  const onSubmit = async (values: FormValues) => {
    const supabase = createClient();
    const card = values.kind === 'tarjeta_credito';

    const payload = {
      name: values.name,
      kind: values.kind,
      bank_name: values.bank_name || null,
      last4: values.last4 || null,
      currency: values.currency,
      opening_balance_usd: num(values.opening_balance_usd) ?? 0,
      opening_balance_date: values.opening_balance_date || null,
      // La tabla tiene un CHECK: límite y días de corte/pago solo pueden venir
      // con valor en una tarjeta. Si se cambia el tipo, hay que limpiarlos.
      credit_limit_usd: card ? num(values.credit_limit_usd) : null,
      statement_day: card ? num(values.statement_day) : null,
      due_day: card ? num(values.due_day) : null,
      is_personal: values.is_personal,
      notes: values.notes || null,
    };

    if (account) {
      const { data, error } = await supabase
        .from('fin_accounts')
        .update(payload)
        .eq('id', account.id)
        .select()
        .single();
      if (error) {
        setError('root', { message: finErrorMessage(error) });
        return;
      }
      onSaved(data as Account, false);
      onClose();
      return;
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setError('root', { message: 'Sesión expirada. Vuelve a iniciar sesión.' });
      return;
    }

    const { data, error } = await supabase
      .from('fin_accounts')
      .insert({ ...payload, created_by: user.id })
      .select()
      .single();
    if (error) {
      setError('root', { message: finErrorMessage(error) });
      return;
    }
    onSaved(data as Account, true);
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={account ? `Editar ${account.name}` : 'Nueva cuenta o tarjeta'}
    >
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <FinField label="Nombre / Alias" required error={errors.name?.message}>
            <input
              {...register('name')}
              className={inputClass}
              placeholder="Amex Business, Caja Chica…"
              autoFocus
            />
          </FinField>

          <FinField label="Tipo" required error={errors.kind?.message}>
            <select {...register('kind')} className={inputClass}>
              {Object.entries(ACCOUNT_KIND_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </FinField>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <FinField label="Banco / Emisor" className="sm:col-span-2" error={errors.bank_name?.message}>
            <input {...register('bank_name')} className={inputClass} placeholder="Banesco, Amex…" />
          </FinField>

          <FinField
            label="Últimos 4 dígitos"
            hint="Nunca el número completo."
            error={errors.last4?.message}
          >
            <input
              {...register('last4')}
              className={inputClass}
              placeholder="2890"
              maxLength={4}
              inputMode="numeric"
            />
          </FinField>
        </div>

        <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 space-y-3">
          <p className="text-xs text-slate-500">
            {isCard
              ? 'Cuánto debes hoy en esta tarjeta. A partir de ahí, la deuda solo cambia con los abonos y cargos que registres en Cuentas.'
              : 'Cuánto hay hoy en esta cuenta. A partir de ahí, el saldo solo cambia con los movimientos que registres en Cuentas.'}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <FinField
              label={isCard ? 'Deuda actual (USD)' : 'Saldo actual (USD)'}
              error={errors.opening_balance_usd?.message}
            >
              <input
                type="number"
                step="0.01"
                {...register('opening_balance_usd')}
                className={inputClass}
              />
            </FinField>

            <FinField label="Desde qué fecha" error={errors.opening_balance_date?.message}>
              <input type="date" {...register('opening_balance_date')} className={inputClass} />
            </FinField>

            <FinField label="Moneda de la cuenta" error={errors.currency?.message}>
              <select {...register('currency')} className={inputClass}>
                <option value="USD">Dólares</option>
                <option value="VES">Bolívares</option>
              </select>
            </FinField>
          </div>
        </div>

        {isCard && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <FinField label="Límite (USD)" error={errors.credit_limit_usd?.message}>
              <input type="number" step="0.01" min="0" {...register('credit_limit_usd')} className={inputClass} />
            </FinField>

            <FinField label="Día de corte" hint="1 al 31." error={errors.statement_day?.message}>
              <input type="number" min="1" max="31" {...register('statement_day')} className={inputClass} />
            </FinField>

            <FinField label="Día de pago" hint="1 al 31." error={errors.due_day?.message}>
              <input type="number" min="1" max="31" {...register('due_day')} className={inputClass} />
            </FinField>
          </div>
        )}

        <FinField label="Notas" error={errors.notes?.message}>
          <textarea {...register('notes')} rows={2} className={inputClass} />
        </FinField>

        <label className="flex items-start gap-2.5 text-sm text-slate-700 cursor-pointer bg-slate-50 border border-slate-200 rounded-lg p-3">
          <input type="checkbox" {...register('is_personal')} className="mt-0.5 rounded border-slate-300" />
          <span>
            <strong>Es personal, no del negocio.</strong>
            <span className="block text-xs text-slate-500 mt-0.5">
              Queda fuera de todos los reportes del negocio y solo aparece en la pestaña Personal.
            </span>
          </span>
        </label>

        {errors.root?.message && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {errors.root.message}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className={btnSecondary}>
            Cancelar
          </button>
          <button type="submit" disabled={isSubmitting} className={btnPrimary}>
            {isSubmitting ? 'Guardando…' : account ? 'Guardar cambios' : 'Crear'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
