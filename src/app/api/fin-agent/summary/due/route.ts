// GET /api/fin-agent/summary/due?days=7
// "¿Qué vence esta semana?": compras y gastos sin pagar que vencen en los
// próximos N días (y los ya vencidos), el corte y el pago de cada tarjeta, y
// las suscripciones que se cobran en ese lapso. Solo lectura.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAgent, mustList } from '@/lib/finanzas/agent/auth';
import { addDays, boolParam, nextDayOfMonth, parseQuery } from '@/lib/finanzas/agent/params';
import { caracasToday } from '@/lib/finanzas/dates';
import { round2 } from '@/lib/finanzas/money';

const Query = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
  include_personal: boolParam,
});

export const GET = withAgent(async (req, { admin }) => {
  const parsed = parseQuery(req, Query);
  if (!parsed.ok) return parsed.res;
  const { days, include_personal } = parsed.data;

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

  let subsQ = admin
    .from('fin_subscriptions')
    .select('name, amount_usd, billing_day, is_personal')
    .eq('is_active', true);
  if (!include_personal) subsQ = subsQ.eq('is_personal', false);

  const [expenses, cards, subs] = await Promise.all([expensesQ, cardsQ, subsQ]);

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

  const inWindow = (d: string) => d <= until;

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

  return NextResponse.json({
    hoy: today,
    hasta: until,
    total_por_pagar_usd: round2(vencimientos.reduce((s: number, v: { falta_usd: number }) => s + v.falta_usd, 0)),
    vencimientos,
    tarjetas,
    suscripciones,
  });
});
