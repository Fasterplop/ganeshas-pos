'use client';

// Control de envío de cajas.
//
// El problema real: se envían varias cajas en días distintos y no se sabe qué
// llevó cada una; se anota en notas sueltas y se pierde. Aquí cada caja guarda
// su contenido, su guía y su estado, y al llegar se marca qué llegó y qué no.
//
// Esta pantalla NO toca inventario: recibir una caja no suma stock. El stock se
// sigue cargando desde /inventory como siempre. Es una decisión, no un
// pendiente: mantiene el módulo aislado del catálogo y las ventas reales.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useFinanceFilters } from '@/store/useFinanceFilters';
import FinShell from '@/components/finanzas/FinShell';
import ShipmentFormModal, { Shipment } from '@/components/finanzas/ShipmentFormModal';
import ShipmentDetailModal, { ShipmentItem } from '@/components/finanzas/ShipmentDetailModal';
import type { Supplier } from '@/components/finanzas/SupplierFormModal';
import type { Account } from '@/components/finanzas/AccountFormModal';
import {
  FinNotice,
  FinStatCard,
  Notice,
  EmptyState,
  ShipmentStatusBadge,
  SHIPMENT_STATUS_LABEL,
  btnPrimary,
  btnSecondary,
  inputClass,
} from '@/components/finanzas/ui';
import { fetchAllPages } from '@/lib/finanzas/queries';
import { finErrorMessage } from '@/lib/finanzas/errors';
import { formatDate, daysUntil } from '@/lib/finanzas/dates';
import { downloadFinWorkbook, finFilename, FMT_INT, FMT_USD } from '@/lib/finanzas/excel';
import { fmtUSD } from '@/lib/finanzas/money';

type StatusFilter = 'todas' | 'en_camino' | 'preparada' | 'recibida' | 'incompleta';

