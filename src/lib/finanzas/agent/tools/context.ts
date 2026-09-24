// Lo que el asistente necesita ANTES de clasificar un estado de cuenta:
// cuentas y tarjetas (para saber de cuál salió cada cargo), proveedores,
// categorías y la tasa BCV de hoy. Solo lectura.
import { z } from 'zod';
import { defineTool, mustList } from '../tool';
import { fetchAllPages } from '@/lib/finanzas/queries';
import { caracasToday } from '@/lib/finanzas/dates';

export const BUSINESS_RULES = [
  'Nunca propongas cargos, pagos ni abonos A una tarjeta o cuenta: el saldo de las cuentas es manual. Ignora pagos a tarjetas, depósitos y transferencias entre cuentas propias, y menciónalos en tu resumen.',
  'La cuenta o tarjeta de donde salió el dinero va en account_id: es solo la forma de pago.',
  'Cobros repetidos de un mismo proveedor son entregas o facturas parciales, no duplicados.',
  'Montos en bolívares: currency=VES y la tasa BCV del día del movimiento. Si tasa_bcv no la tiene, pregúntasela al dueño; no la inventes.',
  'Si no reconoces una línea, pregunta cómo clasificarla antes de proponerla.',
];

export const contextTool = defineTool({
  name: 'obtener_contexto',
  title: 'Cuentas, proveedores y categorías',
  description:
    'Llamar SIEMPRE antes de clasificar un estado de cuenta. Devuelve los ids de cuentas/tarjetas, proveedores y categorías, la tasa BCV de hoy y las reglas del negocio.',
  input: z.object({}),
  readOnly: true,
  async run({ admin }) {
    const today = caracasToday();

    const [accounts, categories, rate, suppliers] = await Promise.all([
      admin
        .from('fin_accounts')
        .select('id, name, kind, bank_name, last4, currency, is_personal')
        .eq('is_active', true)
        .order('name'),
      admin
        .from('fin_categories')
        .select('id, name, kind')
        .eq('is_active', true)
        .order('sort_order')
        .order('name'),
      admin.from('bcv_rates').select('rate').eq('rate_date', today).maybeSingle(),
      fetchAllPages<{ id: string; name: string; payment_terms: string }>((from, to) =>
        admin.from('fin_suppliers').select('id, name, payment_terms').eq('is_active', true).order('name').range(from, to),
      ),
    ]);
    if (suppliers.error) throw new Error(`proveedores: ${suppliers.error.message}`);

    return {
      hoy: today,
      tasa_bcv_hoy: rate.data?.rate ?? null,
      cuentas: mustList(accounts, 'cuentas'),
      categorias: mustList(categories, 'categorias'),
      proveedores: suppliers.rows,
      reglas: BUSINESS_RULES,
    };
  },
});
