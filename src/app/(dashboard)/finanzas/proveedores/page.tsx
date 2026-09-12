'use client';

// Proveedores del negocio y sus cuentas por pagar.
//
// Son GLOBALES, sin store_id: LC Lizette le vende al negocio, no a una
// sucursal. Por eso esta pantalla no depende de la tienda activa.
//
// Los saldos vienen de la vista fin_v_supplier_balance, que ya excluye lo
// personal: el dinero de la tienda y el personal no se mezclan.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import FinShell from '@/components/finanzas/FinShell';
import SupplierFormModal, { Supplier } from '@/components/finanzas/SupplierFormModal';
import SupplierStatementModal from '@/components/finanzas/SupplierStatementModal';
import {
  FinNotice,
  FinStatCard,
  Notice,
  EmptyState,
  DueBadge,
  btnPrimary,
  btnSecondary,
  inputClass,
} from '@/components/finanzas/ui';
import { fetchAllPages } from '@/lib/finanzas/queries';
import { finErrorMessage } from '@/lib/finanzas/errors';
import { PAYMENT_TERMS_LABEL, fmtUSD } from '@/lib/finanzas/money';

interface BalanceRow {
  supplier_id: string;
  open_invoices: number;
  balance_usd: number;
  next_due_date: string | null;
  total_purchased_usd: number;
  last_purchase_date: string | null;
}

