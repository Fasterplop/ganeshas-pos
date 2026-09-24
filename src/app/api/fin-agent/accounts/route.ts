// GET /api/fin-agent/accounts
// Saldo de cada cuenta y deuda de cada tarjeta, tal como se ven en
// Finanzas > Cuentas. SOLO LECTURA: el saldo es manual y el conector no lo
// mueve nunca (ver db/finanzas_07_chatgpt.sql).
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAgent, mustList } from '@/lib/finanzas/agent/auth';
import { boolParam, parseQuery } from '@/lib/finanzas/agent/params';
import { round2, ACCOUNT_KIND_LABEL } from '@/lib/finanzas/money';

const Query = z.object({ include_personal: boolParam });

export const GET = withAgent(async (req, { admin }) => {
  const parsed = parseQuery(req, Query);
  if (!parsed.ok) return parsed.res;

  let query = admin
    .from('fin_v_account_balance')
    .select('account_id, name, kind, bank_name, last4, is_personal, credit_limit_usd, statement_day, due_day, balance_usd, available_usd, moved_usd')
    .eq('is_active', true)
    .order('name');
  if (!parsed.data.include_personal) query = query.eq('is_personal', false);

  const rows = mustList(await query, 'cuentas');

  return NextResponse.json({
    nota: 'Saldos manuales: los pone el dueño en Finanzas > Cuentas. En tarjetas, saldo = deuda.',
    cuentas: rows.map((a: Record<string, unknown>) => ({
      account_id: a.account_id,
      nombre: a.name,
      tipo: ACCOUNT_KIND_LABEL[String(a.kind)] ?? a.kind,
      banco: a.bank_name,
      last4: a.last4,
      personal: a.is_personal,
      saldo_usd: round2(Number(a.balance_usd)),
      limite_usd: a.credit_limit_usd === null ? null : Number(a.credit_limit_usd),
      disponible_usd: a.available_usd === null ? null : round2(Number(a.available_usd)),
      dia_corte: a.statement_day,
      dia_pago: a.due_day,
      pagado_con_esta_cuenta_usd: round2(Number(a.moved_usd)),
    })),
  });
});
