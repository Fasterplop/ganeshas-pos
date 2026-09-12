'use client';

// Contenido de una caja y su recepción.
//
// Esto es lo que el cliente pidió con más énfasis: hoy envía varias cajas en
// días distintos, anota en notas sueltas qué llevó cada una y se le pierde.
//
// El contenido se puede escribir a mano (con su marca) y, cuando la compra
// existe, ENLAZARLO a ella. El enlace no mueve dinero: el gasto vive en
// fin_expenses y los reportes suman de ahí, así que una compra repartida en
// tres cajas se cuenta UNA vez. `allocated_usd` es solo informativo, para
// saber cuánta mercancía viaja en cada caja.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Modal from '@/components/Modal';
import { createClient } from '@/lib/supabase/client';
import { finErrorMessage } from '@/lib/finanzas/errors';
import { caracasToday, formatDate } from '@/lib/finanzas/dates';
import { fetchAllPages } from '@/lib/finanzas/queries';
import { fmtUSD, round2 } from '@/lib/finanzas/money';
import type { Supplier } from './SupplierFormModal';
import type { Shipment } from './ShipmentFormModal';
import type { Account } from './AccountFormModal';
import type { Expense } from './ExpenseFormModal';
import ShipmentCostSection from './ShipmentCostSection';
import {
  FinNotice,
  Notice,
  ShipmentStatusBadge,
  inputClass,
  btnPrimary,
  btnSecondary,
  btnDanger,
  EmptyState,
} from './ui';

export interface ShipmentItem {
  id: string;
  shipment_id: string;
  expense_id: string | null;
  supplier_id: string | null;
  purchase_line_id: string | null;
  description: string | null;
  pieces: number | null;
  received_pieces: number | null;
  is_received: boolean;
  allocated_usd: number | null;
  notes: string | null;
}

