// GET /api/fin-agent/expenses
// Compras, gastos y fletes ya registrados. Sirve para: encontrar la compra a la
// que va un abono (status=abiertas), revisar si algo del estado de cuenta ya
// está cargado, y responder preguntas. Solo lectura.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAgent, mustList } from '@/lib/finanzas/agent/auth';
import { boolParam, parseQuery, uuid, ymd } from '@/lib/finanzas/agent/params';
import { fetchAllPages } from '@/lib/finanzas/queries';
import { round2 } from '@/lib/finanzas/money';

const Query = z.object({
  from: ymd.optional(),
  to: ymd.optional(),
  kind: z.enum(['compra', 'gasto', 'envio']).optional(),
  supplier_id: uuid.optional(),
  category_id: uuid.optional(),
  status: z.enum(['pendiente', 'parcial', 'pagada', 'abiertas']).optional(),
  q: z.string().max(100).optional(),
  include_personal: boolParam,
  limit: z.coerce.number().int().min(1).max(2000).default(300),
});

interface ExpenseRow {
  id: string;
  kind: string;
  supplier_id: string | null;
  category_id: string | null;
  description: string | null;
  currency: string;
  amount: number;
  amount_usd: number;
  paid_usd: number;
  status: string;
  expense_date: string;
  due_date: string | null;
  is_personal: boolean;
  supplier: { name: string } | null;
  category: { name: string } | null;
}

export const GET = withAgent(async (req, { admin }) => {
  const parsed = parseQuery(req, Query);
  if (!parsed.ok) return parsed.res;
  const q = parsed.data;

  // Búsqueda libre: por descripción o por nombre de proveedor.
  let supplierMatches: string[] = [];
  if (q.q) {
    const term = q.q.replace(/[%,()]/g, ' ').trim();
    const rows = mustList(
      await admin.from('fin_suppliers').select('id').ilike('name', `%${term}%`).limit(50),
      'proveedores',
    );
    supplierMatches = rows.map((r: { id: string }) => r.id);
    q.q = term;
  }

  const { rows, error } = await fetchAllPages<ExpenseRow>((from, to) => {
    let query = admin
      .from('fin_expenses')
      .select(
        'id, kind, supplier_id, category_id, description, currency, amount, amount_usd, paid_usd, status, expense_date, due_date, is_personal, supplier:fin_suppliers(name), category:fin_categories(name)',
      )
      .order('expense_date', { ascending: false })
      .order('created_at', { ascending: false });
    if (!q.include_personal) query = query.eq('is_personal', false);
    if (q.from) query = query.gte('expense_date', q.from);
    if (q.to) query = query.lte('expense_date', q.to);
    if (q.kind) query = query.eq('kind', q.kind);
    if (q.supplier_id) query = query.eq('supplier_id', q.supplier_id);
    if (q.category_id) query = query.eq('category_id', q.category_id);
    if (q.status === 'abiertas') query = query.neq('status', 'pagada');
    else if (q.status) query = query.eq('status', q.status);
    if (q.q) {
      const ors = [`description.ilike.%${q.q}%`];
      if (supplierMatches.length) ors.push(`supplier_id.in.(${supplierMatches.join(',')})`);
      query = query.or(ors.join(','));
    }
    return query.range(from, to) as unknown as PromiseLike<{ data: ExpenseRow[] | null; error: { message?: string } | null }>;
  }, q.limit);
  if (error) throw new Error(`compras/gastos: ${error.message}`);

  const items = rows.slice(0, q.limit).map((e) => ({
    id: e.id,
    tipo: e.kind,
    proveedor: e.supplier?.name ?? null,
    supplier_id: e.supplier_id,
    categoria: e.category?.name ?? null,
    descripcion: e.description,
    fecha: e.expense_date,
    vence: e.due_date,
    moneda: e.currency,
    monto: Number(e.amount),
    monto_usd: Number(e.amount_usd),
    pagado_usd: Number(e.paid_usd),
    falta_usd: round2(Number(e.amount_usd) - Number(e.paid_usd)),
    estado: e.status,
    personal: e.is_personal,
  }));

  return NextResponse.json({
    total: items.length,
    total_usd: round2(items.reduce((s, i) => s + i.monto_usd, 0)),
    falta_usd: round2(items.reduce((s, i) => s + Math.max(i.falta_usd, 0), 0)),
    items,
  });
});
