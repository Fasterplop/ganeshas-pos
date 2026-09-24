// GET /api/fin-agent/summary/month?month=YYYY-MM
// "¿En qué se me fue el mes?": lo registrado en el mes por categoría y por
// tipo (compra/gasto/flete), más presupuesto contra lo real. Suma amount_usd,
// como todo reporte del módulo. Solo lectura, sin lo personal.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAgent, mustList } from '@/lib/finanzas/agent/auth';
import { monthRange, parseQuery } from '@/lib/finanzas/agent/params';
import { fetchAllPages } from '@/lib/finanzas/queries';
import { caracasToday } from '@/lib/finanzas/dates';
import { round2 } from '@/lib/finanzas/money';

const Query = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mes en formato AAAA-MM').optional(),
});

interface Row {
  kind: string;
  amount_usd: number;
  paid_usd: number;
  category: { name: string } | null;
}

export const GET = withAgent(async (req, { admin }) => {
  const parsed = parseQuery(req, Query);
  if (!parsed.ok) return parsed.res;
  const month = parsed.data.month ?? caracasToday().slice(0, 7);
  const { start, end } = monthRange(month);

  const { rows, error } = await fetchAllPages<Row>((from, to) =>
    admin
      .from('fin_expenses')
      .select('kind, amount_usd, paid_usd, category:fin_categories(name)')
      .eq('is_personal', false)
      .gte('expense_date', start)
      .lte('expense_date', end)
      .range(from, to) as unknown as PromiseLike<{ data: Row[] | null; error: { message?: string } | null }>,
  );
  if (error) throw new Error(`gastos del mes: ${error.message}`);

  const byCategory = new Map<string, number>();
  const byKind = new Map<string, number>();
  for (const r of rows) {
    const cat = r.category?.name ?? 'Sin categoría';
    byCategory.set(cat, (byCategory.get(cat) ?? 0) + Number(r.amount_usd));
    byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + Number(r.amount_usd));
  }

  const budget = mustList(
    await admin
      .from('fin_v_budget_vs_actual')
      .select('category_name, budget_usd, spent_usd, remaining_usd, pct_used')
      .eq('period_month', start),
    'presupuesto',
  );

  const total = rows.reduce((s, r) => s + Number(r.amount_usd), 0);
  const unpaid = rows.reduce((s, r) => s + Math.max(Number(r.amount_usd) - Number(r.paid_usd), 0), 0);

  return NextResponse.json({
    mes: month,
    total_usd: round2(total),
    sin_pagar_usd: round2(unpaid),
    por_tipo: [...byKind.entries()].map(([tipo, v]) => ({ tipo, total_usd: round2(v) })),
    por_categoria: [...byCategory.entries()]
      .map(([categoria, v]) => ({ categoria, total_usd: round2(v) }))
      .sort((a, b) => b.total_usd - a.total_usd),
    presupuesto: budget.map((b: Record<string, unknown>) => ({
      categoria: b.category_name,
      presupuesto_usd: Number(b.budget_usd),
      gastado_usd: round2(Number(b.spent_usd)),
      queda_usd: round2(Number(b.remaining_usd)),
      porcentaje_usado: b.pct_used === null ? null : Number(b.pct_used),
    })),
  });
});
