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

/** Cuántas cajas físicas de cada tamaño van en el envío. */
export interface ShipmentBox {
  id: string;
  shipment_id: string;
  size: string;
  quantity: number;
  sort_order: number;
}

/** Sugerencias, no una lista cerrada: cada courier tiene sus nombres. */
const TAMANOS = ['Pequeña', 'Mediana', 'Grande', 'Extra grande'];

interface BoxRow {
  key: string;
  size: string;
  quantity: string;
}

const newBoxRow = (): BoxRow => ({ key: crypto.randomUUID(), size: '', quantity: '1' });

export interface Shipment {
  id: string;
  alias: string;
  status: string;
  tracking_code: string | null;
  sent_date: string | null;
  received_date: string | null;
  document_path: string | null;
  notes: string | null;
  created_at: string;
}

const schema = z.object({
  alias: z.string().trim().min(2, 'Ponle un nombre para reconocerla'),
  status: z.enum(SHIPMENT_STATUS_ORDER),
  tracking_code: z.string().trim().optional(),
  sent_date: z.string().optional(),
  notes: z.string().trim().optional(),
});

type FormValues = z.infer<typeof schema>;

const EMPTY: FormValues = {
  alias: '',
  status: 'preparada',
  tracking_code: '',
  sent_date: '',
  notes: '',
};

export default function ShipmentFormModal({
  isOpen,
  onClose,
  shipment,
  onSaved,
}: {
  isOpen: boolean;
  onClose: () => void;
  shipment?: Shipment | null;
  onSaved: (shipment: Shipment, isNew: boolean) => void;
}) {
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: EMPTY });

  const [file, setFile] = useState<File | null>(null);
  const [docPath, setDocPath] = useState<string | null>(null);
  const [docUrl, setDocUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [boxes, setBoxes] = useState<BoxRow[]>([newBoxRow()]);

  const totalCajas = boxes.reduce(
    (a, b) => a + (b.size.trim() ? Math.max(1, Math.round(Number(b.quantity) || 1)) : 0),
    0,
  );

  useEffect(() => {
    if (!isOpen) return;
    setFile(null);
    setDocUrl(null);
    setDocPath(shipment?.document_path ?? null);
    reset(
      shipment
        ? {
            alias: shipment.alias,
            status: (shipment.status as FormValues['status']) ?? 'preparada',
            tracking_code: shipment.tracking_code ?? '',
            sent_date: shipment.sent_date ?? '',
            notes: shipment.notes ?? '',
          }
        : { ...EMPTY, sent_date: caracasToday() },
    );

    // Al editar se traen las cajas físicas que ya tenía; al crear se arranca
    // con una fila vacía para que se vea que el campo existe.
    if (!shipment) {
      setBoxes([newBoxRow()]);
      return;
    }
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from('fin_shipment_boxes')
        .select('id, shipment_id, size, quantity, sort_order')
        .eq('shipment_id', shipment.id)
        .order('sort_order');
      if (cancelled) return;
      const rows = (data ?? []) as ShipmentBox[];
      setBoxes(
        rows.length > 0
          ? rows.map((b) => ({ key: b.id, size: b.size, quantity: String(b.quantity) }))
          : [newBoxRow()],
      );
    })();
    return () => {
      cancelled = true;
    };
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
      alias: values.alias,
      status: values.status,
      tracking_code: values.tracking_code || null,
      sent_date: values.sent_date || null,
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
        setError('root', { message: finErrorMessage(error) });
        return;
      }
      saved = data as Shipment;
      isNew = true;
    }

    // Las cajas físicas se reescriben enteras: son dos o tres filas y el
    // formulario las edita como un bloque, así que borrar e insertar es más
    // simple y más difícil de equivocar que reconciliar fila por fila.
    if (saved) {
      // Se copia a una const: dentro del callback de .map, TypeScript pierde el
      // estrechamiento de `saved` por ser `let`.
      const shipmentId = saved.id;
      const validas = boxes
        .map((b, i) => ({
          size: b.size.trim(),
          quantity: Math.max(1, Math.round(Number(b.quantity) || 1)),
          sort_order: i,
        }))
        .filter((b) => b.size !== '');

      await supabase.from('fin_shipment_boxes').delete().eq('shipment_id', shipmentId);
      if (validas.length > 0) {
        const { error: boxError } = await supabase
          .from('fin_shipment_boxes')
          .insert(validas.map((b) => ({ ...b, shipment_id: shipmentId })));
        if (boxError) {
          setError('root', {
            message: `El envío se guardó, pero las cajas no: ${finErrorMessage(boxError)}`,
          });
        }
      }
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
      title={shipment ? shipment.alias : 'Nueva caja'}
    >
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <FinField
          label="Nombre de la caja"
          required
          hint="Como la reconoces tú: la marca, el pedido, lo que sea."
          error={errors.alias?.message}
        >
          <input
            {...register('alias')}
            className={inputClass}
            placeholder="Las grandes de Kancan"
            autoFocus
          />
        </FinField>

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

          <FinField label="Fecha de envío" error={errors.sent_date?.message}>
            <input type="date" {...register('sent_date')} className={inputClass} />
          </FinField>

          <FinField label="Guía / Tracking" error={errors.tracking_code?.message}>
            <input {...register('tracking_code')} className={inputClass} placeholder="1Z999AA1..." />
          </FinField>
        </div>

        <p className="text-xs text-slate-400 -mt-1">
          La fecha de llegada no se pide aquí: se guarda sola cuando marcas el envío como recibido.
        </p>

        {/* --- Cuántas cajas físicas y de qué tamaño --- */}
        <div className="border border-slate-200 rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <label className="block text-xs font-bold uppercase tracking-wide text-slate-500">
              Cajas del envío
            </label>
            <span className="text-xs text-slate-400">
              {totalCajas > 0
                ? `${totalCajas} ${totalCajas === 1 ? 'caja' : 'cajas'} en total`
                : 'Sin cajas'}
            </span>
          </div>

          <datalist id="fin-tamanos-caja">
            {TAMANOS.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>

          {boxes.map((b, i) => (
            <div key={b.key} className="grid grid-cols-[minmax(0,1fr)_80px_auto] gap-2">
              <input
                value={b.size}
                onChange={(e) =>
                  setBoxes((p) => p.map((x, j) => (j === i ? { ...x, size: e.target.value } : x)))
                }
                list="fin-tamanos-caja"
                placeholder="Tamaño (Grande, Mediana…)"
                className={inputClass}
              />
              <input
                type="number"
                min="1"
                step="1"
                value={b.quantity}
                onChange={(e) =>
                  setBoxes((p) => p.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))
                }
                className={`${inputClass} text-center`}
                aria-label="Cantidad"
              />
              <button
                type="button"
                onClick={() =>
                  setBoxes((p) => (p.length === 1 ? [newBoxRow()] : p.filter((_, j) => j !== i)))
                }
                className="text-slate-400 hover:text-red-600 px-2 cursor-pointer"
                title="Quitar tamaño"
              >
                ✕
              </button>
            </div>
          ))}

          <button
            type="button"
            onClick={() => setBoxes((p) => [...p, newBoxRow()])}
            className="text-sm text-teal-700 hover:underline cursor-pointer"
          >
            + Otro tamaño
          </button>
          <p className="text-xs text-slate-400">
            Si el envío son 2 grandes y 1 mediana, van dos filas. Los tamaños sin nombre no se
            guardan.
          </p>
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
