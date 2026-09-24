// GET /api/fin-agent/payments
// Pagos y abonos ya registrados (fin_payments), con la cuenta o tarjeta con
// que se hicieron. Es contra esto que se comprueba si un cargo del estado de
// cuenta ya está en el sistema. Solo lectura.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAgent } from '@/lib/finanzas/agent/auth';
import { parseQuery, uuid, ymd } from '@/lib/finanzas/agent/params';
import { fetchAllPages } from '@/lib/finanzas/queries';
import { round2 } from '@/lib/finanzas/money';

const Query = z.object({
  account_id: uuid.optional(),
  from: ymd.optional(),
  to: ymd.optional(),
  limit: z.coerce.number().int().min(1).max(3000).default(500),
});

interface PaymentRow {
  id: string;
  expense_id: string;
  account_id: string;
  currency: string;
  amount: number;
  amount_usd: number;
  paid_at: string;
  reference: string | null;
  account: { name: string; last4: string | null } | null;
  expense: {
    kind: string;
    description: string | null;
    supplier: { name: string } | null;
  } | null;
}

export const GET = withAgent(async (req, { admin }) => {
  const parsed = parseQuery(req, Query);
  if (!parsed.ok) return parsed.res;
  const q = parsed.data;

  const { rows, error } = await fetchAllPages<PaymentRow>((from, to) => {
    let query = admin
      .from('fin_payments')
      .select(
        'id, expense_id, account_id, currency, amount, amount_usd, paid_at, reference, account:fin_accounts(name, last4), expense:fin_expenses(kind, description, supplier:fin_suppliers(name))',
      )
      .order('paid_at', { ascending: false })
      .order('created_at', { ascending: false });
    if (q.account_id) query = query.eq('account_id', q.account_id);
    if (q.from) query = query.gte('paid_at', q.from);
    if (q.to) query = query.lte('paid_at', q.to);
    return query.range(from, to) as unknown as PromiseLike<{ data: PaymentRow[] | null; error: { message?: string } | null }>;
  }, q.limit);
  if (error) throw new Error(`pagos: ${error.message}`);

  const items = rows.slice(0, q.limit).map((p) => ({
    id: p.id,
    fecha: p.paid_at,
    monto_usd: Number(p.amount_usd),
    moneda: p.currency,
    monto: Number(p.amount),
    referencia: p.reference,
    account_id: p.account_id,
    cuenta: p.account ? `${p.account.name}${p.account.last4 ? ' ···· ' + p.account.last4 : ''}` : null,
    expense_id: p.expense_id,
    tipo: p.expense?.kind ?? null,
    proveedor: p.expense?.supplier?.name ?? null,
    descripcion: p.expense?.description ?? null,
  }));

  return NextResponse.json({
    total: items.length,
    total_usd: round2(items.reduce((s, i) => s + i.monto_usd, 0)),
    items,
  });
});