export default function CajasPage() {
  const supabase = useMemo(() => createClient(), []);
  const { dateRange, setDateRange } = useFinanceFilters();

  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [items, setItems] = useState<ShipmentItem[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [envioCategoryId, setEnvioCategoryId] = useState<string | null>(null);
  // Costo de envio por caja: suma de sus egresos kind='envio'.
  const [costByShipment, setCostByShipment] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [exporting, setExporting] = useState(false);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('todas');
  const [search, setSearch] = useState('');

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Shipment | null>(null);
  const [detail, setDetail] = useState<Shipment | null>(null);

  const load = useCallback(async () => {
    setLoading(true);

    const { rows: ship, error: shipError } = await fetchAllPages<Shipment>((from, to) =>
      supabase
        .from('fin_shipments')
        .select(
          'id, box_number, alias, status, courier, tracking_code, sent_date, eta_date, received_date, pieces, weight, weight_unit, document_path, notes, created_at',
        )
        .order('created_at', { ascending: false })
        .range(from, to),
    );

    if (shipError) {
      setNotice({ type: 'error', text: finErrorMessage(shipError) });
      setLoading(false);
      return;
    }

    // El contenido de todas las cajas en una sola consulta: la lista muestra de
    // qué marcas viene cada caja, y el export lo necesita completo.
    let content: ShipmentItem[] = [];
    if (ship.length > 0) {
      const ids = ship.map((s) => s.id);
      const { rows } = await fetchAllPages<ShipmentItem>((from, to) =>
        supabase
          .from('fin_shipment_items')
          .select(
            'id, shipment_id, expense_id, supplier_id, purchase_line_id, description, pieces, received_pieces, is_received, allocated_usd, notes',
          )
          .in('shipment_id', ids)
          .order('created_at')
          .range(from, to),
      );
      content = rows;
    }

    const { rows: sup } = await fetchAllPages<Supplier>((from, to) =>
      supabase
        .from('fin_suppliers')
        .select('id, name, contact_name, phone, email, payment_terms, notes, is_active')
        .order('name')
        .range(from, to),
    );

    const { rows: acc } = await fetchAllPages<Account>((from, to) =>
      supabase
        .from('fin_accounts')
        .select(
          'id, name, kind, bank_name, last4, currency, opening_balance_usd, opening_balance_date, credit_limit_usd, statement_day, due_day, is_personal, is_active, notes',
        )
        .order('name')
        .range(from, to),
    );

    // La categoria del flete se resuelve una vez y se reutiliza al registrar el
    // costo, para que entre en el presupuesto y en los reportes del mes.
    const { data: cat } = await supabase
      .from('fin_categories')
      .select('id')
      .eq('kind', 'compra')
      .ilike('name', 'env%')
      .limit(1)
      .maybeSingle();

    // Costo real por caja: la suma de sus fletes. Vive en fin_expenses, no en
    // la caja, para que el dinero tenga un solo camino.
    const costs = new Map<string, number>();
    if (ship.length > 0) {
      const { rows: costRows } = await fetchAllPages<{ shipment_id: string; amount_usd: number }>(
        (from, to) =>
          supabase
            .from('fin_expenses')
            .select('shipment_id, amount_usd')
            .eq('kind', 'envio')
            .in('shipment_id', ship.map((x) => x.id))
            .range(from, to),
      );
      for (const c of costRows) {
        costs.set(c.shipment_id, (costs.get(c.shipment_id) ?? 0) + Number(c.amount_usd));
      }
    }

    setShipments(ship);
    setItems(content);
    setSuppliers(sup);
    setAccounts(acc);
    setEnvioCategoryId(cat?.id ?? null);
    setCostByShipment(costs);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  const itemsByShipment = useMemo(() => {
    const map = new Map<string, ShipmentItem[]>();
    for (const i of items) {
      const list = map.get(i.shipment_id);
      if (list) list.push(i);
      else map.set(i.shipment_id, [i]);
    }
    return map;
  }, [items]);

  const supplierName = useCallback(
    (id: string | null) => suppliers.find((s) => s.id === id)?.name ?? null,
    [suppliers],
  );
  const brandsOf = useCallback(
    (shipmentId: string) => {
      const list = itemsByShipment.get(shipmentId) ?? [];
      const names = [...new Set(list.map((i) => supplierName(i.supplier_id)).filter(Boolean))];
      return names as string[];
    },
    [itemsByShipment, supplierName],
  );

  // El período se aplica sobre la fecha de ENVÍO, pero SOLO al historial.
  //
  // Una caja que todavía no ha llegado se muestra siempre, esté cuando esté su
  // fecha de envío. Si no, una caja despachada hace seis semanas y aún en
  // tránsito desaparecería de "en camino" al filtrar por el mes en curso, que
  // es exactamente lo que este módulo existe para evitar.
  const inPeriod = useCallback(
    (s: Shipment) => {
      const llegó = s.status === 'recibida' || s.status === 'recibida_incompleta';
      if (!llegó) return true;
      if (!s.sent_date) return true;
      return s.sent_date >= dateRange.start && s.sent_date <= dateRange.end;
    },
    [dateRange],
  );

  const periodShipments = useMemo(() => shipments.filter(inPeriod), [shipments, inPeriod]);

  const counts = useMemo(
    () => ({
      enCamino: periodShipments.filter((s) => s.status === 'enviada' || s.status === 'en_transito')
        .length,
      preparadas: periodShipments.filter((s) => s.status === 'preparada').length,
      incompletas: periodShipments.filter((s) => s.status === 'recibida_incompleta').length,
      total: periodShipments.length,
    }),
    [periodShipments],
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return periodShipments.filter((s) => {
      if (statusFilter === 'en_camino' && s.status !== 'enviada' && s.status !== 'en_transito')
        return false;
      if (statusFilter === 'preparada' && s.status !== 'preparada') return false;
      if (statusFilter === 'recibida' && s.status !== 'recibida') return false;
      if (statusFilter === 'incompleta' && s.status !== 'recibida_incompleta') return false;
      if (!q) return true;
      return (
        s.box_number.toLowerCase().includes(q) ||
        (s.alias ?? '').toLowerCase().includes(q) ||
        (s.courier ?? '').toLowerCase().includes(q) ||
        (s.tracking_code ?? '').toLowerCase().includes(q) ||
        brandsOf(s.id).some((b) => b.toLowerCase().includes(q)) ||
        (itemsByShipment.get(s.id) ?? []).some((i) =>
          (i.description ?? '').toLowerCase().includes(q),
        )
      );
    });
  }, [periodShipments, statusFilter, search, brandsOf, itemsByShipment]);

  const upsertShipment = (saved: Shipment, isNew: boolean) => {
    setShipments((prev) => (isNew ? [saved, ...prev] : prev.map((s) => (s.id === saved.id ? saved : s))));
    if (detail?.id === saved.id) setDetail(saved);
    setNotice({
      type: 'success',
      text: isNew ? `Caja ${saved.box_number} creada.` : `Caja ${saved.box_number} actualizada.`,
    });
  };

  const deleteShipment = async (s: Shipment) => {
    if (
      !window.confirm(
        `¿Eliminar la caja ${s.box_number}?\n\nSe borra también su contenido. Esta acción no se puede deshacer.`,
      )
    )
      return;
    const { error } = await supabase.from('fin_shipments').delete().eq('id', s.id);
    if (error) {
      setNotice({ type: 'error', text: finErrorMessage(error) });
      return;
    }
    setShipments((prev) => prev.filter((x) => x.id !== s.id));
    setNotice({ type: 'success', text: `Caja ${s.box_number} eliminada.` });
  };

  const handleExport = async () => {
    if (exporting) return;
    if (visible.length === 0) {
      setNotice({ type: 'error', text: 'No hay cajas en el período seleccionado.' });
      return;
    }
    setExporting(true);
    try {
      const rows = visible.map((s) => {
        const list = itemsByShipment.get(s.id) ?? [];
        return {
          caja: s.box_number,
          alias: s.alias ?? '',
          estado: SHIPMENT_STATUS_LABEL[s.status] ?? s.status,
          agencia: s.courier ?? '',
          guia: s.tracking_code ?? '',
          enviada: formatDate(s.sent_date),
          estimada: formatDate(s.eta_date),
          llegada: formatDate(s.received_date),
          piezas: s.pieces ?? 0,
          peso: s.weight != null ? `${s.weight} ${s.weight_unit}` : '',
          marcas: brandsOf(s.id).join(', '),
          contenido: list
            .map((i) => {
              const marca = supplierName(i.supplier_id);
              const pzs = i.pieces != null ? ` (${i.pieces} pzs)` : '';
              const falta =
                s.status === 'recibida_incompleta' && !i.is_received ? ' — NO LLEGÓ' : '';
              return `${marca ? `${marca}: ` : ''}${i.description ?? ''}${pzs}${falta}`;
            })
            .join('\n'),
          costo: costByShipment.get(s.id) ?? 0,
          notas: s.notes ?? '',
        };
      });

      await downloadFinWorkbook({
        filename: finFilename('cajas', dateRange.start, dateRange.end),
        cover: {
          title: 'Envío de cajas',
          periodStart: dateRange.start,
          periodEnd: dateRange.end,
          extra: [
            ['Cajas incluidas', String(rows.length)],
            ['Alcance', 'Recibidas dentro del período, más todas las que siguen en camino'],
          ],
        },
        sheets: [
          {
            name: 'Cajas',
            columns: [
              { header: 'Caja', key: 'caja', width: 10 },
              { header: 'Alias', key: 'alias', width: 22 },
              { header: 'Estado', key: 'estado', width: 20 },
              { header: 'Agencia', key: 'agencia', width: 16 },
              { header: 'Guía', key: 'guia', width: 20 },
              { header: 'Enviada', key: 'enviada', width: 13 },
              { header: 'Llegada estimada', key: 'estimada', width: 16 },
              { header: 'Llegada real', key: 'llegada', width: 14 },
              { header: 'Piezas', key: 'piezas', width: 9, numFmt: FMT_INT, align: 'center' },
              { header: 'Peso', key: 'peso', width: 12 },
              { header: 'Marcas', key: 'marcas', width: 26, wrap: true },
              { header: 'Contenido', key: 'contenido', width: 46, wrap: true },
              { header: 'Costo del envío', key: 'costo', width: 15, numFmt: FMT_USD },
              { header: 'Notas', key: 'notas', width: 28, wrap: true },
            ],
            rows,
            totals: { costo: rows.reduce((a, r) => a + Number(r.costo), 0) },
            totalsLabel: 'TOTAL',
            note: 'El costo del envío son los egresos de tipo Envío asociados a cada caja; ya está contado en los gastos del período.',
          },
        ],
      });
    } catch (err) {
      setNotice({
        type: 'error',
        text: err instanceof Error ? err.message : 'Error al exportar las cajas.',
      });
    } finally {
      setExporting(false);
    }
  };

  const FILTERS: Array<{ key: StatusFilter; label: string }> = [
    { key: 'todas', label: `Todas (${counts.total})` },
    { key: 'en_camino', label: `En camino (${counts.enCamino})` },
    { key: 'preparada', label: `Preparadas (${counts.preparadas})` },
    { key: 'recibida', label: 'Recibidas' },
    { key: 'incompleta', label: `Incompletas (${counts.incompletas})` },
  ];

  return (
    <FinShell
      title="Cajas"
      subtitle="Qué lleva cada caja, dónde va y qué llegó de verdad."
      actions={
        <>
          <button onClick={handleExport} disabled={exporting} className={btnSecondary}>
            {exporting ? 'Exportando…' : '📥 Exportar a .xlsx'}
          </button>
          <button
            className={btnPrimary}
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            + Nueva caja
          </button>
        </>
      }
    >
      <div className="space-y-5">
        <FinNotice notice={notice} onClose={() => setNotice(null)} />

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <FinStatCard
            label="En camino"
            value={counts.enCamino}
            tone="teal"
            sub="Enviadas y sin recibir"
            active={statusFilter === 'en_camino'}
            onClick={() => setStatusFilter(statusFilter === 'en_camino' ? 'todas' : 'en_camino')}
          />
          <FinStatCard
            label="Preparadas"
            value={counts.preparadas}
            sub="Todavía sin salir"
            active={statusFilter === 'preparada'}
            onClick={() => setStatusFilter(statusFilter === 'preparada' ? 'todas' : 'preparada')}
          />
          <FinStatCard
            label="Recibidas incompletas"
            value={counts.incompletas}
            tone={counts.incompletas > 0 ? 'amber' : 'default'}
            sub="Con algo pendiente"
            active={statusFilter === 'incompleta'}
            onClick={() => setStatusFilter(statusFilter === 'incompleta' ? 'todas' : 'incompleta')}
          />
          <FinStatCard label="Cajas del período" value={counts.total} />
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200">
          <div className="p-4 border-b border-slate-100 flex flex-wrap gap-3 items-center">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por caja, alias, guía, marca o contenido…"
              className={`${inputClass} max-w-sm`}
            />
            <div className="flex items-center gap-2 text-sm">
              <input
                type="date"
                value={dateRange.start}
                onChange={(e) => setDateRange({ ...dateRange, start: e.target.value })}
                className={`${inputClass} w-auto`}
              />
              <span className="text-slate-400">al</span>
              <input
                type="date"
                value={dateRange.end}
                onChange={(e) => setDateRange({ ...dateRange, end: e.target.value })}
                className={`${inputClass} w-auto`}
              />
            </div>
            <span className="text-xs text-slate-400">
              El período filtra el historial. Las cajas que todavía no han llegado se muestran
              siempre.
            </span>
          </div>

          <div className="px-4 py-3 border-b border-slate-100 flex flex-wrap gap-2">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setStatusFilter(f.key)}
                className={`text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors cursor-pointer ${
                  statusFilter === f.key
                    ? 'bg-teal-700 text-white border-teal-700'
                    : 'bg-white text-slate-600 border-slate-200 hover:border-teal-400'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="py-16 text-center text-slate-400 text-sm">Cargando cajas…</div>
          ) : visible.length === 0 ? (
            <EmptyState
              title={
                shipments.length === 0
                  ? 'Todavía no hay cajas registradas.'
                  : 'Ninguna caja coincide con el filtro.'
              }
              hint={
                shipments.length === 0
                  ? 'Crea la primera con su número, la agencia y qué va dentro. Nunca más hará falta la libreta.'
                  : undefined
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[900px]">
                <thead className="bg-slate-100 text-slate-600">
                  <tr>
                    <th className="text-left font-semibold px-4 py-3">Caja</th>
                    <th className="text-left font-semibold px-4 py-3">Estado</th>
                    <th className="text-left font-semibold px-4 py-3">Contenido</th>
                    <th className="text-left font-semibold px-4 py-3">Agencia / Guía</th>
                    <th className="text-left font-semibold px-4 py-3">Fechas</th>
                    <th className="text-right font-semibold px-4 py-3">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visible.map((s) => {
                    const list = itemsByShipment.get(s.id) ?? [];
                    const brands = brandsOf(s.id);
                    const eta = daysUntil(s.eta_date);
                    const costo = costByShipment.get(s.id) ?? 0;
                    const enCamino = s.status === 'enviada' || s.status === 'en_transito';
                    return (
                      <tr key={s.id} className="hover:bg-slate-50 align-top">
                        <td className="px-4 py-3">
                          <button
                            onClick={() => setDetail(s)}
                            className="font-semibold text-slate-800 hover:text-teal-700 cursor-pointer text-left"
                          >
                            Caja {s.box_number}
                          </button>
                          {s.alias && <div className="text-xs text-slate-500">{s.alias}</div>}
                        </td>
                        <td className="px-4 py-3">
                          <ShipmentStatusBadge status={s.status} />
                        </td>
                        <td className="px-4 py-3">
                          {list.length === 0 ? (
                            <span className="text-slate-300">Sin contenido</span>
                          ) : (
                            <>
                              <div className="text-slate-700">
                                {list.length} {list.length === 1 ? 'línea' : 'líneas'}
                                {s.pieces ? ` · ${s.pieces} pzs` : ''}
                              </div>
                              {brands.length > 0 && (
                                <div className="text-xs text-slate-500">{brands.join(', ')}</div>
                              )}
                            </>
                          )}
                          {costo > 0 && (
                            <div className="text-xs text-slate-500 mt-0.5">
                              Envío: <span className="font-semibold">{fmtUSD(costo)}</span>
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-slate-600">
                          {s.courier || '—'}
                          {s.tracking_code && (
                            <div className="text-xs text-slate-400 font-mono">{s.tracking_code}</div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-slate-600 whitespace-nowrap">
                          <div className="text-xs">
                            <span className="text-slate-400">Envío:</span> {formatDate(s.sent_date)}
                          </div>
                          <div className="text-xs">
                            <span className="text-slate-400">
                              {s.received_date ? 'Llegó:' : 'Estimada:'}
                            </span>{' '}
                            {formatDate(s.received_date ?? s.eta_date)}
                            {enCamino && eta !== null && (
                              <span
                                className={`ml-1 font-semibold ${eta < 0 ? 'text-red-600' : 'text-slate-500'}`}
                              >
                                ({eta < 0 ? `${-eta} d de retraso` : eta === 0 ? 'hoy' : `en ${eta} d`})
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex justify-end gap-2">
                            <button className={btnSecondary} onClick={() => setDetail(s)}>
                              Contenido
                            </button>
                            <button
                              className={btnSecondary}
                              onClick={() => {
                                setEditing(s);
                                setFormOpen(true);
                              }}
                            >
                              Editar
                            </button>
                            <button
                              className="text-slate-400 hover:text-red-600 px-1 cursor-pointer"
                              onClick={() => deleteShipment(s)}
                              title="Eliminar caja"
                            >
                              ✕
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

      <ShipmentFormModal
        isOpen={formOpen}
        onClose={() => setFormOpen(false)}
        shipment={editing}
        onSaved={upsertShipment}
      />

      <ShipmentDetailModal
        isOpen={!!detail}
        onClose={() => {
          setDetail(null);
          load();
        }}
        shipment={detail}
        suppliers={suppliers}
        accounts={accounts}
        envioCategoryId={envioCategoryId}
        onShipmentChanged={(s) => upsertShipment(s, false)}
      />
    </FinShell>
  );
}
