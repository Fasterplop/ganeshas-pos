// GET /api/fin-agent/summary/suppliers?from&to
// Dos respuestas en una:
//   - deuda: cuánto se le debe a cada proveedor hoy (fin_v_supplier_balance).
//   - consolidado: compras por proveedor en el rango, con el monto de cada
//     transacción. Es el mismo formato del "Consolidado de proveedores de Los
//     Angeles" que el dueño ya usa. Solo lectura, sin lo personal.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAgent, mustList } from '@/lib/finanzas/agent/auth';
import { parseQuery, ymd } from '@/lib/finanzas/agent/params';
import { fetchAllPages } from '@/lib/finanzas/queries';
import { round2 } from '@/lib/finanzas/money';

const Query = z.object({
  from: ymd.optional(),
  to: ymd.optional(),
});

interface PurchaseRow {
  supplier_id: string | null;
  amount_usd: number;
  expense_date: string;
  status: string;
  supplier: { name: string } | null;
}

export const GET = withAgent(async (req, { admin }) => {
  const parsed = parseQuery(req, Query);
  if (!parsed.ok) return parsed.res;
  const q = parsed.data;

  const debt = mustList(
    await admin
      .from('fin_v_supplier_balance')
      .select('supplier_id, name, open_invoices, balance_usd, next_due_date, total_purchased_usd, last_purchase_date')
      .gt('balance_usd', 0.005)
      .order('balance_usd', { ascending: false }),
    'deuda por proveedor',
  );

  const { rows, error } = await fetchAllPages<PurchaseRow>((from, to) => {
    let query = admin
      .from('fin_expenses')
      .select('supplier_id, amount_usd, expense_date, status, supplier:fin_suppliers(name)')
      .eq('kind', 'compra')
      .eq('is_personal', false)
      .order('expense_date');
    if (q.from) query = query.gte('expense_date', q.from);
    if (q.to) query = query.lte('expense_date', q.to);
    return query.range(from, to) as unknown as PromiseLike<{ data: PurchaseRow[] | null; error: { message?: string } | null }>;
  });
  if (error) throw new Error(`compras: ${error.message}`);

  const bySupplier = new Map<string, { proveedor: string; transacciones: { fecha: string; monto_usd: number; estado: string }[] }>();
  for (const r of rows) {
    const key = r.supplier_id ?? 'sin-proveedor';
    const entry = bySupplier.get(key) ?? { proveedor: r.supplier?.name ?? 'Sin proveedor', transacciones: [] };
    entry.transacciones.push({ fecha: r.expense_date, monto_usd: Number(r.amount_usd), estado: r.status });
    bySupplier.set(key, entry);
  }

  const consolidado = [...bySupplier.values()]
    .map((e) => ({
      ...e,
      num_transacciones: e.transacciones.length,
      total_usd: round2(e.transacciones.reduce((s, t) => s + t.monto_usd, 0)),
    }))
    .sort((a, b) => b.total_usd - a.total_usd);

  return NextResponse.json({
    rango: { desde: q.from ?? null, hasta: q.to ?? null },
    deuda: debt.map((d: Record<string, unknown>) => ({
      supplier_id: d.supplier_id,
      proveedor: d.name,
      facturas_abiertas: Number(d.open_invoices),
      debe_usd: round2(Number(d.balance_usd)),
      proximo_vencimiento: d.next_due_date,
    })),
    deuda_total_usd: round2(debt.reduce((s: number, d: Record<string, unknown>) => s + Number(d.balance_usd), 0)),
    consolidado,
    consolidado_totales: {
      proveedores: consolidado.length,
      transacciones: rows.length,
      total_usd: round2(consolidado.reduce((s, c) => s + c.total_usd, 0)),
    },
  });
});
