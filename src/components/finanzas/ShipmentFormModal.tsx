'use client';

// Alta y edición de una caja de envío.
//
// Es la cabecera: número, alias, agencia, guía, fechas, piezas, peso y la foto
// del comprobante. El CONTENIDO (qué va dentro) se maneja en
// ShipmentDetailModal, porque es lo que más se edita y merece su propia
// pantalla.

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Modal from '@/components/Modal';
import { createClient } from '@/lib/supabase/client';
import { finErrorMessage } from '@/lib/finanzas/errors';
import { caracasToday } from '@/lib/finanzas/dates';
import { uploadFinanzasFile, signedUrl, removeFinanzasFile } from '@/lib/finanzas/storage';
import {
  FinField,
  inputClass,
  btnPrimary,
  btnSecondary,
  SHIPMENT_STATUS_LABEL,
  SHIPMENT_STATUS_ORDER,
} from './ui';

export interface Shipment {
  id: string;
  store_id: string;
  box_number: string;
  alias: string | null;
  status: string;
  courier: string | null;
  tracking_code: string | null;
  sent_date: string | null;
  eta_date: string | null;
  received_date: string | null;
  pieces: number | null;
  weight: number | null;
  weight_unit: string;
  document_path: string | null;
  notes: string | null;
  created_at: string;
}

const schema = z
  .object({
    box_number: z.string().trim().min(1, 'El número de caja es obligatorio'),
    alias: z.string().trim().optional(),
    status: z.enum(SHIPMENT_STATUS_ORDER),
    courier: z.string().trim().optional(),
    tracking_code: z.string().trim().optional(),
    sent_date: z.string().optional(),
    eta_date: z.string().optional(),
    received_date: z.string().optional(),
    pieces: z.string().optional(),
    weight: z.string().optional(),
    weight_unit: z.enum(['kg', 'lb']),
    notes: z.string().trim().optional(),
  })
  // Una caja que llega antes de salir es un dedazo de fechas, y descuadra el
  // "qué está en camino" sin que se note.
  .refine((v) => !v.sent_date || !v.eta_date || v.eta_date >= v.sent_date, {
    message: 'La llegada estimada no puede ser anterior al envío.',
    path: ['eta_date'],
  })
  .refine((v) => !v.sent_date || !v.received_date || v.received_date >= v.sent_date, {
    message: 'La llegada real no puede ser anterior al envío.',
    path: ['received_date'],
  });

type FormValues = z.infer<typeof schema>;

const EMPTY: FormValues = {
  box_number: '',
  alias: '',
  status: 'preparada',
  courier: '',
  tracking_code: '',
  sent_date: '',
  eta_date: '',
  received_date: '',
  pieces: '',
  weight: '',
  weight_unit: 'kg',
  notes: '',
};

