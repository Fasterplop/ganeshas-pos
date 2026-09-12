'use client';

// Alta y edición de un proveedor.
//
// Vive en su propio componente y no dentro de la página porque la propuesta
// pide poder "crear uno nuevo en el momento sin salir de la pantalla" al
// registrar una compra: el mismo modal se abre desde /finanzas/proveedores y
// desde el formulario de compras.

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Modal from '@/components/Modal';
import { createClient } from '@/lib/supabase/client';
import { finErrorMessage } from '@/lib/finanzas/errors';
import { PAYMENT_TERMS_LABEL } from '@/lib/finanzas/money';
import { FinField, inputClass, btnPrimary, btnSecondary } from './ui';

export interface Supplier {
  id: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  payment_terms: string;
  notes: string | null;
  is_active: boolean;
}

const schema = z.object({
  name: z.string().trim().min(2, 'El nombre de la marca es obligatorio'),
  contact_name: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  email: z.union([z.literal(''), z.string().trim().email('Correo inválido')]).optional(),
  payment_terms: z.enum(['contado', '15_dias', '30_dias', 'consignacion', 'otro']),
  notes: z.string().trim().optional(),
});

type FormValues = z.infer<typeof schema>;

const EMPTY: FormValues = {
  name: '',
  contact_name: '',
  phone: '',
  email: '',
  payment_terms: 'contado',
  notes: '',
};

export default function SupplierFormModal({
  isOpen,
  onClose,
  supplier,
  initialName,
  onSaved,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** Si viene, el modal edita. Si no, crea. */
  supplier?: Supplier | null;
  /** Nombre precargado, para el "crear sin salir de la pantalla". */
  initialName?: string;
  onSaved: (supplier: Supplier, isNew: boolean) => void;
}) {
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: EMPTY });

  useEffect(() => {
    if (!isOpen) return;
    reset(
      supplier
        ? {
            name: supplier.name,
            contact_name: supplier.contact_name ?? '',
            phone: supplier.phone ?? '',
            email: supplier.email ?? '',
            payment_terms: (supplier.payment_terms as FormValues['payment_terms']) ?? 'contado',
            notes: supplier.notes ?? '',
          }
        : { ...EMPTY, name: initialName ?? '' },
    );
  }, [isOpen, supplier, initialName, reset]);

  const onSubmit = async (values: FormValues) => {
    const supabase = createClient();

    const payload = {
      name: values.name,
      contact_name: values.contact_name || null,
      phone: values.phone || null,
      email: values.email || null,
      payment_terms: values.payment_terms,
      notes: values.notes || null,
    };

    if (supplier) {
      const { data, error } = await supabase
        .from('fin_suppliers')
        .update(payload)
        .eq('id', supplier.id)
        .select()
        .single();

      if (error) {
        // El índice único es sobre lower(name): "Kancan" y "kancan" chocan.
        if (error.code === '23505') {
          setError('name', { message: 'Ya existe una marca con ese nombre.' });
          return;
        }
        setError('root', { message: finErrorMessage(error) });
        return;
      }
      onSaved(data as Supplier, false);
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
      .from('fin_suppliers')
      .insert({ ...payload, created_by: user.id })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        setError('name', { message: 'Ya existe una marca con ese nombre.' });
        return;
      }
      setError('root', { message: finErrorMessage(error) });
      return;
    }

    onSaved(data as Supplier, true);
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={supplier ? 'Editar proveedor' : 'Nuevo proveedor'}>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <FinField label="Marca / Proveedor" required error={errors.name?.message}>
          <input
            {...register('name')}
            className={inputClass}
            placeholder="LC Lizette Collection"
            autoFocus
          />
        </FinField>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <FinField label="Contacto" error={errors.contact_name?.message}>
            <input {...register('contact_name')} className={inputClass} placeholder="Nombre de quien atiende" />
          </FinField>

          <FinField label="Teléfono" error={errors.phone?.message}>
            <input {...register('phone')} className={inputClass} placeholder="+1 305 000 0000" />
          </FinField>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <FinField label="Correo" error={errors.email?.message}>
            <input {...register('email')} className={inputClass} placeholder="ventas@marca.com" />
          </FinField>

          <FinField
            label="Condiciones de pago"
            required
            hint="Se usa para proponer el vencimiento de cada compra."
            error={errors.payment_terms?.message}
          >
            <select {...register('payment_terms')} className={inputClass}>
              {Object.entries(PAYMENT_TERMS_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </FinField>
        </div>

        <FinField label="Notas" error={errors.notes?.message}>
          <textarea {...register('notes')} rows={2} className={inputClass} />
        </FinField>

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
            {isSubmitting ? 'Guardando…' : supplier ? 'Guardar cambios' : 'Crear proveedor'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
