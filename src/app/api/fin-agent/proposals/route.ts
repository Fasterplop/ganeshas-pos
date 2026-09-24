// /api/fin-agent/proposals
//
// POST: el GPT manda las líneas del estado de cuenta ya clasificadas. Cada una
//       cae en la Bandeja (fin_inbox) como "pendiente". NADA se registra en
//       compras, gastos ni pagos hasta que el dueño apruebe en la app.
// GET:  qué está esperando aprobación.
//
// Detección de repetidos, en este orden:
//   1. dedup_key ya está en la bandeja (pendiente, aprobada o descartada)
//      → subir dos veces el mismo archivo no duplica ni revive lo descartado.
//   2. Ya hay un pago en esa cuenta, ese día y por ese monto (o con la misma
//      referencia) → "ya_existe". Dos cobros idénticos en el mismo archivo
//      cuentan como dos: solo se saltan tantos como pagos iguales ya haya.
//   3. Parecidos (mismo monto ±3 días, o una compra pendiente del proveedor por
//      ese monto) → se agrega igual, con un aviso para el dueño.
//
// !! Nunca crea movimientos de cuenta (fin_account_movements): el saldo de
// cuentas y tarjetas es manual. account_id es solo la forma de pago.
import { createHash, randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAgent, jsonError, mustList } from '@/lib/finanzas/agent/auth';
import { addDays, diffDays, parseQuery, uuid, ymd, zodMessage } from '@/lib/finanzas/agent/params';
import { fetchAllPages } from '@/lib/finanzas/queries';
import { round2 } from '@/lib/finanzas/money';
import { formatDate } from '@/lib/finanzas/dates';

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------
const Line = z.object({
  line_no: z.number().int().min(0).optional(),
  raw_text: z.string().trim().min(1).max(500),
  kind: z.enum(['compra', 'gasto', 'abono']),
  date: ymd,
  amount: z.number().positive(),
  currency: z.enum(['USD', 'VES']).default('USD'),
  bcv_rate: z.number().positive().optional(),
  account_id: uuid.optional(),
  supplier_id: uuid.optional(),
  supplier_name: z.string().trim().max(120).optional(),
  category_id: uuid.optional(),
  expense_id: uuid.optional(),
  description: z.string().trim().max(300).optional(),
  due_date: ymd.optional(),
  paid: z.boolean().default(true),
  is_personal: z.boolean().default(false),
  reference: z.string().trim().max(100).optional(),
  note: z.string().trim().max(500).optional(),
});

const Body = z.object({
  source_file: z.string().trim().max(200).optional(),
  lines: z.array(Line).min(1).max(300),
});

type LineIn = z.infer<typeof Line>;

type LineResult =
  | { line_no: number; raw_text: string; resultado: 'agregada'; inbox_id: string; aviso?: string }
  | { line_no: number; raw_text: string; resultado: 'ya_existe'; detalle: string }
  | { line_no: number; raw_text: string; resultado: 'ya_en_bandeja'; estado: string }
  | { line_no: number; raw_text: string; resultado: 'error'; detalle: string };

interface PaymentLite {
  id: string;
  account_id: string;
  amount_usd: number;
  paid_at: string;
  reference: string | null;
  expense: { supplier: { name: string } | null; description: string | null } | null;
}

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const sameMoney = (a: number, b: number) => Math.abs(a - b) <= 0.01;