const toNum = (s: string) => {
  if (!s || s.trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

export default function ShipmentDetailModal({
  isOpen,
  onClose,
  shipment,
  suppliers,
  accounts,
  envioCategoryId,
  onShipmentChanged,
}: {
  isOpen: boolean;
  onClose: () => void;
  shipment: Shipment | null;
  suppliers: Supplier[];
  accounts: Account[];
  envioCategoryId: string | null;
  onShipmentChanged: (shipment: Shipment) => void;
}) {
  const supabase = useMemo(() => createClient(), []);

  const [items, setItems] = useState<ShipmentItem[]>([]);
  const [purchases, setPurchases] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  // Alta de una línea de contenido.
  const [newSupplier, setNewSupplier] = useState('');
  const [newExpense, setNewExpense] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newPieces, setNewPieces] = useState('');
  const [newAmount, setNewAmount] = useState('');

  // Enlace de una línea ya existente a su compra.
  const [linking, setLinking] = useState<string | null>(null);

  // Modo recepción.
  const [receiving, setReceiving] = useState(false);
  const [receivedDate, setReceivedDate] = useState('');
  const [draft, setDraft] = useState<Record<string, { ok: boolean; got: string }>>({});

  const supplierName = useCallback(
    (id: string | null) => suppliers.find((s) => s.id === id)?.name ?? null,
    [suppliers],
  );
  const purchaseOf = useCallback(
    (id: string | null) => purchases.find((p) => p.id === id) ?? null,
    [purchases],
  );

  const load = useCallback(async () => {
    if (!shipment) return;
    setLoading(true);

    const { rows, error } = await fetchAllPages<ShipmentItem>((from, to) =>
      supabase
        .from('fin_shipment_items')
        .select(
          'id, shipment_id, expense_id, supplier_id, purchase_line_id, description, pieces, received_pieces, is_received, allocated_usd, notes',
        )
        .eq('shipment_id', shipment.id)
        .order('created_at')
        .range(from, to),
    );
    if (error) setNotice({ type: 'error', text: finErrorMessage(error) });
    setItems(rows);

    // Las compras de la misma tienda, para poder enlazar el contenido.
    const { rows: comp } = await fetchAllPages<Expense>((from, to) =>
      supabase
        .from('fin_expenses')
        .select(
          'id, store_id, kind, supplier_id, category_id, shipment_id, description, currency, amount, bcv_rate, amount_usd, expense_date, due_date, paid_usd, status, is_personal, receipt_path, notes, created_at',
        )
        .eq('kind', 'compra')
        .eq('is_personal', false)
        .eq('store_id', shipment.store_id)
        .order('expense_date', { ascending: false })
        .range(from, to),
    );
    setPurchases(comp);

    setLoading(false);
  }, [shipment, supabase]);

  useEffect(() => {
    if (!isOpen || !shipment) return;
    setReceiving(false);
    setNotice(null);
    setLinking(null);
    setNewSupplier('');
    setNewExpense('');
    setNewDesc('');
    setNewPieces('');
    setNewAmount('');
    load();
  }, [isOpen, shipment, load]);

  /** Cuánto de esa compra ya está repartido en otras cajas. */
  const allocatedElsewhere = useCallback(
    async (expenseId: string, exceptItemId?: string) => {
      const { data } = await supabase
        .from('fin_shipment_items')
        .select('id, allocated_usd')
        .eq('expense_id', expenseId);
      return (data ?? [])
        .filter((r) => r.id !== exceptItemId)
        .reduce((a, r) => a + Number(r.allocated_usd ?? 0), 0);
    },
    [supabase],
  );

  /**
   * Avisa si lo repartido pasa del total de la compra. Es un aviso, no un
   * bloqueo: el reparto es informativo y el gasto real nunca depende de él.
   */
  const checkAllocation = async (expenseId: string, amount: number, exceptItemId?: string) => {
    const exp = purchaseOf(expenseId);
    if (!exp || amount <= 0) return true;
    const otros = await allocatedElsewhere(expenseId, exceptItemId);
    const total = round2(otros + amount);
    if (total > Number(exp.amount_usd) + 0.005) {
      return window.confirm(
        `Estás repartiendo ${fmtUSD(total)} de una compra de ${fmtUSD(exp.amount_usd)}.\n\n` +
          'El gasto del mes no cambia (se cuenta una sola vez), pero el reparto por caja quedaría mal. ¿Guardar igual?',
      );
    }
    return true;
  };

  const addItem = async () => {
    if (!shipment) return;
    const exp = newExpense ? purchaseOf(newExpense) : null;
    const desc = newDesc.trim() || (exp ? exp.description || 'Mercancía de la compra' : '');
    if (!desc) {
      setNotice({ type: 'error', text: 'Escribe qué va dentro (por ejemplo: 10 blusas Kancan).' });
      return;
    }

    const monto = toNum(newAmount) ?? 0;
    if (newExpense && monto > 0 && !(await checkAllocation(newExpense, monto))) return;

    setBusy(true);
    const { data, error } = await supabase
      .from('fin_shipment_items')
      .insert({
        shipment_id: shipment.id,
        expense_id: newExpense || null,
        supplier_id: newSupplier || exp?.supplier_id || null,
        description: desc,
        pieces: toNum(newPieces),
        allocated_usd: monto > 0 ? monto : null,
      })
      .select()
      .single();
    setBusy(false);

    if (error) {
      setNotice({ type: 'error', text: finErrorMessage(error) });
      return;
    }
    setItems((prev) => [...prev, data as ShipmentItem]);
    setNewDesc('');
    setNewPieces('');
    setNewAmount('');
    setNewExpense('');
    // La marca se deja puesta: casi siempre se cargan varias líneas seguidas
    // del mismo proveedor.
  };

  const linkToPurchase = async (item: ShipmentItem, expenseId: string, amountRaw: string) => {
    const monto = toNum(amountRaw) ?? 0;
    if (expenseId && monto > 0 && !(await checkAllocation(expenseId, monto, item.id))) return;

    const exp = expenseId ? purchaseOf(expenseId) : null;
    const { data, error } = await supabase
      .from('fin_shipment_items')
      .update({
        expense_id: expenseId || null,
        supplier_id: item.supplier_id ?? exp?.supplier_id ?? null,
        allocated_usd: monto > 0 ? monto : null,
      })
      .eq('id', item.id)
      .select()
      .single();

    if (error) {
      setNotice({ type: 'error', text: finErrorMessage(error) });
      return;
    }
    setItems((prev) => prev.map((i) => (i.id === item.id ? (data as ShipmentItem) : i)));
    setLinking(null);
    setNotice({
      type: 'success',
      text: expenseId ? 'Línea enlazada a su compra.' : 'Enlace quitado.',
    });
  };

  const deleteItem = async (item: ShipmentItem) => {
    if (!window.confirm('¿Quitar esta línea del contenido de la caja?')) return;
    const { error } = await supabase.from('fin_shipment_items').delete().eq('id', item.id);
    if (error) {
      setNotice({ type: 'error', text: finErrorMessage(error) });
      return;
    }
    setItems((prev) => prev.filter((i) => i.id !== item.id));
  };

  const startReceiving = () => {
    setReceivedDate(shipment?.received_date || caracasToday());
    setDraft(
      Object.fromEntries(
        items.map((i) => [
          i.id,
          {
            ok: i.is_received,
            got:
              i.received_pieces != null
                ? String(i.received_pieces)
                : i.pieces != null
                  ? String(i.pieces)
                  : '',
          },
        ]),
      ),
    );
    setReceiving(true);
  };

  const confirmReceive = async () => {
    if (!shipment) return;
    setBusy(true);

    // Cada línea guarda si llegó y cuántas piezas. Es lo que después permite
    // ver exactamente qué falta sin volver a abrir la caja física.
    for (const item of items) {
      const d = draft[item.id];
      if (!d) continue;
      const got = toNum(d.got);
      const { error } = await supabase
        .from('fin_shipment_items')
        .update({ is_received: d.ok, received_pieces: d.ok ? got : null })
        .eq('id', item.id);
      if (error) {
        setBusy(false);
        setNotice({ type: 'error', text: finErrorMessage(error) });
        return;
      }
    }

    // El estado NO lo elige el usuario aquí: lo dicta lo que realmente llegó.
    // Una caja con una línea faltante o con menos piezas de las enviadas queda
    // "recibida incompleta", que es justo el caso que hoy se pierde.
    const complete = items.every((i) => {
      const d = draft[i.id];
      if (!d?.ok) return false;
      const got = toNum(d.got);
      if (i.pieces != null && got != null) return got >= i.pieces;
      return true;
    });
    const nextStatus = items.length === 0 || complete ? 'recibida' : 'recibida_incompleta';

    const { data, error } = await supabase
      .from('fin_shipments')
      .update({ status: nextStatus, received_date: receivedDate || caracasToday() })
      .eq('id', shipment.id)
      .select()
      .single();

    setBusy(false);
    if (error) {
      setNotice({ type: 'error', text: finErrorMessage(error) });
      return;
    }

    onShipmentChanged(data as Shipment);
    setReceiving(false);
    await load();
    setNotice({
      type: nextStatus === 'recibida' ? 'success' : 'info',
      text:
        nextStatus === 'recibida'
          ? 'Caja recibida completa.'
          : 'Caja marcada como recibida incompleta. Lo que falta queda a la vista abajo.',
    });
  };

  const missing = items.filter(
    (i) => !i.is_received || (i.pieces != null && (i.received_pieces ?? 0) < i.pieces),
  );
  const isReceived = shipment?.status === 'recibida' || shipment?.status === 'recibida_incompleta';
  const totalPieces = items.reduce((acc, i) => acc + (i.pieces ?? 0), 0);
  const totalAllocated = items.reduce((acc, i) => acc + Number(i.allocated_usd ?? 0), 0);

  const purchaseOptions = useMemo(() => {
    const list = newSupplier ? purchases.filter((p) => p.supplier_id === newSupplier) : purchases;
    return list;
  }, [purchases, newSupplier]);

  if (!shipment) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Caja ${shipment.box_number}${shipment.alias ? ` — ${shipment.alias}` : ''}`}
    >
      <div className="space-y-5">
        <FinNotice notice={notice} onClose={() => setNotice(null)} />

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm bg-slate-50 border border-slate-200 rounded-lg px-4 py-3">
          <ShipmentStatusBadge status={shipment.status} />
          {shipment.courier && (
            <span className="text-slate-600">
              <span className="text-slate-400">Agencia:</span> {shipment.courier}
            </span>
          )}
          {shipment.tracking_code && (
            <span className="text-slate-600">
              <span className="text-slate-400">Guía:</span> {shipment.tracking_code}
            </span>
          )}
          <span className="text-slate-600">
            <span className="text-slate-400">Enviada:</span> {formatDate(shipment.sent_date)}
          </span>
          <span className="text-slate-600">
            <span className="text-slate-400">{isReceived ? 'Llegó:' : 'Llegada estimada:'}</span>{' '}
            {formatDate(isReceived ? shipment.received_date : shipment.eta_date)}
          </span>
        </div>

        {/* --- Contenido --- */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-bold text-slate-800">Qué lleva dentro</h3>
            <span className="text-xs text-slate-400">
              {items.length} {items.length === 1 ? 'línea' : 'líneas'}
              {totalPieces > 0 && ` · ${totalPieces} piezas`}
              {totalAllocated > 0 && ` · ${fmtUSD(totalAllocated)} en mercancía`}
            </span>
          </div>

          {loading ? (
            <p className="text-sm text-slate-400 py-6 text-center">Cargando contenido…</p>
          ) : items.length === 0 ? (
            <EmptyState
              title="Esta caja todavía no tiene contenido."
              hint="Anota abajo qué va dentro y de qué marca, para saberlo cuando llegue."
            />
          ) : (
            <div className="overflow-x-auto border border-slate-200 rounded-lg">
              <table className="w-full text-sm min-w-[680px]">
                <thead className="bg-slate-100 text-slate-600">
                  <tr>
                    <th className="text-left font-semibold px-3 py-2">Marca</th>
                    <th className="text-left font-semibold px-3 py-2">Qué es</th>
                    <th className="text-left font-semibold px-3 py-2">Compra</th>
                    <th className="text-center font-semibold px-3 py-2 w-20">Piezas</th>
                    {(receiving || isReceived) && (
                      <th className="text-center font-semibold px-3 py-2 w-36">Llegó</th>
                    )}
                    {!receiving && <th className="px-3 py-2 w-10" />}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {items.map((item) => {
                    const d = draft[item.id];
                    const short =
                      item.pieces != null &&
                      (item.received_pieces ?? 0) < item.pieces &&
                      item.is_received;
                    const exp = purchaseOf(item.expense_id);
                    return (
                      <tr key={item.id} className="hover:bg-slate-50 align-top">
                        <td className="px-3 py-2 text-slate-600">
                          {supplierName(item.supplier_id) || <span className="text-slate-300">—</span>}
                        </td>
                        <td className="px-3 py-2 text-slate-800">{item.description}</td>

                        <td className="px-3 py-2">
                          {linking === item.id ? (
                            <LinkEditor
                              item={item}
                              purchases={purchases.filter(
                                (p) => !item.supplier_id || p.supplier_id === item.supplier_id,
                              )}
                              onCancel={() => setLinking(null)}
                              onSave={(expenseId, amount) => linkToPurchase(item, expenseId, amount)}
                            />
                          ) : exp ? (
                            <div>
                              <div className="text-slate-700">
                                {formatDate(exp.expense_date)} · {fmtUSD(exp.amount_usd)}
                              </div>
                              <div className="text-xs text-slate-400">
                                {item.allocated_usd != null
                                  ? `${fmtUSD(item.allocated_usd)} en esta caja`
                                  : 'sin repartir'}
                                {!receiving && (
                                  <button
                                    onClick={() => setLinking(item.id)}
                                    className="ml-2 text-teal-700 hover:underline cursor-pointer"
                                  >
                                    cambiar
                                  </button>
                                )}
                              </div>
                            </div>
                          ) : receiving ? (
                            <span className="text-slate-300">—</span>
                          ) : (
                            <button
                              onClick={() => setLinking(item.id)}
                              className="text-xs text-teal-700 hover:underline cursor-pointer"
                              disabled={purchases.length === 0}
                              title={
                                purchases.length === 0
                                  ? 'Todavía no hay compras registradas'
                                  : undefined
                              }
                            >
                              Enlazar a compra
                            </button>
                          )}
                        </td>

                        <td className="px-3 py-2 text-center text-slate-600">{item.pieces ?? '—'}</td>

                        {receiving && (
                          <td className="px-3 py-2">
                            <div className="flex items-center justify-center gap-2">
                              <input
                                type="checkbox"
                                checked={d?.ok ?? false}
                                onChange={(e) =>
                                  setDraft((p) => ({
                                    ...p,
                                    [item.id]: { ok: e.target.checked, got: p[item.id]?.got ?? '' },
                                  }))
                                }
                                className="rounded border-slate-300"
                              />
                              <input
                                type="number"
                                min="0"
                                step="1"
                                disabled={!d?.ok}
                                value={d?.got ?? ''}
                                onChange={(e) =>
                                  setDraft((p) => ({
                                    ...p,
                                    [item.id]: { ok: p[item.id]?.ok ?? false, got: e.target.value },
                                  }))
                                }
                                className={`${inputClass} w-20 py-1 text-center`}
                              />
                            </div>
                          </td>
                        )}

                        {!receiving && isReceived && (
                          <td className="px-3 py-2 text-center">
                            {item.is_received ? (
                              <span className={short ? 'text-amber-700 font-semibold' : 'text-emerald-700'}>
                                {item.received_pieces ?? '✓'}
                                {short && item.pieces != null && ` de ${item.pieces}`}
                              </span>
                            ) : (
                              <span className="text-red-600 font-semibold">No llegó</span>
                            )}
                          </td>
                        )}

                        {!receiving && (
                          <td className="px-3 py-2 text-right">
                            <button
                              onClick={() => deleteItem(item)}
                              className="text-slate-400 hover:text-red-600 cursor-pointer"
                              title="Quitar línea"
                            >
                              ✕
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* --- Agregar línea --- */}
        {!receiving && (
          <div className="space-y-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <select
                value={newSupplier}
                onChange={(e) => {
                  setNewSupplier(e.target.value);
                  setNewExpense('');
                }}
                className={inputClass}
              >
                <option value="">Sin marca</option>
                {suppliers
                  .filter((s) => s.is_active)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
              <select
                value={newExpense}
                onChange={(e) => setNewExpense(e.target.value)}
                className={inputClass}
                disabled={purchaseOptions.length === 0}
              >
                <option value="">
                  {purchaseOptions.length === 0 ? 'Sin compras registradas' : 'Sin enlazar a una compra'}
                </option>
                {purchaseOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {formatDate(p.expense_date)} · {fmtUSD(p.amount_usd)}
                    {p.description ? ` · ${p.description}` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,2fr)_80px_110px_auto] gap-2">
              <input
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addItem();
                  }
                }}
                placeholder="10 blusas talla M"
                className={inputClass}
              />
              <input
                type="number"
                min="0"
                step="1"
                value={newPieces}
                onChange={(e) => setNewPieces(e.target.value)}
                placeholder="Pzs"
                className={inputClass}
              />
              <input
                type="number"
                min="0"
                step="0.01"
                value={newAmount}
                onChange={(e) => setNewAmount(e.target.value)}
                placeholder="$ en caja"
                className={inputClass}
                disabled={!newExpense}
                title={
                  newExpense
                    ? 'Cuánto de esa compra viaja en esta caja (informativo)'
                    : 'Solo aplica si enlazas la línea a una compra'
                }
              />
              <button type="button" onClick={addItem} disabled={busy} className={btnSecondary}>
                Agregar
              </button>
            </div>
          </div>
        )}

        {/* --- Lo que falta --- */}
        {!receiving && shipment.status === 'recibida_incompleta' && missing.length > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
            <h4 className="font-bold text-amber-900 text-sm mb-2">Falta por llegar</h4>
            <ul className="text-sm text-amber-900 space-y-1 list-disc list-inside">
              {missing.map((i) => (
                <li key={i.id}>
                  {supplierName(i.supplier_id) ? `${supplierName(i.supplier_id)} — ` : ''}
                  {i.description}
                  {i.pieces != null && ` (llegaron ${i.received_pieces ?? 0} de ${i.pieces})`}
                </li>
              ))}
            </ul>
          </div>
        )}

        {!receiving && (
          <ShipmentCostSection
            shipment={shipment}
            accounts={accounts}
            envioCategoryId={envioCategoryId}
          />
        )}

        {/* --- Recepción --- */}
        {receiving ? (
          <div className="border-t border-slate-200 pt-4 space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-xs font-bold uppercase tracking-wide text-slate-500 mb-1.5">
                  Fecha de llegada
                </label>
                <input
                  type="date"
                  value={receivedDate}
                  onChange={(e) => setReceivedDate(e.target.value)}
                  className={inputClass}
                />
              </div>
              <p className="text-xs text-slate-500 flex-1 min-w-[220px]">
                Marca lo que llegó y cuántas piezas. Si algo falta, la caja queda como
                <strong> recibida incompleta</strong> con el faltante a la vista.
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setReceiving(false)} className={btnSecondary} disabled={busy}>
                Cancelar
              </button>
              <button onClick={confirmReceive} className={btnPrimary} disabled={busy}>
                {busy ? 'Guardando…' : 'Confirmar recepción'}
              </button>
            </div>
          </div>
        ) : (
          <div className="border-t border-slate-200 pt-4 flex justify-end gap-2">
            <button onClick={onClose} className={btnSecondary}>
              Cerrar
            </button>
            <button onClick={startReceiving} className={isReceived ? btnDanger : btnPrimary}>
              {isReceived ? 'Corregir recepción' : 'Recibir caja'}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Selector en línea para enlazar una fila de contenido a su compra. */
function LinkEditor({
  item,
  purchases,
  onCancel,
  onSave,
}: {
  item: ShipmentItem;
  purchases: Expense[];
  onCancel: () => void;
  onSave: (expenseId: string, amount: string) => void;
}) {
  const [expenseId, setExpenseId] = useState(item.expense_id ?? '');
  const [amount, setAmount] = useState(item.allocated_usd != null ? String(item.allocated_usd) : '');

  return (
    <div className="space-y-1.5 min-w-[220px]">
      <select value={expenseId} onChange={(e) => setExpenseId(e.target.value)} className={`${inputClass} py-1`}>
        <option value="">Sin enlazar</option>
        {purchases.map((p) => (
          <option key={p.id} value={p.id}>
            {formatDate(p.expense_date)} · {fmtUSD(p.amount_usd)}
            {p.description ? ` · ${p.description}` : ''}
          </option>
        ))}
      </select>
      <div className="flex gap-1.5">
        <input
          type="number"
          min="0"
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="$ en esta caja"
          className={`${inputClass} py-1`}
          disabled={!expenseId}
        />
        <button
          onClick={() => onSave(expenseId, amount)}
          className="text-xs font-semibold text-teal-700 px-2 cursor-pointer hover:underline"
        >
          Guardar
        </button>
        <button onClick={onCancel} className="text-xs text-slate-400 px-1 cursor-pointer hover:text-slate-700">
          ✕
        </button>
      </div>
    </div>
  );
}