const toNum = (s?: string) => {
  if (!s || s.trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

export default function ShipmentFormModal({
  isOpen,
  onClose,
  shipment,
  storeId,
  onSaved,
}: {
  isOpen: boolean;
  onClose: () => void;
  shipment?: Shipment | null;
  storeId: string;
  onSaved: (shipment: Shipment, isNew: boolean) => void;
}) {
  const {
    register,
    handleSubmit,
    reset,
    watch,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: EMPTY });

  const [file, setFile] = useState<File | null>(null);
  const [docPath, setDocPath] = useState<string | null>(null);
  const [docUrl, setDocUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const status = watch('status');

  useEffect(() => {
    if (!isOpen) return;
    setFile(null);
    setDocUrl(null);
    setDocPath(shipment?.document_path ?? null);
    reset(
      shipment
        ? {
            box_number: shipment.box_number,
            alias: shipment.alias ?? '',
            status: (shipment.status as FormValues['status']) ?? 'preparada',
            courier: shipment.courier ?? '',
            tracking_code: shipment.tracking_code ?? '',
            sent_date: shipment.sent_date ?? '',
            eta_date: shipment.eta_date ?? '',
            received_date: shipment.received_date ?? '',
            pieces: shipment.pieces != null ? String(shipment.pieces) : '',
            weight: shipment.weight != null ? String(shipment.weight) : '',
            weight_unit: (shipment.weight_unit as 'kg' | 'lb') ?? 'kg',
            notes: shipment.notes ?? '',
          }
        : { ...EMPTY, sent_date: caracasToday() },
    );
  }, [isOpen, shipment, reset]);

  // La URL firmada se pide en el momento de mostrarla: guardarla en la BD sería
  // guardar algo que caduca.
  useEffect(() => {
    let cancelled = false;
    if (!isOpen || !docPath) {
      setDocUrl(null);
      return;
    }
    signedUrl(docPath).then((u) => {
      if (!cancelled) setDocUrl(u);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, docPath]);

  const onSubmit = async (values: FormValues) => {
    const supabase = createClient();

    const payload = {
      store_id: storeId,
      box_number: values.box_number,
      alias: values.alias || null,
      status: values.status,
      courier: values.courier || null,
      tracking_code: values.tracking_code || null,
      sent_date: values.sent_date || null,
      eta_date: values.eta_date || null,
      received_date: values.received_date || null,
      pieces: toNum(values.pieces),
      weight: toNum(values.weight),
      weight_unit: values.weight_unit,
      notes: values.notes || null,
    };

    let saved: Shipment | null = null;
    let isNew = false;

    if (shipment) {
      const { data, error } = await supabase
        .from('fin_shipments')
        .update(payload)
        .eq('id', shipment.id)
        .select()
        .single();
      if (error) {
        if (error.code === '23505') {
          setError('box_number', { message: 'Ya existe una caja con ese número en esta tienda.' });
          return;
        }
        setError('root', { message: finErrorMessage(error) });
        return;
      }
      saved = data as Shipment;
    } else {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        setError('root', { message: 'Sesión expirada. Vuelve a iniciar sesión.' });
        return;
      }
      const { data, error } = await supabase
        .from('fin_shipments')
        .insert({ ...payload, created_by: user.id })
        .select()
        .single();
      if (error) {
        if (error.code === '23505') {
          setError('box_number', { message: 'Ya existe una caja con ese número en esta tienda.' });
          return;
        }
        setError('root', { message: finErrorMessage(error) });
        return;
      }
      saved = data as Shipment;
      isNew = true;
    }

    // La foto se sube DESPUÉS de tener el id: la ruta lo incluye, y así los
    // adjuntos quedan agrupados por caja. Si falla la subida, la caja ya está
    // guardada y se avisa en vez de perder todo lo escrito.
    if (file && saved) {
      setUploading(true);
      const { path, error } = await uploadFinanzasFile(file, 'shipments', saved.id);
      setUploading(false);
      if (error) {
        setError('root', { message: `La caja se guardó, pero la foto no subió: ${error}` });
      } else if (path) {
        const previous = saved.document_path;
        const { data } = await supabase
          .from('fin_shipments')
          .update({ document_path: path })
          .eq('id', saved.id)
          .select()
          .single();
        if (data) saved = data as Shipment;
        if (previous && previous !== path) await removeFinanzasFile(previous);
      }
    }

    if (saved) {
      onSaved(saved, isNew);
      onClose();
    }
  };

  const clearDocument = async () => {
    if (!shipment || !docPath) return;
    if (!window.confirm('¿Quitar la foto de la guía?')) return;
    const supabase = createClient();
    await supabase.from('fin_shipments').update({ document_path: null }).eq('id', shipment.id);
    await removeFinanzasFile(docPath);
    setDocPath(null);
    setDocUrl(null);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={shipment ? `Caja ${shipment.box_number}` : 'Nueva caja'}
    >
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <FinField label="Número de caja" required error={errors.box_number?.message}>
            <input {...register('box_number')} className={inputClass} placeholder="14" autoFocus />
          </FinField>

          <FinField
            label="Alias"
            className="sm:col-span-2"
            hint="Para reconocerla rápido."
            error={errors.alias?.message}
          >
            <input {...register('alias')} className={inputClass} placeholder="Las grandes de Kancan" />
          </FinField>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <FinField label="Estado" required error={errors.status?.message}>
            <select {...register('status')} className={inputClass}>
              {SHIPMENT_STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {SHIPMENT_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </FinField>

          <FinField label="Agencia / Courier" error={errors.courier?.message}>
            <input {...register('courier')} className={inputClass} placeholder="Zoom, MRW, DHL…" />
          </FinField>

          <FinField label="Guía / Tracking" error={errors.tracking_code?.message}>
            <input {...register('tracking_code')} className={inputClass} placeholder="1Z999AA1..." />
          </FinField>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <FinField label="Fecha de envío" error={errors.sent_date?.message}>
            <input type="date" {...register('sent_date')} className={inputClass} />
          </FinField>

          <FinField label="Llegada estimada" error={errors.eta_date?.message}>
            <input type="date" {...register('eta_date')} className={inputClass} />
          </FinField>

          <FinField
            label="Llegada real"
            hint={
              status === 'recibida' || status === 'recibida_incompleta'
                ? undefined
                : 'Se llena sola al recibir la caja.'
            }
            error={errors.received_date?.message}
          >
            <input type="date" {...register('received_date')} className={inputClass} />
          </FinField>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <FinField label="Piezas" hint="Para cruzarlo al recibir." error={errors.pieces?.message}>
            <input type="number" min="0" step="1" {...register('pieces')} className={inputClass} />
          </FinField>

          <FinField label="Peso declarado" error={errors.weight?.message}>
            <input type="number" min="0" step="0.01" {...register('weight')} className={inputClass} />
          </FinField>

          <FinField label="Unidad" error={errors.weight_unit?.message}>
            <select {...register('weight_unit')} className={inputClass}>
              <option value="kg">Kilogramos</option>
              <option value="lb">Libras</option>
            </select>
          </FinField>
        </div>

        <FinField label="Notas" error={errors.notes?.message}>
          <textarea {...register('notes')} rows={2} className={inputClass} />
        </FinField>

        <FinField
          label="Foto de la guía"
          hint="Opcional. Se comprime antes de subir y solo la puede ver el dueño."
        >
          {docPath ? (
            <div className="flex items-center gap-3">
              {docUrl ? (
                <a
                  href={docUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-teal-700 underline"
                >
                  Ver comprobante adjunto
                </a>
              ) : (
                <span className="text-sm text-slate-400">Cargando vista previa…</span>
              )}
              <button type="button" onClick={clearDocument} className="text-xs text-red-600 cursor-pointer">
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

        {errors.root?.message && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {errors.root.message}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className={btnSecondary}>
            Cancelar
          </button>
          <button type="submit" disabled={isSubmitting || uploading} className={btnPrimary}>
            {uploading ? 'Subiendo foto…' : isSubmitting ? 'Guardando…' : shipment ? 'Guardar cambios' : 'Crear caja'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
