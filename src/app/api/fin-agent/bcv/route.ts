// GET /api/fin-agent/bcv?date=YYYY-MM-DD
// Tasa BCV guardada para ese día. Si no hay, devuelve rate=null: el GPT debe
// preguntarla, nunca inventarla ni usar la de otro día sin decirlo.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAgent } from '@/lib/finanzas/agent/auth';
import { parseQuery, ymd } from '@/lib/finanzas/agent/params';
import { caracasToday } from '@/lib/finanzas/dates';

const Query = z.object({ date: ymd.optional() });

export const GET = withAgent(async (req, { admin }) => {
  const q = parseQuery(req, Query);
  if (!q.ok) return q.res;
  const date = q.data.date ?? caracasToday();

  const { data, error } = await admin.from('bcv_rates').select('rate').eq('rate_date', date).maybeSingle();
  if (error) throw new Error(`tasa BCV: ${error.message}`);

  return NextResponse.json({ date, rate: data?.rate ?? null });
});
