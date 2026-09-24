// Resúmenes para responder preguntas: deuda y consolidado por proveedor, qué
// vence pronto y en qué se fue el mes. Solo lectura, sin lo personal (salvo
// que se pida). Todo suma amount_usd, como cualquier reporte del módulo.
import { z } from 'zod';
import { defineTool, mustList } from '../tool';
import { addDays, monthRange, nextDayOfMonth, ymd } from '../params';
import { fetchAllPages } from '@/lib/finanzas/queries';
import { caracasToday } from '@/lib/finanzas/dates';
import { round2 } from '@/lib/finanzas/money';

type Page<T> = PromiseLike<{ data: T[] | null; error: { message?: string } | null }>;

// ---------------------------------------------------------------------------
interface PurchaseRow {
  supplier_id: string | null;
  amount_usd: number;
  expense_date: string;
  status: string;
  supplier: { name: string } | null;
}

export const supplierSummaryTool = defineTool({
  name: 'resumen_proveedores',
  title: 'Deuda y consolidado por proveedor',
  description:
    'Cuánto se le debe hoy a cada proveedor, y el consolidado de compras por proveedor en un rango con el monto de cada transacción.',
  input: z.object({
    from: ymd.optional().describe('Desde (consolidado).'),
    to: ymd.optional().describe('Hasta (consolidado).'),
  }),
  readOnly: true,
  async run({ admin }, q) {
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
      return query.range(from, to) as unknown as Page<PurchaseRow>;
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

    return {
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
    };
  },
});

// ---------------------------------------------------------------------------
export const dueTool = defineTool({
  name: 'vencimientos',
  title: 'Qué vence pronto',
  description:
    'Compras y gastos sin pagar que vencen en los próximos días (y los ya vencidos), el corte y el pago de cada tarjeta, y las suscripciones del lapso.',
  input: z.object({
    days: z.coerce.number().int().min(1).max(90).default(7).describe('Días hacia adelante.'),
    include_personal: z.boolean().optional(),
  }),
  readOnly: true,
  async run({ admin }, { days, include_personal }) {
    const today = caracasToday();
    const until = addDays(today, days);

    let expensesQ = admin
      .from('fin_expenses')
      .select('id, kind, description, amount_usd, paid_usd, status, due_date, is_personal, supplier:fin_suppliers(name)')
      .neq('status', 'pagada')
      .not('due_date', 'is', null)
      .lte('due_date', until)
      .order('due_date')
      .limit(1000);
    if (!include_personal) expensesQ = expensesQ.eq('is_personal', false);

    let cardsQ = admin
      .from('fin_accounts')
      .select('id, name, last4, statement_day, due_day, is_personal')
      .eq('kind', 'tarjeta_credito')
      .eq('is_active', true);
    if (!include_personal) cardsQ = cardsQ.eq('is_personal', false);

    let subsQ = admin.from('fin_subscriptions').select('name, amount_usd, billing_day, is_personal').eq('is_active', true);
    if (!include_personal) subsQ = subsQ.eq('is_personal', false);

    const [expenses, cards, subs] = await Promise.all([expensesQ, cardsQ, subsQ]);
    const inWindow = (d: string) => d <= until;

    const vencimientos = mustList(expenses, 'vencimientos').map((e: Record<string, unknown>) => {
      const supplier = e.supplier as { name: string } | null;
      return {
        id: e.id,
        tipo: e.kind,
        proveedor: supplier?.name ?? null,
        descripcion: e.description,
        vence: e.due_date,
        vencida: String(e.due_date) < today,
        falta_usd: round2(Number(e.amount_usd) - Number(e.paid_usd)),
        estado: e.status,
      };
    });

    const tarjetas = mustList(cards, 'tarjetas').flatMap((c: Record<string, unknown>) => {
      const label = `${c.name}${c.last4 ? ' ···· ' + c.last4 : ''}`;
      const out: { tarjeta: string; evento: string; fecha: string }[] = [];
      if (c.statement_day) {
        const d = nextDayOfMonth(today, Number(c.statement_day));
        if (inWindow(d)) out.push({ tarjeta: label, evento: 'corte', fecha: d });
      }
      if (c.due_day) {
        const d = nextDayOfMonth(today, Number(c.due_day));
        if (inWindow(d)) out.push({ tarjeta: label, evento: 'pago', fecha: d });
      }
      return out;
    });

    const suscripciones = mustList(subs, 'suscripciones')
      .map((s: Record<string, unknown>) => ({
        nombre: s.name,
        monto_usd: Number(s.amount_usd),
        fecha: nextDayOfMonth(today, Number(s.billing_day)),
      }))
      .filter((s: { fecha: string }) => inWindow(s.fecha));

    return {
      hoy: today,
      hasta: until,
      total_por_pagar_usd: round2(vencimientos.reduce((s: number, v: { falta_usd: number }) => s + v.falta_usd, 0)),
      vencimientos,
      tarjetas,
      suscripciones,
    };
  },
});

// ---------------------------------------------------------------------------
interface MonthRow {
  kind: string;
  amount_usd: number;
  paid_usd: number;
  category: { name: string } | null;
}

export const monthTool = defineTool({
  name: 'resumen_mes',
  title: 'Gasto del mes y presupuesto',
  description:
    'Lo registrado en un mes por categoría y por tipo (compra/gasto/flete), lo que falta por pagar, y presupuesto contra lo real.',
  input: z.object({
    month: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mes en formato AAAA-MM')
      .optional()
      .describe('Mes AAAA-MM. Por defecto el actual.'),
  }),
  readOnly: true,
  async run({ admin }, input) {
    const month = input.month ?? caracasToday().slice(0, 7);
    const { start, end } = monthRange(month);

    const { rows, error } = await fetchAllPages<MonthRow>((from, to) =>
      admin
        .from('fin_expenses')
        .select('kind, amount_usd, paid_usd, category:fin_categories(name)')
        .eq('is_personal', false)
        .gte('expense_date', start)
        .lte('expense_date', end)
        .range(from, to) as unknown as Page<MonthRow>,
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

    return {
      mes: month,
      total_usd: round2(rows.reduce((s, r) => s + Number(r.amount_usd), 0)),
      sin_pagar_usd: round2(rows.reduce((s, r) => s + Math.max(Number(r.amount_usd) - Number(r.paid_usd), 0), 0)),
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
    };
  },
});
