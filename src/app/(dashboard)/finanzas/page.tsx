'use client';

// Resumen financiero del negocio.
//
// Responde las cuatro preguntas de la propuesta: cuánto entró, cuánto salió,
// cuánto queda y cuánto se debe.
//
// Los ingresos se LEEN de `sales` (la tabla del POS) sin escribir ni una fila:
// es el único punto donde este módulo toca el resto del sistema.
//
// «Ventas por tienda» y «Cobros por tienda y forma de pago» (pedido de Gerardo,
// 23-nov-2026): cuánto entró por cada forma de pago, para declarar. Se arma con
// src/lib/finanzas/cobros.ts, con la misma regla que el desglose de Reportes.
//
// La pantalla sigue el dibujo de Gerardo: filtro de tienda y fechas, cuatro
// tarjetas (ventas, compras y gastos, gastos operativos, efectivo), ventas por
// tienda, cobros por tienda y forma de pago, próximos pagos y dónde está el
// dinero. El filtro de tienda solo toca lo que sale de las ventas.
//
// Ojo al comparar con /dashboard:
//   - "Salió" es lo devengado (lo que se compró y se gastó en el período),
//     no lo que se pagó. Lo pagado se ve en el movimiento de cada cuenta.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowLeftRight,
  Banknote,
  ChartNoAxesColumn,
  ChevronRight,
  CreditCard,
  FileText,
  Package,
  Shirt,
  ShoppingCart,
  Smartphone,
  Store as StoreIcon,
  ToyBrick,
} from 'lucide-react';
import CasheaLogo from '@/components/CasheaLogo';
import { createClient } from '@/lib/supabase/client';
import { useFinanceFilters } from '@/store/useFinanceFilters';
import { usePOSStore, type Store } from '@/store/usePOSStore';
import { buildCobros, cobrosDeVenta, COBRO_METHODS, type CobroAbono } from '@/lib/finanzas/cobros';
import FinShell from '@/components/finanzas/FinShell';
import type { Expense, Category } from '@/components/finanzas/ExpenseFormModal';
import type { Account } from '@/components/finanzas/AccountFormModal';
import type { Supplier } from '@/components/finanzas/SupplierFormModal';
import {
  FinNotice,
  Notice,
  DueBadge,
  btnSecondary,
  inputClass,
} from '@/components/finanzas/ui';
import { fetchAllPages } from '@/lib/finanzas/queries';
import { finErrorMessage } from '@/lib/finanzas/errors';
import {
  caracasBounds,
  caracasMonthStart,
  caracasToday,
  formatDate,
  parseSupabaseDate,
  daysUntil,
} from '@/lib/finanzas/dates';
import { fmtUSD, round2, accountLabel } from '@/lib/finanzas/money';
import { downloadFinWorkbook, finFilename, FMT_USD } from '@/lib/finanzas/excel';

interface SaleRow {
  id: string;
  total_amount: number;
  bcv_rate: number;
  created_at: string;
  kind: string;
  store_id: string;
  payment_method: string | null;
  payment_method_2: string | null;
  payment_amount_1: number | null;
  payment_amount_2: number | null;
  cashea_initial_usd: number | null;
  cashea_initial_method: string | null;
  cashea_initial_method_2: string | null;
  cashea_initial_amount_2: number | null;
}

type AbonoRow = CobroAbono & { created_at: string };

const COBRO_LABEL: Record<string, string> = Object.fromEntries(COBRO_METHODS.map((m) => [m.key, m.label]));

// Íconos del dibujo: cada forma de pago en su cuadrito de color.
const METHOD_ICON: Record<string, { Icon: LucideIcon; box: string }> = {
  efectivo: { Icon: Banknote, box: 'bg-emerald-100 text-emerald-700' },
  punto_de_venta: { Icon: CreditCard, box: 'bg-sky-100 text-sky-600' },
  zelle: { Icon: ArrowLeftRight, box: 'bg-violet-100 text-violet-600' },
  pago_movil: { Icon: Smartphone, box: 'bg-indigo-100 text-indigo-700' },
};
const renderMethodIcon = (key: string) => {
  if (key === 'cashea' || key === 'cashea_sin_metodo') return <CasheaLogo className="w-8 h-8 rounded-lg" />;
  const m = METHOD_ICON[key] ?? { Icon: Banknote, box: 'bg-slate-100 text-slate-500' };
  return (
    <span className={`w-8 h-8 rounded-lg ${m.box} flex items-center justify-center shrink-0`}>
      <m.Icon className="w-4 h-4" aria-hidden />
    </span>
  );
};
// La tienda de ropa lleva ropa; la de juguetes, un juguete (como el dibujo).
const storeIconOf = (name: string): LucideIcon =>
  /ropa/i.test(name) ? Shirt : /jugu/i.test(name) ? ToyBrick : StoreIcon;

