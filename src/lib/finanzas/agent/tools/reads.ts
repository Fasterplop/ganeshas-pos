// Herramientas de SOLO LECTURA del conector: tasa BCV, compras y gastos,
// pagos, saldos de cuentas y lo que hay en la Bandeja.
import { z } from 'zod';
import { defineTool, mustList } from '../tool';
import { uuid, ymd } from '../params';
import { fetchAllPages } from '@/lib/finanzas/queries';
import { caracasToday } from '@/lib/finanzas/dates';
import { round2, ACCOUNT_KIND_LABEL } from '@/lib/finanzas/money';

type Page<T> = PromiseLike<{ data: T[] | null; error: { message?: string } | null }>;

// ---------------------------------------------------------------------------
export const bcvTool = defineTool({
  name: 'tasa_bcv',
  title: 'Tasa BCV de un día',
  description:
    'Tasa BCV guardada para una fecha. rate=null significa que no hay: pregúntasela al dueño, no la inventes.',
  input: z.object({ date: ymd.optional().describe('Fecha AAAA-MM-DD. Por defecto hoy.') }),
  readOnly: true,
  async run({ admin }, { date }) {
    const d = date ?? caracasToday();
    const { data, error } = await admin.from('bcv_rates').select('rate').eq('rate_date', d).maybeSingle();
    if (error) throw new Error(`tasa BCV: ${error.message}`);
    return { date: d, rate: data?.rate ?? null };
  },
});

// ---------------------------------------------------------------------------
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

export const expensesTool = defineTool({
  name: 'listar_compras_gastos',
  title: 'Compras y gastos registrados',
  description:
    'Compras, gastos y fletes ya registrados. Úsala para encontrar la compra a la que va un abono (status=abiertas), revisar si algo ya está cargado o responder preguntas.',
  input: z.object({
    from: ymd.optional().describe('Desde (fecha de la compra).'),
    to: ymd.optional().describe('Hasta.'),
    kind: z.enum(['compra', 'gasto', 'envio']).optional(),
    supplier_id: uuid.optional(),
    category_id: uuid.optional(),
    status: z.enum(['pendiente', 'parcial', 'pagada', 'abiertas']).optional().describe('abiertas = pendiente o parcial.'),
    q: z.string().max(100).optional().describe('Texto en la descripción o el nombre del proveedor.'),
    include_personal: z.boolean().optional(),
    limit: z.coerce.number().int().min(1).max(2000).default(300),
  }),
  readOnly: true,
  async run({ admin }, q) {
    let term: string | undefined;
    let supplierMatches: string[] = [];
    if (q.q) {
      term = q.q.replace(/[%,()]/g, ' ').trim() || undefined;
      if (term) {
        const rows = mustList(
          await admin.from('fin_suppliers').select('id').ilike('name', `%${term}%`).limit(50),
          'proveedores',
        );
        supplierMatches = rows.map((r: { id: string }) => r.id);
      }
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
      if (term) {
        const ors = [`description.ilike.%${term}%`];
        if (supplierMatches.length) ors.push(`supplier_id.in.(${supplierMatches.join(',')})`);
        query = query.or(ors.join(','));
      }
      return query.range(from, to) as unknown as Page<ExpenseRow>;
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

    return {
      total: items.length,
      total_usd: round2(items.reduce((s, i) => s + i.monto_usd, 0)),
      falta_usd: round2(items.reduce((s, i) => s + Math.max(i.falta_usd, 0), 0)),
      items,
    };
  },
});

// ---------------------------------------------------------------------------
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
  expense: { kind: string; description: string | null; supplier: { name: string } | null } | null;
}

export const paymentsTool = defineTool({
  name: 'listar_pagos',
  title: 'Pagos registrados',
  description:
    'Pagos y abonos ya registrados, con la cuenta o tarjeta usada. Sirve para ver si un cargo del banco ya está en el sistema.',
  input: z.object({
    account_id: uuid.optional(),
    from: ymd.optional(),
    to: ymd.optional(),
    limit: z.coerce.number().int().min(1).max(3000).default(500),
  }),
  readOnly: true,
  async run({ admin }, q) {
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
      return query.range(from, to) as unknown as Page<PaymentRow>;
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

    return { total: items.length, total_usd: round2(items.reduce((s, i) => s + i.monto_usd, 0)), items };
  },
});

// ---------------------------------------------------------------------------
export const accountsTool = defineTool({
  name: 'saldos_cuentas',
  title: 'Saldos de cuentas y tarjetas',
  description:
    'Saldo de cada cuenta y deuda de cada tarjeta tal como están en Finanzas > Cuentas. Son manuales: solo lectura.',
  input: z.object({ include_personal: z.boolean().optional() }),
  readOnly: true,
  async run({ admin }, { include_personal }) {
    let query = admin
      .from('fin_v_account_balance')
      .select(
        'account_id, name, kind, bank_name, last4, is_personal, credit_limit_usd, statement_day, due_day, balance_usd, available_usd, moved_usd',
      )
      .eq('is_active', true)
      .order('name');
    if (!include_personal) query = query.eq('is_personal', false);

    const rows = mustList(await query, 'cuentas');
    return {
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
    };
  },
});

// ---------------------------------------------------------------------------
export const listProposalsTool = defineTool({
  name: 'ver_bandeja',
  title: 'Qué hay en la Bandeja',
  description: 'Propuestas esperando aprobación del dueño en Finanzas > Bandeja (o las aprobadas/descartadas).',
  input: z.object({
    status: z.enum(['pendiente', 'aprobada', 'descartada']).default('pendiente'),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  }),
  readOnly: true,
  async run({ admin }, { status, limit }) {
    const rows = mustList(
      await admin
        .from('fin_inbox')
        .select(
          'id, source_file, raw_text, kind, movement_date, currency, amount, amount_usd, description, supplier_name_new, warning, approve_error, created_at, supplier:fin_suppliers(name), category:fin_categories(name), account:fin_accounts(name, last4)',
        )
        .eq('status', status)
        .order('created_at', { ascending: false })
        .limit(limit),
      'bandeja',
    );

    return {
      estado: status,
      total: rows.length,
      total_usd: round2(rows.reduce((s: number, r: { amount_usd: number }) => s + Number(r.amount_usd), 0)),
      items: rows.map((r: Record<string, unknown>) => {
        const supplier = r.supplier as { name: string } | null;
        const category = r.category as { name: string } | null;
        const account = r.account as { name: string; last4: string | null } | null;
        return {
          id: r.id,
          archivo: r.source_file,
          banco: r.raw_text,
          tipo: r.kind,
          fecha: r.movement_date,
          monto_usd: Number(r.amount_usd),
          proveedor: supplier?.name ?? r.supplier_name_new ?? null,
          categoria: category?.name ?? null,
          cuenta: account ? `${account.name}${account.last4 ? ' ···· ' + account.last4 : ''}` : null,
          descripcion: r.description,
          aviso: r.warning,
          error_al_aprobar: r.approve_error,
        };
      }),
    };
  },
});