function paymentLabel(p: PaymentLite): string {
  const who = p.expense?.supplier?.name ?? p.expense?.description ?? 'sin descripción';
  return `$${Number(p.amount_usd).toFixed(2)} del ${formatDate(p.paid_at)} (${who})`;
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------
export const POST = withAgent(async (req, { admin, profileId }) => {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return jsonError(400, 'El cuerpo debe ser JSON.');
  }
  const parsed = Body.safeParse(json);
  if (!parsed.success) return jsonError(400, zodMessage(parsed.error));
  const { source_file, lines } = parsed.data;

  // --- Maestros que se usan para validar ------------------------------------
  const accountIds = [...new Set(lines.map((l) => l.account_id).filter(Boolean))] as string[];
  const categoryIds = [...new Set(lines.map((l) => l.category_id).filter(Boolean))] as string[];
  const expenseIds = [...new Set(lines.map((l) => l.expense_id).filter(Boolean))] as string[];
  const vesDates = [...new Set(lines.filter((l) => l.currency === 'VES').map((l) => l.date))];

  const [accountsRes, categoriesRes, expensesRes, ratesRes, suppliersRes] = await Promise.all([
    accountIds.length
      ? admin.from('fin_accounts').select('id').in('id', accountIds)
      : Promise.resolve({ data: [], error: null }),
    categoryIds.length
      ? admin.from('fin_categories').select('id').in('id', categoryIds)
      : Promise.resolve({ data: [], error: null }),
    expenseIds.length
      ? admin.from('fin_expenses').select('id, amount_usd, paid_usd').in('id', expenseIds)
      : Promise.resolve({ data: [], error: null }),
    vesDates.length
      ? admin.from('bcv_rates').select('rate_date, rate').in('rate_date', vesDates)
      : Promise.resolve({ data: [], error: null }),
    fetchAllPages<{ id: string; name: string }>((from, to) =>
      admin.from('fin_suppliers').select('id, name').range(from, to),
    ),
  ]);
  if (suppliersRes.error) throw new Error(`proveedores: ${suppliersRes.error.message}`);

  const validAccounts = new Set(mustList(accountsRes, 'cuentas').map((a: { id: string }) => a.id));
  const validCategories = new Set(mustList(categoriesRes, 'categorías').map((c: { id: string }) => c.id));
  const expensesById = new Map(
    mustList(expensesRes, 'compras').map((e: { id: string; amount_usd: number; paid_usd: number }) => [e.id, e]),
  );
  const rateByDate = new Map(
    mustList(ratesRes, 'tasas').map((r: { rate_date: string; rate: number }) => [r.rate_date, Number(r.rate)]),
  );
  const suppliersById = new Map(suppliersRes.rows.map((s) => [s.id, s.name]));
  const supplierByName = new Map(suppliersRes.rows.map((s) => [norm(s.name), s.id]));

  // --- Paso 1: normalizar y validar cada línea ------------------------------
  interface Prepared {
    idx: number;
    line: LineIn;
    line_no: number;
    supplier_id: string | null;
    supplier_name_new: string | null;
    bcv_rate: number | null;
    amount_usd: number;
    paid: boolean;
    baseKey: string;
    dedup_key: string;
    warnings: string[];
  }

  const results: (LineResult | null)[] = new Array(lines.length).fill(null);
  const prepared: Prepared[] = [];
  const occurrences = new Map<string, number>();

  lines.forEach((line, idx) => {
    const line_no = line.line_no ?? idx + 1;
    const fail = (detalle: string) => {
      results[idx] = { line_no, raw_text: line.raw_text, resultado: 'error', detalle };
    };
    const warnings: string[] = [];

    if (line.account_id && !validAccounts.has(line.account_id)) return fail('account_id no existe. Usa los de /context.');
    if (line.category_id && !validCategories.has(line.category_id)) return fail('category_id no existe. Usa los de /context.');
    if (line.supplier_id && !suppliersById.has(line.supplier_id)) return fail('supplier_id no existe. Usa los de /context.');

    // Tasa: la del GPT, o la guardada ese día. Sin tasa no se puede convertir.
    let bcv_rate: number | null = null;
    if (line.currency === 'VES') {
      const stored = rateByDate.get(line.date) ?? null;
      bcv_rate = line.bcv_rate ?? stored;
      if (!bcv_rate) {
        return fail(`No hay tasa BCV guardada para el ${formatDate(line.date)}. Pregúntasela al dueño y reenvía la línea con bcv_rate.`);
      }
      if (line.bcv_rate && stored && Math.abs(line.bcv_rate - stored) / stored > 0.005) {
        warnings.push(`La tasa usada (${line.bcv_rate}) no es la guardada para ese día (${stored}).`);
      }
    }
    const amount_usd = line.currency === 'USD' ? round2(line.amount) : round2(line.amount / (bcv_rate as number));
    if (amount_usd <= 0) return fail('El monto en dólares da 0.');

    // Proveedor: por id, o por nombre (se reutiliza si ya existe).
    let supplier_id = line.supplier_id ?? null;
    let supplier_name_new: string | null = null;
    if (!supplier_id && line.supplier_name) {
      supplier_id = supplierByName.get(norm(line.supplier_name)) ?? null;
      if (!supplier_id) {
        supplier_name_new = line.supplier_name;
        warnings.push(`Proveedor nuevo: "${line.supplier_name}". Se crea al aprobar.`);
      }
    }

    let paid = line.paid;
    if (line.kind === 'abono') {
      paid = true;
      if (!line.expense_id) return fail('Un abono necesita expense_id (búscalo en /expenses?status=abiertas).');
      const exp = expensesById.get(line.expense_id);
      if (!exp) return fail('expense_id no existe.');
      const falta = round2(Number(exp.amount_usd) - Number(exp.paid_usd));
      if (amount_usd > falta + 0.01) {
        return fail(`El abono ($${amount_usd.toFixed(2)}) pasa de lo que falta por pagar ($${Math.max(falta, 0).toFixed(2)}).`);
      }
    } else if (line.kind === 'compra' && !supplier_id && !supplier_name_new) {
      return fail('Una compra necesita proveedor (supplier_id o supplier_name).');
    }

    if (paid && !line.account_id) warnings.push('Falta la cuenta o tarjeta con que se pagó: complétala antes de aprobar.');
    if (line.is_personal) warnings.push('Marcada como personal.');

    const refPart = line.reference
      ? `r:${norm(line.reference)}`
      : `h:${createHash('sha1').update(norm(line.raw_text)).digest('hex').slice(0, 16)}`;
    const baseKey = `${line.account_id ?? '-'}|${line.date}|${amount_usd.toFixed(2)}|${refPart}`;
    const n = (occurrences.get(baseKey) ?? 0) + 1;
    occurrences.set(baseKey, n);

    prepared.push({
      idx,
      line,
      line_no,
      supplier_id,
      supplier_name_new,
      bcv_rate,
      amount_usd,
      paid,
      baseKey,
      dedup_key: `${baseKey}|${n}`,
      warnings,
    });
  });

  // --- Paso 2: ¿ya está en la bandeja? -------------------------------------
  const keys = prepared.map((p) => p.dedup_key);
  const inboxByKey = new Map<string, string>();
  for (let i = 0; i < keys.length; i += 200) {
    const chunk = keys.slice(i, i + 200);
    const rows = mustList(
      await admin.from('fin_inbox').select('dedup_key, status').in('dedup_key', chunk),
      'bandeja',
    );
    rows.forEach((r: { dedup_key: string; status: string }) => inboxByKey.set(r.dedup_key, r.status));
  }

  // --- Paso 3: ¿ya está pagado en el sistema? ------------------------------
  const dates = prepared.map((p) => p.line.date).sort();
  let payments: PaymentLite[] = [];
  if (prepared.length) {
    const from = addDays(dates[0], -3);
    const to = addDays(dates[dates.length - 1], 3);
    const res = await fetchAllPages<PaymentLite>((f, t) =>
      admin
        .from('fin_payments')
        .select('id, account_id, amount_usd, paid_at, reference, expense:fin_expenses(description, supplier:fin_suppliers(name))')
        .gte('paid_at', from)
        .lte('paid_at', to)
        .range(f, t) as unknown as PromiseLike<{ data: PaymentLite[] | null; error: { message?: string } | null }>,
    );
    if (res.error) throw new Error(`pagos: ${res.error.message}`);
    payments = res.rows;
  }

  // Referencias: se buscan sin límite de fecha (una referencia es única).
  const refs = [...new Set(prepared.map((p) => p.line.reference).filter(Boolean))] as string[];
  const paymentsByRef = (
    refs.length
      ? mustList(
          await admin
            .from('fin_payments')
            .select('id, account_id, amount_usd, paid_at, reference, expense:fin_expenses(description, supplier:fin_suppliers(name))')
            .in('reference', refs),
          'pagos por referencia',
        )
      : []
  ) as unknown as PaymentLite[];

  // Compras abiertas de los proveedores del lote: una "compra pagada" que
  // coincide con una pendiente probablemente es un abono a esa compra.
  const supplierIds = [...new Set(prepared.map((p) => p.supplier_id).filter(Boolean))] as string[];
  const openExpenses = supplierIds.length
    ? mustList(
        await admin
          .from('fin_expenses')
          .select('id, supplier_id, amount_usd, paid_usd, expense_date')
          .in('supplier_id', supplierIds)
          .neq('status', 'pagada')
          .limit(1000),
        'compras abiertas',
      )
    : [];

  // Compras sin pagar ya cargadas (para propuestas con paid=false).
  const unpaidDupCandidates = supplierIds.length
    ? mustList(
        await admin
          .from('fin_expenses')
          .select('id, supplier_id, amount_usd, expense_date')
          .in('supplier_id', supplierIds)
          .gte('expense_date', dates[0])
          .lte('expense_date', dates[dates.length - 1])
          .limit(1000),
        'compras',
      )
    : [];

  // Cuántos pagos exactos hay por baseKey "cuenta|fecha|monto": se consumen
  // en orden, así el 2º cobro idéntico solo se salta si hay 2 pagos iguales.
  const usedPayments = new Set<string>();
  const toInsert: Record<string, unknown>[] = [];
  const insertIdx: Prepared[] = [];

  for (const p of prepared) {
    const { line, line_no } = p;
    const base = { line_no, raw_text: line.raw_text };

    const inboxStatus = inboxByKey.get(p.dedup_key);
    if (inboxStatus) {
      results[p.idx] = { ...base, resultado: 'ya_en_bandeja', estado: inboxStatus };
      continue;
    }

    if (p.paid) {
      const byRef = line.reference
        ? paymentsByRef.find(
            (x) => !usedPayments.has(x.id) && x.reference && norm(x.reference) === norm(line.reference as string) && (!line.account_id || x.account_id === line.account_id),
          )
        : undefined;
      const exact =
        byRef ??
        payments.find(
          (x) =>
            !usedPayments.has(x.id) &&
            (!line.account_id || x.account_id === line.account_id) &&
            x.paid_at === line.date &&
            sameMoney(Number(x.amount_usd), p.amount_usd),
        );
      if (exact) {
        usedPayments.add(exact.id);
        results[p.idx] = { ...base, resultado: 'ya_existe', detalle: `Ya registrado: pago de ${paymentLabel(exact)}.` };
        continue;
      }
      const near = payments.find(
        (x) =>
          !usedPayments.has(x.id) &&
          sameMoney(Number(x.amount_usd), p.amount_usd) &&
          Math.abs(diffDays(x.paid_at, line.date)) <= 3,
      );
      if (near) p.warnings.push(`Posible duplicado: ya hay un pago de ${paymentLabel(near)}.`);
    } else if (p.supplier_id) {
      const dup = unpaidDupCandidates.find(
        (e: { supplier_id: string; amount_usd: number; expense_date: string }) =>
          e.supplier_id === p.supplier_id && e.expense_date === line.date && sameMoney(Number(e.amount_usd), p.amount_usd),
      );
      if (dup) {
        results[p.idx] = { ...base, resultado: 'ya_existe', detalle: `Ya hay una compra de ese proveedor por $${p.amount_usd.toFixed(2)} el ${formatDate(line.date)}.` };
        continue;
      }
    }

    if (line.kind === 'compra' && p.paid && p.supplier_id) {
      const open = openExpenses.find(
        (e: { supplier_id: string; amount_usd: number; paid_usd: number }) =>
          e.supplier_id === p.supplier_id && sameMoney(Number(e.amount_usd) - Number(e.paid_usd), p.amount_usd),
      );
      if (open) {
        p.warnings.push(
          `Hay una compra pendiente de este proveedor del ${formatDate(open.expense_date)} por $${p.amount_usd.toFixed(2)}: quizá esto es el pago de esa compra (abono), no una compra nueva.`,
        );
      }
    }

    toInsert.push({
      batch_id: '', // se completa abajo
      source_file: source_file ?? null,
      line_no,
      raw_text: line.raw_text,
      kind: line.kind,
      supplier_id: line.kind === 'abono' ? null : p.supplier_id,
      supplier_name_new: line.kind === 'abono' ? null : p.supplier_name_new,
      category_id: line.kind === 'abono' ? null : line.category_id ?? null,
      expense_id: line.kind === 'abono' ? line.expense_id : null,
      account_id: line.account_id ?? null,
      description: line.description ?? null,
      currency: line.currency,
      amount: line.amount,
      bcv_rate: p.bcv_rate,
      amount_usd: p.amount_usd,
      movement_date: line.date,
      due_date: line.due_date ?? null,
      paid: p.paid,
      is_personal: line.is_personal,
      reference: line.reference ?? null,
      dedup_key: p.dedup_key,
      warning: p.warnings.length ? p.warnings.join(' ') : null,
      ai_note: line.note ?? null,
      created_by: profileId,
    });
    insertIdx.push(p);
  }

  // --- Paso 4: guardar en la bandeja ---------------------------------------
  const batch_id = randomUUID();
  if (toInsert.length) {
    toInsert.forEach((r) => (r.batch_id = batch_id));
    // ignoreDuplicates: si otra petición metió la misma línea entre medio,
    // el índice único gana y esa fila simplemente no vuelve en el select.
    const inserted = mustList(
      await admin
        .from('fin_inbox')
        .upsert(toInsert, { onConflict: 'dedup_key', ignoreDuplicates: true })
        .select('id, dedup_key'),
      'guardar en la bandeja',
    );
    const idByKey = new Map(inserted.map((r: { id: string; dedup_key: string }) => [r.dedup_key, r.id]));
    for (const p of insertIdx) {
      const id = idByKey.get(p.dedup_key);
      results[p.idx] = id
        ? { line_no: p.line_no, raw_text: p.line.raw_text, resultado: 'agregada', inbox_id: id, ...(p.warnings.length ? { aviso: p.warnings.join(' ') } : {}) }
        : { line_no: p.line_no, raw_text: p.line.raw_text, resultado: 'ya_en_bandeja', estado: 'pendiente' };
    }
  }

  const final = results as LineResult[];
  const count = (r: LineResult['resultado']) => final.filter((x) => x.resultado === r).length;
  const addedUsd = round2(
    insertIdx.filter((p) => final[p.idx].resultado === 'agregada').reduce((s, p) => s + p.amount_usd, 0),
  );

  return NextResponse.json({
    batch_id,
    resumen: {
      agregadas: count('agregada'),
      agregadas_usd: addedUsd,
      ya_existian: count('ya_existe'),
      ya_en_bandeja: count('ya_en_bandeja'),
      con_error: count('error'),
    },
    siguiente_paso:
      'Lo agregado quedó en Finanzas > Bandeja esperando aprobación del dueño. Nada se registró todavía. Las líneas con error se pueden corregir y reenviar.',
    lineas: final,
  });
});

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------
const Query = z.object({
  status: z.enum(['pendiente', 'aprobada', 'descartada']).default('pendiente'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const GET = withAgent(async (req, { admin }) => {
  const parsed = parseQuery(req, Query);
  if (!parsed.ok) return parsed.res;
  const { status, limit } = parsed.data;

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

  return NextResponse.json({
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
  });
});
