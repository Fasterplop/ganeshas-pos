'use client';

// Proveedores del negocio.
//
// Son GLOBALES, sin store_id: LC Lizette le vende al negocio, no a una
// sucursal. Por eso esta pantalla no depende de la tienda activa.
//
// El estado de cuenta por proveedor (facturas abiertas, saldo, vencimientos)
// llega con el registro de compras; aquí está la ficha, que es lo que hace
// falta para poder decir de qué marca es cada caja.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import FinShell from '@/components/finanzas/FinShell';
import SupplierFormModal, { Supplier } from '@/components/finanzas/SupplierFormModal';
import {
  FinNotice,
  FinStatCard,
  Notice,
  EmptyState,
  btnPrimary,
  btnSecondary,
  inputClass,
} from '@/components/finanzas/ui';
import { fetchAllPages } from '@/lib/finanzas/queries';
import { finErrorMessage } from '@/lib/finanzas/errors';
import { PAYMENT_TERMS_LABEL } from '@/lib/finanzas/money';

export default function ProveedoresPage() {
  const supabase = useMemo(() => createClient(), []);

  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Supplier | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    // Paginado: PostgREST corta en 1000 filas sin avisar.
    const { rows, error } = await fetchAllPages<Supplier>((from, to) =>
      supabase
        .from('fin_suppliers')
        .select('id, name, contact_name, phone, email, payment_terms, notes, is_active')
        .order('name')
        .range(from, to),
    );
    if (error) setNotice({ type: 'error', text: finErrorMessage(error) });
    setSuppliers(rows);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return suppliers.filter((s) => {
      if (!showInactive && !s.is_active) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        (s.contact_name ?? '').toLowerCase().includes(q) ||
        (s.phone ?? '').toLowerCase().includes(q)
      );
    });
  }, [suppliers, search, showInactive]);

  const activeCount = suppliers.filter((s) => s.is_active).length;

  const toggleActive = async (supplier: Supplier) => {
    const next = !supplier.is_active;
    if (
      supplier.is_active &&
      !window.confirm(
        `¿Desactivar "${supplier.name}"?\n\nDeja de aparecer al registrar compras y cajas, pero su historial se conserva.`,
      )
    ) {
      return;
    }

    // Baja lógica, igual que products.is_active en el resto del sistema: un
    // proveedor con compras o cajas asociadas no se puede borrar sin perder
    // historial.
    const { error } = await supabase
      .from('fin_suppliers')
      .update({ is_active: next })
      .eq('id', supplier.id);

    if (error) {
      setNotice({ type: 'error', text: finErrorMessage(error) });
      return;
    }
    setSuppliers((prev) =>
      prev.map((s) => (s.id === supplier.id ? { ...s, is_active: next } : s)),
    );
    setNotice({
      type: 'success',
      text: next ? `"${supplier.name}" reactivado.` : `"${supplier.name}" desactivado.`,
    });
  };

  const handleSaved = (saved: Supplier, isNew: boolean) => {
    setSuppliers((prev) => {
      const next = isNew ? [...prev, saved] : prev.map((s) => (s.id === saved.id ? saved : s));
      return next.sort((a, b) => a.name.localeCompare(b.name, 'es'));
    });
    setNotice({
      type: 'success',
      text: isNew ? `Proveedor "${saved.name}" creado.` : `"${saved.name}" actualizado.`,
    });
  };

  return (
    <FinShell
      title="Proveedores"
      subtitle="Las marcas a las que le compras. Son del negocio completo, no de una sucursal."
      actions={
        <button
          className={btnPrimary}
          onClick={() => {
            setEditing(null);
            setModalOpen(true);
          }}
        >
          + Nuevo proveedor
        </button>
      }
    >
      <div className="space-y-5">
        <FinNotice notice={notice} onClose={() => setNotice(null)} />

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <FinStatCard label="Proveedores activos" value={activeCount} tone="teal" />
          <FinStatCard
            label="Inactivos"
            value={suppliers.length - activeCount}
            sub="Conservan su historial"
          />
          <FinStatCard
            label="A crédito"
            value={suppliers.filter((s) => s.is_active && s.payment_terms !== 'contado').length}
            sub="15 días, 30 días o consignación"
          />
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200">
          <div className="p-4 border-b border-slate-100 flex flex-wrap gap-3 items-center">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por marca, contacto o teléfono…"
              className={`${inputClass} max-w-sm`}
            />
            <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
                className="rounded border-slate-300"
              />
              Ver inactivos
            </label>
            <span className="ml-auto text-xs text-slate-400">
              {visible.length} {visible.length === 1 ? 'proveedor' : 'proveedores'}
            </span>
          </div>

          {loading ? (
            <div className="py-16 text-center text-slate-400 text-sm">Cargando proveedores…</div>
          ) : visible.length === 0 ? (
            <EmptyState
              title={search ? 'Ningún proveedor coincide con la búsqueda.' : 'Todavía no hay proveedores.'}
              hint={
                search
                  ? undefined
                  : 'Empieza por las marcas que más compras: LC Lizette Collection, Kancan, THML, Blu Blush, Rubienn.'
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[760px]">
                <thead className="bg-slate-100 text-slate-600">
                  <tr>
                    <th className="text-left font-semibold px-4 py-3">Marca</th>
                    <th className="text-left font-semibold px-4 py-3">Contacto</th>
                    <th className="text-left font-semibold px-4 py-3">Teléfono</th>
                    <th className="text-left font-semibold px-4 py-3">Condiciones</th>
                    <th className="text-right font-semibold px-4 py-3">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visible.map((s) => (
                    <tr key={s.id} className={`hover:bg-slate-50 ${!s.is_active ? 'opacity-55' : ''}`}>
                      <td className="px-4 py-3">
                        <div className="font-semibold text-slate-800">{s.name}</div>
                        {s.email && <div className="text-xs text-slate-400">{s.email}</div>}
                        {!s.is_active && (
                          <span className="text-[10px] uppercase tracking-wide font-bold text-slate-500">
                            Inactivo
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-slate-600">{s.contact_name || '—'}</td>
                      <td className="px-4 py-3 text-slate-600">{s.phone || '—'}</td>
                      <td className="px-4 py-3 text-slate-600">
                        {PAYMENT_TERMS_LABEL[s.payment_terms] ?? s.payment_terms}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-2">
                          <button
                            className={btnSecondary}
                            onClick={() => {
                              setEditing(s);
                              setModalOpen(true);
                            }}
                          >
                            Editar
                          </button>
                          <button className={btnSecondary} onClick={() => toggleActive(s)}>
                            {s.is_active ? 'Desactivar' : 'Reactivar'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <SupplierFormModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        supplier={editing}
        onSaved={handleSaved}
      />
    </FinShell>
  );
}