export default function ProveedoresPage() {
  const supabase = useMemo(() => createClient(), []);

  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [balances, setBalances] = useState<Map<string, BalanceRow>>(new Map());
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [onlyDebt, setOnlyDebt] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Supplier | null>(null);
  const [statement, setStatement] = useState<Supplier | null>(null);

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
    if (error) {
      setNotice({ type: 'error', text: finErrorMessage(error) });
      setLoading(false);
      return;
    }

    const { rows: bal } = await fetchAllPages<BalanceRow>((from, to) =>
      supabase
        .from('fin_v_supplier_balance')
        .select('supplier_id, open_invoices, balance_usd, next_due_date, total_purchased_usd, last_purchase_date')
        .range(from, to),
    );

    setSuppliers(rows);
    setBalances(new Map(bal.map((b) => [b.supplier_id, b])));
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  const bal = useCallback((id: string) => balances.get(id), [balances]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return suppliers.filter((s) => {
      if (!showInactive && !s.is_active) return false;
      if (onlyDebt && Number(bal(s.id)?.balance_usd ?? 0) <= 0) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        (s.contact_name ?? '').toLowerCase().includes(q) ||
        (s.phone ?? '').toLowerCase().includes(q)
      );
    });
  }, [suppliers, search, showInactive, onlyDebt, bal]);

  const activeCount = suppliers.filter((s) => s.is_active).length;
  const deudaTotal = useMemo(
    () => [...balances.values()].reduce((a, b) => a + Number(b.balance_usd), 0),
    [balances],
  );
  const conDeuda = useMemo(
    () => [...balances.values()].filter((b) => Number(b.balance_usd) > 0).length,
    [balances],
  );

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
    setSuppliers((prev) => prev.map((s) => (s.id === supplier.id ? { ...s, is_active: next } : s)));
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
      subtitle="Las marcas a las que le compras, con lo que les debes y cuándo vence."
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

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <FinStatCard
            label="Les debes"
            value={fmtUSD(deudaTotal)}
            tone={deudaTotal > 0 ? 'amber' : 'default'}
            sub={`${conDeuda} ${conDeuda === 1 ? 'marca con saldo' : 'marcas con saldo'}`}
            active={onlyDebt}
            onClick={() => setOnlyDebt(!onlyDebt)}
          />
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
          <div className="p-3 sm:p-4 border-b border-slate-100 flex flex-wrap gap-3 items-center">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por marca, contacto o teléfono…"
              className={`${inputClass} sm:max-w-sm`}
            />
            <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
              <input
                type="checkbox"
                checked={onlyDebt}
                onChange={(e) => setOnlyDebt(e.target.checked)}
                className="rounded border-slate-300"
              />
              Solo con saldo
            </label>
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
              title={
                search || onlyDebt
                  ? 'Ningún proveedor coincide con el filtro.'
                  : 'Todavía no hay proveedores.'
              }
              hint={
                search || onlyDebt
                  ? undefined
                  : 'Empieza por las marcas que más compras: LC Lizette Collection, Kancan, THML, Blu Blush, Rubienn.'
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-100 text-slate-600">
                  <tr>
                    <th className="text-left font-semibold px-3 sm:px-4 py-3">Marca</th>
                    <th className="text-left font-semibold px-4 py-3 hidden md:table-cell">Contacto</th>
                    <th className="text-left font-semibold px-4 py-3 hidden lg:table-cell">
                      Condiciones
                    </th>
                    <th className="text-right font-semibold px-3 sm:px-4 py-3">Saldo</th>
                    <th className="text-center font-semibold px-4 py-3 hidden sm:table-cell">Vence</th>
                    <th className="text-right font-semibold px-3 sm:px-4 py-3">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visible.map((s) => {
                    const b = bal(s.id);
                    const saldo = Number(b?.balance_usd ?? 0);
                    return (
                      <tr key={s.id} className={`hover:bg-slate-50 ${!s.is_active ? 'opacity-55' : ''}`}>
                        <td className="px-3 sm:px-4 py-3">
                          <button
                            onClick={() => setStatement(s)}
                            className="font-semibold text-slate-800 hover:text-teal-700 cursor-pointer text-left"
                          >
                            {s.name}
                          </button>
                          {s.email && (
                            <div className="text-xs text-slate-400 hidden md:block">{s.email}</div>
                          )}
                          <div className="lg:hidden text-xs text-slate-500 mt-0.5">
                            {PAYMENT_TERMS_LABEL[s.payment_terms] ?? s.payment_terms}
                            {s.phone && <span className="md:hidden"> · {s.phone}</span>}
                          </div>
                          {b?.next_due_date && saldo > 0 && (
                            <div className="sm:hidden mt-1">
                              <DueBadge dueDate={b.next_due_date} />
                            </div>
                          )}
                          {!s.is_active && (
                            <span className="text-[10px] uppercase tracking-wide font-bold text-slate-500">
                              Inactivo
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-slate-600 hidden md:table-cell">
                          {s.contact_name || '—'}
                          {s.phone && <div className="text-xs text-slate-400">{s.phone}</div>}
                        </td>
                        <td className="px-4 py-3 text-slate-600 hidden lg:table-cell">
                          {PAYMENT_TERMS_LABEL[s.payment_terms] ?? s.payment_terms}
                        </td>
                        <td
                          className={`px-3 sm:px-4 py-3 text-right font-semibold whitespace-nowrap ${
                            saldo > 0 ? 'text-red-600' : 'text-slate-300'
                          }`}
                        >
                          {saldo > 0 ? fmtUSD(saldo) : '—'}
                          {saldo > 0 && b && (
                            <div className="text-[10px] text-slate-400 font-normal">
                              {b.open_invoices} {b.open_invoices === 1 ? 'factura' : 'facturas'}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-center hidden sm:table-cell">
                          {b?.next_due_date ? (
                            <DueBadge dueDate={b.next_due_date} />
                          ) : (
                            <span className="text-slate-300">—</span>
                          )}
                        </td>
                        <td className="px-3 sm:px-4 py-3">
                          <div className="flex flex-wrap justify-end gap-2">
                            <button className={btnSecondary} onClick={() => setStatement(s)}>
                              <span className="sm:hidden">Cuenta</span>
                              <span className="hidden sm:inline">Estado de cuenta</span>
                            </button>
                            <button
                              className={`${btnSecondary} hidden sm:inline-block`}
                              onClick={() => {
                                setEditing(s);
                                setModalOpen(true);
                              }}
                            >
                              Editar
                            </button>
                            <button
                              className={`${btnSecondary} hidden lg:inline-block`}
                              onClick={() => toggleActive(s)}
                            >
                              {s.is_active ? 'Desactivar' : 'Reactivar'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
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

      <SupplierStatementModal
        isOpen={!!statement}
        onClose={() => {
          setStatement(null);
          load();
        }}
        supplier={statement}
      />
    </FinShell>
  );
}
