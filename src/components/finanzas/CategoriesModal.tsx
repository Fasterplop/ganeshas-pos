'use client';

// Categorías de gasto y de compra.
//
// La propuesta dice que todo es autogestionable: el cliente crea y edita sus
// propias categorías sin depender de nosotros. Por eso esto vive en la app y
// no en un archivo SQL.
//
// Las categorías NO se borran, se desactivan: una categoría borrada dejaría
// sin clasificar los gastos viejos que la usaban.

import { useEffect, useState } from 'react';
import Modal from '@/components/Modal';
import { createClient } from '@/lib/supabase/client';
import { finErrorMessage } from '@/lib/finanzas/errors';
import type { Category } from './ExpenseFormModal';
import { FinNotice, Notice, inputClass, btnPrimary, btnSecondary } from './ui';

export default function CategoriesModal({
  isOpen,
  onClose,
  categories,
  onChanged,
}: {
  isOpen: boolean;
  onClose: () => void;
  categories: Category[];
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<Category[]>(categories);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<'gasto' | 'compra'>('gasto');

  useEffect(() => {
    if (isOpen) {
      setRows(categories);
      setNotice(null);
    }
  }, [isOpen, categories]);

  const create = async () => {
    const name = newName.trim();
    if (name.length < 2) {
      setNotice({ type: 'error', text: 'Escribe el nombre de la categoría.' });
      return;
    }
    setBusy(true);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { data, error } = await supabase
      .from('fin_categories')
      .insert({
        name,
        kind: newKind,
        sort_order: (rows.length + 1) * 10,
        created_by: user?.id,
      })
      .select()
      .single();
    setBusy(false);

    if (error) {
      setNotice({
        type: 'error',
        text: error.code === '23505' ? 'Ya existe una categoría con ese nombre.' : finErrorMessage(error),
      });
      return;
    }
    setRows((p) => [...p, data as Category]);
    setNewName('');
    setNotice({ type: 'success', text: `Categoría "${name}" creada.` });
    onChanged();
  };

  const rename = async (cat: Category, name: string) => {
    const trimmed = name.trim();
    if (trimmed.length < 2 || trimmed === cat.name) return;
    const supabase = createClient();
    const { error } = await supabase.from('fin_categories').update({ name: trimmed }).eq('id', cat.id);
    if (error) {
      setNotice({
        type: 'error',
        text: error.code === '23505' ? 'Ya existe una categoría con ese nombre.' : finErrorMessage(error),
      });
      return;
    }
    setRows((p) => p.map((c) => (c.id === cat.id ? { ...c, name: trimmed } : c)));
    onChanged();
  };

  const toggle = async (cat: Category) => {
    const next = !cat.is_active;
    const supabase = createClient();
    const { error } = await supabase.from('fin_categories').update({ is_active: next }).eq('id', cat.id);
    if (error) {
      setNotice({ type: 'error', text: finErrorMessage(error) });
      return;
    }
    setRows((p) => p.map((c) => (c.id === cat.id ? { ...c, is_active: next } : c)));
    onChanged();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Categorías">
      <div className="space-y-4">
        <FinNotice notice={notice} onClose={() => setNotice(null)} />

        <p className="text-sm text-slate-500">
          Las de <strong>gasto</strong> son lo operativo (alquiler, nómina, servicios). Las de{' '}
          <strong>compra</strong> son mercancía y flete. Una categoría no se borra: se desactiva, para
          no dejar sin clasificar lo que ya se registró con ella.
        </p>

        <div className="overflow-x-auto border border-slate-200 rounded-lg">
          <table className="w-full text-sm min-w-[440px]">
            <thead className="bg-slate-100 text-slate-600">
              <tr>
                <th className="text-left font-semibold px-3 py-2">Nombre</th>
                <th className="text-left font-semibold px-3 py-2 w-28">Tipo</th>
                <th className="text-right font-semibold px-3 py-2 w-32">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((c) => (
                <tr key={c.id} className={`hover:bg-slate-50 ${!c.is_active ? 'opacity-55' : ''}`}>
                  <td className="px-3 py-2">
                    <input
                      defaultValue={c.name}
                      onBlur={(e) => rename(c, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      }}
                      className={`${inputClass} py-1`}
                    />
                  </td>
                  <td className="px-3 py-2 text-slate-600">
                    {c.kind === 'compra' ? 'Compra' : 'Gasto'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => toggle(c)} className="text-xs text-teal-700 hover:underline cursor-pointer">
                      {c.is_active ? 'Desactivar' : 'Reactivar'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_130px_auto] gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                create();
              }
            }}
            placeholder="Nueva categoría"
            className={inputClass}
          />
          <select
            value={newKind}
            onChange={(e) => setNewKind(e.target.value as 'gasto' | 'compra')}
            className={inputClass}
          >
            <option value="gasto">Gasto</option>
            <option value="compra">Compra</option>
          </select>
          <button onClick={create} disabled={busy} className={btnSecondary}>
            Crear
          </button>
        </div>

        <div className="flex justify-end">
          <button onClick={onClose} className={btnPrimary}>
            Listo
          </button>
        </div>
      </div>
    </Modal>
  );
}