interface PaymentRow {
  id: string;
  expense_id: string;
  account_id: string;
  currency: string;
  amount: number;
  bcv_rate: number | null;
  amount_usd: number;
  paid_at: string;
  reference: string | null;
}

interface BalanceRow {
  account_id: string;
  name: string;
  kind: string;
  is_personal: boolean;
  is_active: boolean;
  balance_usd: number;
  available_usd: number | null;
  credit_limit_usd: number | null;
}

const KIND_LABEL: Record<string, string> = { compra: 'Compra', gasto: 'Gasto', envio: 'Envío' };

export default function ResumenPage() {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const { dateRange, setDateRange } = useFinanceFilters();
  const setCurrentStore = usePOSStore((st) => st.setCurrentStore);

  const [sales, setSales] = useState<SaleRow[]>([]);
  const [abonos, setAbonos] = useState<AbonoRow[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  // «Tienda» del dibujo: filtra lo que viene de las ventas (tarjeta de ventas,
  // ventas por tienda y cobros). Compras, gastos y efectivo son del negocio.
  const [storeFilter, setStoreFilter] = useState<string>('all');
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [balances, setBalances] = useState<BalanceRow[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [exporting, setExporting] = useState<'movimientos' | 'contador' | null>(null);

  const hoy = caracasToday();

  const load = useCallback(async () => {
    setLoading(true);
    const { fromISO, toISO } = caracasBounds(dateRange.start, dateRange.end);

    // Ventas: SOLO LECTURA. Paginado, porque PostgREST corta en 1000 sin avisar
    // y un total de ingresos truncado seria el peor error posible aqui.
    const { rows: saleRows, error: saleErr } = await fetchAllPages<SaleRow>((from, to) =>
      supabase
        .from('sales')
        .select(
          'id, total_amount, bcv_rate, created_at, kind, store_id, payment_method, payment_method_2, payment_amount_1, payment_amount_2, cashea_initial_usd, cashea_initial_method, cashea_initial_method_2, cashea_initial_amount_2',
        )
        .gte('created_at', fromISO)
        .lte('created_at', toISO)
        .order('created_at', { ascending: false })
        .range(from, to),
    );
    if (saleErr) setNotice({ type: 'error', text: `Ventas: ${finErrorMessage(saleErr)}` });

    // Abonos de fiado del período (db/fiado_02_schema.sql): son dinero que
    // entró, en su método, el día del abono. Sin la tabla, la lista va vacía.
    const { rows: abonoRows } = await fetchAllPages<AbonoRow>((from, to) =>
      supabase
        .from('fiado_payments')
        .select('store_id, amount_usd, payment_method, bcv_rate, created_at')
        .gte('created_at', fromISO)
        .lte('created_at', toISO)
        .order('created_at', { ascending: false })
        .range(from, to),
    );
    const { data: storeRows } = await supabase.from('stores').select('id, name, is_active').order('name');

    // TODOS los egresos abiertos, mas los del periodo: la deuda no se filtra
    // por fechas, es lo que se debe hoy.
    const { rows: expRows, error: expErr } = await fetchAllPages<Expense>((from, to) =>
      supabase
        .from('fin_expenses')
        .select(
          'id, kind, supplier_id, category_id, shipment_id, description, currency, amount, bcv_rate, amount_usd, expense_date, due_date, paid_usd, status, is_personal, receipt_path, notes, created_at',
        )
        .eq('is_personal', false)
        .order('expense_date', { ascending: false })
        .range(from, to),
    );
    if (expErr) {
      setNotice({ type: 'error', text: finErrorMessage(expErr) });
      setLoading(false);
      return;
    }

    const [pay, bal, acc, sup, cat] = await Promise.all([
      fetchAllPages<PaymentRow>((from, to) =>
        supabase
          .from('fin_payments')
          .select('id, expense_id, account_id, currency, amount, bcv_rate, amount_usd, paid_at, reference')
          .gte('paid_at', dateRange.start)
          .lte('paid_at', dateRange.end)
          .order('paid_at', { ascending: false })
          .range(from, to),
      ),
      fetchAllPages<BalanceRow>((from, to) =>
        supabase
          .from('fin_v_account_balance')
          .select('account_id, name, kind, is_personal, is_active, balance_usd, available_usd, credit_limit_usd')
          .range(from, to),
      ),
      fetchAllPages<Account>((from, to) =>
        supabase
          .from('fin_accounts')
          .select(
            'id, name, kind, bank_name, last4, currency, opening_balance_usd, opening_balance_date, credit_limit_usd, statement_day, due_day, is_personal, is_active, notes',
          )
          .order('name')
          .range(from, to),
      ),
      fetchAllPages<Supplier>((from, to) =>
        supabase
          .from('fin_suppliers')
          .select('id, name, contact_name, phone, email, payment_terms, notes, is_active')
          .order('name')
          .range(from, to),
      ),
      fetchAllPages<Category>((from, to) =>
        supabase.from('fin_categories').select('id, name, kind, is_active').order('sort_order').range(from, to),
      ),
    ]);

    setSales(saleRows);
    setAbonos(abonoRows);
    setStores((storeRows ?? []) as Store[]);
    setExpenses(expRows);
    setPayments(pay.rows);
    setBalances(bal.rows);
    setAccounts(acc.rows);
    setSuppliers(sup.rows);
    setCategories(cat.rows);
    setLoading(false);
  }, [supabase, dateRange]);

  useEffect(() => {
    load();
  }, [load]);

  const supplierName = useCallback(
    (id: string | null) => suppliers.find((s) => s.id === id)?.name ?? null,
    [suppliers],
  );
  const categoryName = useCallback(
    (id: string | null) => categories.find((c) => c.id === id)?.name ?? '',
    [categories],
  );
  const accountName = useCallback(
    (id: string) => accountLabel(accounts.find((a) => a.id === id)),
    [accounts],
  );
  const saldoDe = (e: Expense) => round2(Number(e.amount_usd) - Number(e.paid_usd));

  const delPeriodo = useMemo(
    () => expenses.filter((e) => e.expense_date >= dateRange.start && e.expense_date <= dateRange.end),
    [expenses, dateRange],
  );

  const kpi = useMemo(() => {
    const entro = sales.reduce((a, s) => a + Number(s.total_amount), 0);
    const compras = delPeriodo.filter((e) => e.kind === 'compra').reduce((a, e) => a + Number(e.amount_usd), 0);
    const gastos = delPeriodo.filter((e) => e.kind === 'gasto').reduce((a, e) => a + Number(e.amount_usd), 0);
    const envios = delPeriodo.filter((e) => e.kind === 'envio').reduce((a, e) => a + Number(e.amount_usd), 0);
    const salio = round2(compras + gastos + envios);

    const abiertas = expenses.filter((e) => e.status !== 'pagada');
    const deuda = abiertas.reduce((a, e) => a + saldoDe(e), 0);
    const vencido = abiertas
      .filter((e) => e.due_date && e.due_date < hoy)
      .reduce((a, e) => a + saldoDe(e), 0);
    const proximos = abiertas.filter((e) => {
      const d = daysUntil(e.due_date);
      return d !== null && d >= 0 && d <= 7;
    });

    const activas = balances.filter((b) => b.is_active && !b.is_personal);
    const efectivo = activas
      .filter((b) => b.kind !== 'tarjeta_credito')
      .reduce((a, b) => a + Number(b.balance_usd), 0);
    const tarjetas = activas
      .filter((b) => b.kind === 'tarjeta_credito')
      .reduce((a, b) => a + Number(b.balance_usd), 0);

    // Dos lecturas distintas y las dos utiles:
    //   salio  = lo que COSTO el periodo (devengado)
    //   pagado = lo que de verdad SALIO de las cuentas en el periodo (caja)
    // Una compra a 30 dias entra en `salio` el dia que se compra y en
    // `pagado` el dia que se paga. Mostrar solo una escondia media verdad.
    const pagado = payments.reduce((a, p) => a + Number(p.amount_usd), 0);

    return {
      entro: round2(entro),
      salio,
      pagado: round2(pagado),
      compras: round2(compras),
      gastos: round2(gastos),
      envios: round2(envios),
      queda: round2(entro - salio),
      deuda: round2(deuda),
      vencido: round2(vencido),
      proximos,
      proximosTotal: round2(proximos.reduce((a, e) => a + saldoDe(e), 0)),
      efectivo: round2(efectivo),
      tarjetas: round2(tarjetas),
      ventasCount: sales.length,
    };
  }, [sales, delPeriodo, expenses, balances, payments, hoy]);

  // Cobros por tienda y forma de pago, y ventas por tienda.
  const cobros = useMemo(() => buildCobros(sales, abonos), [sales, abonos]);
  const tiendas = useMemo(() => {
    const byStore = new Map<string, { total: number; ventas: number }>();
    for (const s of sales) {
      const row = byStore.get(s.store_id) ?? { total: 0, ventas: 0 };
      row.total += Number(s.total_amount) || 0;
      if (s.kind !== 'exchange') row.ventas += 1;
      byStore.set(s.store_id, row);
    }
    // Las tiendas activas siempre salen; una inactiva, solo si vendió o cobró en el período.
    return stores
      .filter((st) => st.is_active !== false || byStore.has(st.id) || (cobros.totalByStore[st.id] ?? 0) > 0)
      .map((st) => ({ ...st, total: round2(byStore.get(st.id)?.total ?? 0), ventas: byStore.get(st.id)?.ventas ?? 0 }));
  }, [sales, stores, cobros]);
  const activeStores = stores.filter((st) => st.is_active !== false);
  const storeSel = storeFilter === 'all' ? null : (stores.find((st) => st.id === storeFilter) ?? null);
  const salesF = useMemo(
    () => (storeSel ? sales.filter((s) => s.store_id === storeSel.id) : sales),
    [sales, storeSel],
  );
  const cobrosF = useMemo(
    () => (storeSel ? buildCobros(salesF, abonos.filter((a) => a.store_id === storeSel.id)) : cobros),
    [storeSel, salesF, abonos, cobros],
  );
  const tiendasF = storeSel ? tiendas.filter((st) => st.id === storeSel.id) : tiendas;
  const ventasF = useMemo(
    () => ({
      total: round2(salesF.reduce((a, s) => a + (Number(s.total_amount) || 0), 0)),
      count: salesF.filter((s) => s.kind !== 'exchange').length,
    }),
    [salesF],
  );
  const totalBsF = round2(
    Object.values(cobrosF.bs).reduce((a, byStore) => a + Object.values(byStore).reduce((x, v) => x + v, 0), 0),
  );
  const totalBs = useMemo(
    () => round2(Object.values(cobros.bs).reduce((a, byStore) => a + Object.values(byStore).reduce((x, v) => x + v, 0), 0)),
    [cobros],
  );
  const verEnReportes = (st: Store) => {
    setCurrentStore(st);
    router.push('/dashboard');
  };
  const formaDePago = (s: SaleRow) => {
    if (s.payment_method === 'fiado') return 'Fiado (se cobra en abonos)';
    const parts = cobrosDeVenta(s);
    if (parts.length === 0) return s.kind === 'exchange' ? 'Sin diferencia (cambio)' : '';
    if (parts.length === 1) return COBRO_LABEL[parts[0].method] ?? parts[0].method;
    return parts.map((p) => `${COBRO_LABEL[p.method] ?? p.method} ${fmtUSD(p.usd)}`).join(' + ');
  };


  // --- Exportaciones ---------------------------------------------------------
  const movimientosSheet = () => {
    const rows = [
      ...sales.map((s) => {
        const day = parseSupabaseDate(s.created_at)
          .toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });
        return {
          fecha: formatDate(day),
          _orden: day,
          tipo: 'Ingreso',
          detalle: s.kind === 'exchange' ? 'Cambio de producto' : 'Venta',
          forma: formaDePago(s),
          categoria: '',
          proveedor: '',
          cuenta: '',
          entrada: Number(s.total_amount),
          salida: 0,
          bs: round2(Number(s.total_amount) * Number(s.bcv_rate || 0)),
          tasa: Number(s.bcv_rate || 0),
        };
      }),
      ...payments.map((p) => {
        const exp = expenses.find((e) => e.id === p.expense_id);
        return {
          fecha: formatDate(p.paid_at),
          _orden: p.paid_at,
          tipo: 'Egreso',
          detalle: exp ? (exp.description ?? KIND_LABEL[exp.kind] ?? '') : 'Pago',
          forma: '',
          categoria: exp ? categoryName(exp.category_id) : '',
          proveedor: exp ? (supplierName(exp.supplier_id) ?? '') : '',
          cuenta: accountName(p.account_id),
          entrada: 0,
          salida: Number(p.amount_usd),
          bs: p.currency === 'VES' ? Number(p.amount) : 0,
          tasa: Number(p.bcv_rate ?? 0),
        };
      }),
    ].sort((a, b) => b._orden.localeCompare(a._orden));

    return {
      name: 'Movimientos',
      columns: [
        { header: 'Fecha', key: 'fecha', width: 13 },
        { header: 'Tipo', key: 'tipo', width: 11 },
        { header: 'Detalle', key: 'detalle', width: 30, wrap: true },
        { header: 'Forma de pago', key: 'forma', width: 24, wrap: true },
        { header: 'Categoría', key: 'categoria', width: 18 },
        { header: 'Proveedor', key: 'proveedor', width: 22 },
        { header: 'Cuenta usada', key: 'cuenta', width: 24 },
        { header: 'Entró USD', key: 'entrada', width: 14, numFmt: FMT_USD },
        { header: 'Salió USD', key: 'salida', width: 14, numFmt: FMT_USD },
        { header: 'Monto Bs', key: 'bs', width: 16 },
        { header: 'Tasa', key: 'tasa', width: 10 },
      ],
      rows,
      totals: {
        entrada: rows.reduce((a, r) => a + r.entrada, 0),
        salida: rows.reduce((a, r) => a + r.salida, 0),
      },
      totalsLabel: 'TOTALES',
      note: 'Ingresos = ventas del POS. Egresos = pagos registrados, con la cuenta que se usó. Ningún pago mueve el saldo de las cuentas: ese saldo se lleva a mano desde Cuentas.',
    };
  };

  // Cobros por tienda y forma de pago, en dólares y en bolívares (a la tasa de
  // cada venta o abono): la hoja para declarar.
  const cobrosSheet = () => {
    const rows = tiendas.flatMap((st) =>
      cobros.methods
        .filter((m) => (cobros.usd[m.key]?.[st.id] ?? 0) > 0)
        .map((m) => ({
          tienda: st.name,
          forma: m.label,
          usd: round2(cobros.usd[m.key]?.[st.id] ?? 0),
          bs: round2(cobros.bs[m.key]?.[st.id] ?? 0),
        })),
    );
    return {
      name: 'Cobros por forma de pago',
      columns: [
        { header: 'Tienda', key: 'tienda', width: 22 },
        { header: 'Forma de pago', key: 'forma', width: 28 },
        { header: 'Cobrado USD', key: 'usd', width: 16, numFmt: FMT_USD },
        { header: 'Cobrado Bs', key: 'bs', width: 18 },
      ],
      rows,
      totals: { usd: cobros.total, bs: totalBs },
      totalsLabel: 'TOTAL COBRADO',
      note: 'Lo que entró en el período por cada forma de pago. Cashea: la inicial va en el método con que se pagó y el resto en «Cashea (lo paga Cashea)». Un fiado cuenta el día de cada abono, en su método. Bs a la tasa BCV de cada venta.',
    };
  };

  const exportMovimientos = async () => {
    if (exporting) return;
    setExporting('movimientos');
    try {
      await downloadFinWorkbook({
        filename: finFilename('movimientos', dateRange.start, dateRange.end),
        cover: {
          title: 'Movimientos financieros',
          periodStart: dateRange.start,
          periodEnd: dateRange.end,
          extra: [
            ['Entró', fmtUSD(kpi.entro)],
            ['Salió (pagado)', fmtUSD(payments.reduce((a, p) => a + Number(p.amount_usd), 0))],
          ],
        },
        sheets: [movimientosSheet()],
      });
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : 'Error al exportar.' });
    } finally {
      setExporting(null);
    }
  };

  const exportContador = async () => {
    if (exporting) return;
    setExporting('contador');
    try {
      const abiertas = expenses.filter((e) => e.status !== 'pagada');
      await downloadFinWorkbook({
        filename: finFilename('paquete_contador', dateRange.start, dateRange.end),
        cover: {
          title: 'Paquete para el contador',
          periodStart: dateRange.start,
          periodEnd: dateRange.end,
          extra: [
            ['Entró', fmtUSD(kpi.entro)],
            ['Total cobrado', fmtUSD(cobros.total)],
            ['Salió', fmtUSD(kpi.salio)],
            ['Queda', fmtUSD(kpi.queda)],
            ['Deuda abierta', fmtUSD(kpi.deuda)],
          ],
        },
        sheets: [
          cobrosSheet(),
          movimientosSheet(),
          {
            name: 'Compras del período',
            columns: [
              { header: 'Fecha', key: 'fecha', width: 13 },
              { header: 'Proveedor', key: 'proveedor', width: 24 },
              { header: 'Concepto', key: 'concepto', width: 28, wrap: true },
              { header: 'Total USD', key: 'total', width: 14, numFmt: FMT_USD },
              { header: 'Abonado', key: 'abonado', width: 14, numFmt: FMT_USD },
              { header: 'Saldo', key: 'saldo', width: 14, numFmt: FMT_USD },
              { header: 'Estado', key: 'estado', width: 12 },
            ],
            rows: delPeriodo
              .filter((e) => e.kind === 'compra')
              .map((e) => ({
                fecha: formatDate(e.expense_date),
                proveedor: supplierName(e.supplier_id) ?? '',
                concepto: e.description ?? '',
                total: Number(e.amount_usd),
                abonado: Number(e.paid_usd),
                saldo: saldoDe(e),
                estado:
                  { pagada: 'Pagada', parcial: 'Parcial', pendiente: 'Pendiente' }[e.status] ?? e.status,
              })),
            totals: {
              total: delPeriodo.filter((e) => e.kind === 'compra').reduce((a, e) => a + Number(e.amount_usd), 0),
            },
            totalsLabel: 'TOTAL',
          },
          {
            name: 'Gastos del período',
            columns: [
              { header: 'Fecha', key: 'fecha', width: 13 },
              { header: 'Concepto', key: 'concepto', width: 30, wrap: true },
              { header: 'Categoría', key: 'categoria', width: 20 },
              { header: 'Tipo', key: 'tipo', width: 12 },
              { header: 'Total USD', key: 'total', width: 14, numFmt: FMT_USD },
              { header: 'Estado', key: 'estado', width: 12 },
            ],
            rows: delPeriodo
              .filter((e) => e.kind !== 'compra')
              .map((e) => ({
                fecha: formatDate(e.expense_date),
                concepto: e.description ?? '',
                categoria: categoryName(e.category_id),
                tipo: KIND_LABEL[e.kind] ?? e.kind,
                total: Number(e.amount_usd),
                estado:
                  { pagada: 'Pagada', parcial: 'Parcial', pendiente: 'Pendiente' }[e.status] ?? e.status,
              })),
            totals: {
              total: delPeriodo.filter((e) => e.kind !== 'compra').reduce((a, e) => a + Number(e.amount_usd), 0),
            },
            totalsLabel: 'TOTAL',
          },
          {
            name: 'Cuentas por pagar',
            columns: [
              { header: 'Vence', key: 'vence', width: 13 },
              { header: 'Proveedor / Concepto', key: 'quien', width: 30, wrap: true },
              { header: 'Fecha', key: 'fecha', width: 13 },
              { header: 'Total USD', key: 'total', width: 14, numFmt: FMT_USD },
              { header: 'Abonado', key: 'abonado', width: 14, numFmt: FMT_USD },
              { header: 'Saldo', key: 'saldo', width: 14, numFmt: FMT_USD },
            ],
            rows: [...abiertas]
              .sort((a, b) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999'))
              .map((e) => ({
                vence: formatDate(e.due_date),
                quien: supplierName(e.supplier_id) ?? e.description ?? '',
                fecha: formatDate(e.expense_date),
                total: Number(e.amount_usd),
                abonado: Number(e.paid_usd),
                saldo: saldoDe(e),
              })),
            totals: { saldo: abiertas.reduce((a, e) => a + saldoDe(e), 0) },
            totalsLabel: 'DEUDA TOTAL',
            note: 'Todo lo que sigue debiéndose, sin importar el período.',
          },
        ],
      });
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : 'Error al exportar.' });
    } finally {
      setExporting(null);
    }
  };

  return (
    <FinShell
      title="Resumen financiero"
      subtitle="Ventas y cobros de cada tienda, por forma de pago."
      actions={
        <>
          <button onClick={exportMovimientos} disabled={!!exporting} className={btnSecondary}>
            {exporting === 'movimientos' ? 'Exportando…' : (
              <span className="inline-flex items-center gap-2"><ChartNoAxesColumn className="w-4 h-4" aria-hidden /> Movimientos</span>
            )}
          </button>
          <button onClick={exportContador} disabled={!!exporting} className={btnSecondary}>
            {exporting === 'contador' ? 'Exportando…' : (
              <span className="inline-flex items-center gap-2"><Package className="w-4 h-4 text-orange-500" aria-hidden /> Paquete contador</span>
            )}
          </button>
        </>
      }
    >
      <div className="space-y-5">
        <FinNotice notice={notice} onClose={() => setNotice(null)} />

        {/* Filtros, como el dibujo de Gerardo: tienda, desde, hasta, Hoy, Este mes. */}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-slate-600">Tienda</span>
          <select
            value={storeFilter}
            onChange={(e) => setStoreFilter(e.target.value)}
            className={`${inputClass} w-auto min-w-[11rem]`}
          >
            <option value="all">Todas las tiendas</option>
            {activeStores.map((st) => (
              <option key={st.id} value={st.id}>{st.name}</option>
            ))}
          </select>
          <span className="text-slate-600 ml-2">Desde</span>
          <input
            type="date"
            value={dateRange.start}
            onChange={(e) => setDateRange({ ...dateRange, start: e.target.value })}
            className={`${inputClass} w-auto`}
          />
          <span className="text-slate-600 ml-2">Hasta</span>
          <input
            type="date"
            value={dateRange.end}
            onChange={(e) => setDateRange({ ...dateRange, end: e.target.value })}
            className={`${inputClass} w-auto`}
          />
          <button
            type="button"
            onClick={() => setDateRange({ start: hoy, end: hoy })}
            className={`ml-1 px-4 py-2 rounded-lg text-sm font-semibold border transition ${
              dateRange.start === hoy && dateRange.end === hoy
                ? 'bg-emerald-600 text-white border-emerald-600'
                : 'bg-white text-slate-600 border-slate-200 hover:border-emerald-500'
            }`}
          >
            Hoy
          </button>
          <button
            type="button"
            onClick={() => setDateRange({ start: caracasMonthStart(hoy), end: hoy })}
            className={`px-4 py-2 rounded-lg text-sm font-semibold border transition ${
              dateRange.start === caracasMonthStart(hoy) && dateRange.end === hoy
                ? 'bg-emerald-600 text-white border-emerald-600'
                : 'bg-white text-slate-600 border-slate-200 hover:border-emerald-500'
            }`}
          >
            Este mes
          </button>
        </div>

        {loading ? (
          <div className="py-20 text-center text-slate-400 text-sm">Cargando el resumen…</div>
        ) : (
          <>
            {/* --- Las cuatro tarjetas del dibujo --- */}
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
              {[
                {
                  Icon: StoreIcon, iconBox: 'bg-emerald-50 text-emerald-600', label: 'Ventas totales',
                  value: fmtUSD(ventasF.total), tone: 'text-emerald-700',
                  sub: `${ventasF.count} ${ventasF.count === 1 ? 'venta' : 'ventas'} · ${
                    storeSel ? storeSel.name : activeStores.length === 2 ? 'ambas tiendas' : 'todas las tiendas'
                  }`,
                },
                {
                  Icon: ShoppingCart, iconBox: 'bg-orange-50 text-orange-500', label: 'Compras y gastos',
                  value: fmtUSD(round2(kpi.compras + kpi.envios)), tone: 'text-orange-500',
                  sub: storeSel ? 'De todo el negocio' : null,
                },
                {
                  Icon: FileText, iconBox: 'bg-sky-50 text-sky-600', label: 'Gastos operativos',
                  value: fmtUSD(kpi.gastos), tone: 'text-slate-800',
                  sub: storeSel ? 'De todo el negocio' : null,
                },
                {
                  Icon: Banknote, iconBox: 'bg-emerald-50 text-emerald-600', label: 'Efectivo disponible',
                  value: fmtUSD(kpi.efectivo), tone: kpi.efectivo < 0 ? 'text-red-600' : 'text-emerald-700',
                  sub: storeSel ? 'De todo el negocio' : null,
                },
              ].map(({ Icon, iconBox, label, value, tone, sub }) => (
                <div key={label} className="bg-white px-4 py-4 rounded-xl shadow-sm border border-slate-200 flex items-center gap-4 min-w-0">
                  <span className={`w-12 h-12 rounded-xl ${iconBox} flex items-center justify-center shrink-0`}>
                    <Icon className="w-6 h-6" aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <p className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold leading-tight">{label}</p>
                    <p className={`text-2xl font-bold mt-0.5 break-words ${tone}`}>{value}</p>
                    {sub && <p className="text-xs text-slate-500 leading-snug">{sub}</p>}
                  </div>
                </div>
              ))}
            </div>

            {/* --- Ventas por tienda --- */}
            {tiendasF.length > 0 && (
              <div>
                <h3 className="text-xl font-bold text-slate-800 mb-3">Ventas por tienda</h3>
                <div className={`grid grid-cols-1 ${tiendasF.length > 1 ? 'md:grid-cols-2' : ''} gap-4`}>
                  {tiendasF.map((st) => {
                    const SIcon = storeIconOf(st.name);
                    return (
                      <div key={st.id} className="bg-white rounded-xl shadow-sm border border-slate-200 border-l-4 border-l-emerald-600 p-5 flex gap-4">
                        <span className="w-12 h-12 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0">
                          <SIcon className="w-6 h-6" aria-hidden />
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-lg font-bold text-slate-800 truncate">{st.name}</p>
                            <button
                              type="button"
                              onClick={() => verEnReportes(st)}
                              className="text-sm font-medium text-emerald-700 hover:underline whitespace-nowrap inline-flex items-center gap-0.5"
                            >
                              Ver detalle <ChevronRight className="w-4 h-4" aria-hidden />
                            </button>
                          </div>
                          <p className="text-3xl font-bold text-emerald-700 mt-1">{fmtUSD(st.total)}</p>
                          <p className="text-sm text-slate-500">{st.ventas} {st.ventas === 1 ? 'venta' : 'ventas'}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* --- Cobros por tienda y forma de pago --- */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 sm:p-5">
              <h3 className="text-xl font-bold text-slate-800">Cobros por tienda y forma de pago</h3>
              <p className="text-sm text-slate-500 mb-3">Desglose del período seleccionado.</p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] border-collapse">
                  <thead>
                    <tr className="bg-sky-50 text-slate-800 text-sm">
                      <th className="text-left font-bold px-4 py-2.5 rounded-tl-lg">Forma de pago</th>
                      {tiendasF.map((st, i) => (
                        <th key={st.id} className={`text-right font-bold px-4 py-2.5 ${i % 2 === 1 ? 'bg-emerald-100/60 text-center' : ''}`}>{st.name}</th>
                      ))}
                      <th className="text-right font-bold px-4 py-2.5 rounded-tr-lg">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {cobrosF.methods.map((m) => {
                      const rowTotal = tiendasF.reduce((a, st) => a + (cobrosF.usd[m.key]?.[st.id] ?? 0), 0);
                      return (
                        <tr key={m.key}>
                          <td className="px-4 py-2 text-slate-800 whitespace-nowrap">
                            <span className="inline-flex items-center gap-3">
                              {renderMethodIcon(m.key)}
                              {m.label}
                            </span>
                          </td>
                          {tiendasF.map((st, i) => (
                            <td
                              key={st.id}
                              className={`px-4 py-2 text-right tabular-nums ${i % 2 === 1 ? 'bg-emerald-50/70 text-emerald-700 font-medium' : 'text-slate-800'}`}
                            >
                              {fmtUSD(cobrosF.usd[m.key]?.[st.id] ?? 0)}
                            </td>
                          ))}
                          <td className="px-4 py-2 text-right text-slate-800 tabular-nums">{fmtUSD(rowTotal)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-emerald-50 text-lg font-bold">
                      <td className="px-4 py-2.5 text-slate-800 rounded-bl-lg">TOTAL COBRADO</td>
                      {tiendasF.map((st, i) => (
                        <td key={st.id} className={`px-4 py-2.5 text-right text-emerald-700 tabular-nums ${i % 2 === 1 ? 'bg-emerald-100/60' : ''}`}>
                          {fmtUSD(cobrosF.totalByStore[st.id] ?? 0)}
                        </td>
                      ))}
                      <td className="px-4 py-2.5 text-right text-emerald-700 tabular-nums rounded-br-lg">{fmtUSD(cobrosF.total)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <div className="flex flex-wrap items-start justify-between gap-2 mt-3">
                <p className="text-xs text-slate-500 flex-1 min-w-[240px]">
                  En bolívares, a la tasa de cada venta:{' '}
                  <strong>Bs. {totalBsF.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>.
                  {cobrosF.abonos > 0 && <> Incluye {fmtUSD(cobrosF.abonos)} de abonos de fiado.</>}
                  {Math.abs(cobrosF.total - ventasF.total) > 0.005 && (
                    <> No coincide con «Ventas totales» porque lo fiado se cobra después, en abonos.</>
                  )}
                </p>
                {tiendasF.length > 0 && (
                  <button
                    type="button"
                    onClick={() => verEnReportes(storeSel ?? tiendasF[0])}
                    className="text-sm font-medium text-emerald-700 underline underline-offset-2 hover:text-emerald-800 whitespace-nowrap inline-flex items-center gap-0.5"
                  >
                    Ver detalle en Reportes <ChevronRight className="w-4 h-4" aria-hidden />
                  </button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              {/* --- Próximos pagos --- */}
              <div className="bg-white rounded-xl shadow-sm border border-slate-200">
                <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
                  <h3 className="font-bold text-slate-800 text-base">Próximos pagos (7 días)</h3>
                  <span className="text-sm font-semibold text-slate-700">{fmtUSD(kpi.proximosTotal)}</span>
                </div>
                {kpi.proximos.length === 0 ? (
                  <p className="text-sm text-slate-500 py-12 text-center">Nada vence en los próximos 7 días.</p>
                ) : (
                  <div className="divide-y divide-slate-100">
                    {kpi.proximos.slice(0, 8).map((e) => (
                      <div key={e.id} className="px-5 py-2.5 flex items-center gap-3">
                        <DueBadge dueDate={e.due_date} />
                        <span className="flex-1 text-sm text-slate-800 truncate">
                          {supplierName(e.supplier_id) || e.description || 'Sin concepto'}
                        </span>
                        <span className="text-sm font-semibold text-slate-800">{fmtUSD(saldoDe(e))}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* --- Dónde está el dinero --- */}
              <div className="bg-white rounded-xl shadow-sm border border-slate-200">
                <h3 className="px-5 py-3.5 border-b border-slate-100 font-bold text-slate-800 text-base">
                  Dónde está el dinero
                </h3>
                {balances.filter((b) => b.is_active && !b.is_personal).length === 0 ? (
                  <p className="text-sm text-slate-500 py-12 text-center">Todavía no hay cuentas registradas.</p>
                ) : (
                  <div className="divide-y divide-slate-100">
                    {balances
                      .filter((b) => b.is_active && !b.is_personal)
                      .sort((a, b) => Number(b.balance_usd) - Number(a.balance_usd))
                      .map((b) => {
                        const card = b.kind === 'tarjeta_credito';
                        return (
                          <div key={b.account_id} className="px-5 py-2.5 flex items-center gap-3">
                            <span className="flex-1 text-sm text-slate-800 truncate">{b.name}</span>
                            {card && (
                              <span className="text-[10px] uppercase tracking-wide font-bold text-slate-500 bg-slate-100 rounded-md px-2 py-0.5">
                                Deuda
                              </span>
                            )}
                            <span
                              className={`text-base font-bold tabular-nums ${
                                card
                                  ? 'text-orange-500'
                                  : Number(b.balance_usd) < 0
                                    ? 'text-red-600'
                                    : 'text-emerald-700'
                              }`}
                            >
                              {fmtUSD(b.balance_usd)}
                            </span>
                          </div>
                        );
                      })}
                  </div>
                )}
              </div>
            </div>

            <p className="text-xs text-slate-400">
              «Ventas totales» y los cobros se leen de las ventas del POS. En los cobros, la inicial de Cashea
              cuenta en el método con que se pagó y el resto en «Cashea (lo paga Cashea)»; un fiado cuenta el día
              de cada abono. Compras, gastos y efectivo son de todo el negocio.
            </p>
          </>
        )}
      </div>
    </FinShell>
  );
}
