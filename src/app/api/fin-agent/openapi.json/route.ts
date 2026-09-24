// GET /api/fin-agent/openapi.json
// Esquema que se importa en el GPT personalizado (Configurar > Acciones >
// Importar desde URL). Es público a propósito: describe los endpoints, no
// trae datos, y sin el token no se puede llamar a ninguno.
//
// OJO: ChatGPT limita cada `description` de operación a 300 caracteres.
import { NextResponse, type NextRequest } from 'next/server';

function serverUrl(req: NextRequest): string {
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? 'pos.ganeshastores.com';
  // Fuera de la red local SIEMPRE https: ChatGPT rechaza acciones sin TLS, y
  // detrás de nginx el x-forwarded-proto que llega es 'http' (lo pone el
  // propio Next al recibir de nginx por HTTP plano), no el del navegador.
  const local = /^(localhost|127\.|192\.168\.|10\.)/.test(host);
  return `${local ? 'http' : 'https'}://${host}/api/fin-agent`;
}

const date = { type: 'string', format: 'date', description: 'AAAA-MM-DD' };
const q = (name: string, schema: object, description: string, required = false) => ({
  name,
  in: 'query',
  required,
  description,
  schema,
});
const ok = { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } } };

export function GET(req: NextRequest) {
  const spec = {
    openapi: '3.1.0',
    info: {
      title: 'Finanzas Ganesha',
      version: '1.0.0',
      description:
        'Conector del módulo de Finanzas del POS de GaneshaStores. Lee compras, gastos, deudas y vencimientos, y propone registros nuevos a una bandeja que el dueño aprueba. No toca los saldos de cuentas ni tarjetas.',
    },
    servers: [{ url: serverUrl(req) }],
    components: {
      securitySchemes: { token: { type: 'http', scheme: 'bearer' } },
      schemas: {
        Line: {
          type: 'object',
          required: ['raw_text', 'kind', 'date', 'amount'],
          properties: {
            line_no: { type: 'integer', description: 'Número de línea en el estado de cuenta.' },
            raw_text: { type: 'string', description: 'La línea tal cual aparece en el banco.' },
            kind: { type: 'string', enum: ['compra', 'gasto', 'abono'] },
            date: { ...date, description: 'Fecha del movimiento.' },
            amount: { type: 'number', description: 'Monto positivo en la moneda indicada.' },
            currency: { type: 'string', enum: ['USD', 'VES'], default: 'USD' },
            bcv_rate: { type: 'number', description: 'Solo VES. Si se omite se usa la guardada para ese día.' },
            account_id: { type: 'string', description: 'Cuenta o tarjeta de donde salió el dinero (de /context). Solo forma de pago.' },
            supplier_id: { type: 'string', description: 'Proveedor existente (de /context).' },
            supplier_name: { type: 'string', description: 'Si el proveedor no existe: nombre limpio. Se crea al aprobar.' },
            category_id: { type: 'string', description: 'Categoría (de /context).' },
            expense_id: { type: 'string', description: 'Solo abono: la compra o gasto que se abona (de /expenses).' },
            description: { type: 'string' },
            due_date: { ...date, description: 'Vencimiento, solo si no está pagada.' },
            paid: { type: 'boolean', default: true, description: 'Compra/gasto ya pagado. Del estado de cuenta, siempre true.' },
            is_personal: { type: 'boolean', default: false },
            reference: { type: 'string', description: 'Número de referencia o confirmación del banco, si lo hay.' },
            note: { type: 'string', description: 'Por qué lo clasificaste así (lo ve el dueño).' },
          },
        },
      },
    },
    security: [{ token: [] }],
    paths: {
      '/context': {
        get: {
          operationId: 'getContext',
          summary: 'Cuentas, proveedores, categorías y tasa BCV de hoy',
          description: 'Llamar SIEMPRE antes de clasificar un estado de cuenta. Trae los ids de cuentas, proveedores y categorías, la tasa BCV de hoy y las reglas del negocio.',
          responses: ok,
        },
      },
      '/bcv': {
        get: {
          operationId: 'getBcvRate',
          summary: 'Tasa BCV de un día',
          description: 'Tasa guardada para esa fecha. rate=null significa que no hay: pregúntasela al dueño.',
          parameters: [q('date', date, 'Fecha. Por defecto hoy.')],
          responses: ok,
        },
      },
      '/expenses': {
        get: {
          operationId: 'listExpenses',
          summary: 'Compras, gastos y fletes registrados',
          description: 'Para encontrar la compra a la que va un abono (status=abiertas), ver si algo ya está cargado, o responder preguntas.',
          parameters: [
            q('from', date, 'Desde (fecha de la compra).'),
            q('to', date, 'Hasta.'),
            q('kind', { type: 'string', enum: ['compra', 'gasto', 'envio'] }, 'Tipo.'),
            q('supplier_id', { type: 'string' }, 'Proveedor.'),
            q('category_id', { type: 'string' }, 'Categoría.'),
            q('status', { type: 'string', enum: ['pendiente', 'parcial', 'pagada', 'abiertas'] }, 'abiertas = pendiente o parcial.'),
            q('q', { type: 'string' }, 'Texto en descripción o nombre del proveedor.'),
            q('include_personal', { type: 'boolean' }, 'Incluir lo personal.'),
            q('limit', { type: 'integer', default: 300 }, 'Máximo de filas.'),
          ],
          responses: ok,
        },
      },
      '/payments': {
        get: {
          operationId: 'listPayments',
          summary: 'Pagos y abonos registrados',
          description: 'Pagos ya registrados con la cuenta o tarjeta usada. Sirve para ver si un cargo del banco ya está en el sistema.',
          parameters: [
            q('account_id', { type: 'string' }, 'Cuenta o tarjeta.'),
            q('from', date, 'Desde.'),
            q('to', date, 'Hasta.'),
            q('limit', { type: 'integer', default: 500 }, 'Máximo de filas.'),
          ],
          responses: ok,
        },
      },
      '/summary/suppliers': {
        get: {
          operationId: 'supplierSummary',
          summary: 'Deuda por proveedor y consolidado de compras',
          description: 'Cuánto se le debe a cada proveedor hoy, y las compras por proveedor en el rango con el monto de cada transacción (consolidado).',
          parameters: [q('from', date, 'Desde (consolidado).'), q('to', date, 'Hasta (consolidado).')],
          responses: ok,
        },
      },
      '/summary/due': {
        get: {
          operationId: 'dueSoon',
          summary: 'Qué vence pronto',
          description: 'Compras y gastos sin pagar que vencen en los próximos días (y los vencidos), corte y pago de tarjetas, y suscripciones.',
          parameters: [
            q('days', { type: 'integer', default: 7 }, 'Días hacia adelante.'),
            q('include_personal', { type: 'boolean' }, 'Incluir lo personal.'),
          ],
          responses: ok,
        },
      },
      '/summary/month': {
        get: {
          operationId: 'monthSummary',
          summary: 'Gasto del mes por categoría y presupuesto',
          description: 'Total del mes por categoría y por tipo, lo que falta por pagar, y presupuesto contra lo real.',
          parameters: [q('month', { type: 'string', description: 'AAAA-MM' }, 'Mes. Por defecto el actual.')],
          responses: ok,
        },
      },
      '/accounts': {
        get: {
          operationId: 'accountBalances',
          summary: 'Saldos de cuentas y deuda de tarjetas',
          description: 'Saldos tal como están en Finanzas > Cuentas. Son manuales: solo lectura.',
          parameters: [q('include_personal', { type: 'boolean' }, 'Incluir lo personal.')],
          responses: ok,
        },
      },
      '/proposals': {
        get: {
          operationId: 'listProposals',
          summary: 'Qué hay en la bandeja',
          description: 'Propuestas esperando aprobación del dueño (o aprobadas/descartadas).',
          parameters: [
            q('status', { type: 'string', enum: ['pendiente', 'aprobada', 'descartada'], default: 'pendiente' }, 'Estado.'),
            q('limit', { type: 'integer', default: 200 }, 'Máximo de filas.'),
          ],
          responses: ok,
        },
        post: {
          operationId: 'submitProposals',
          summary: 'Enviar líneas a la bandeja de revisión',
          description: 'Manda las líneas clasificadas. Quedan pendientes hasta que el dueño apruebe. Salta lo repetido y dice por qué. Nunca incluir pagos a tarjetas ni movimientos entre cuentas.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['lines'],
                  properties: {
                    source_file: { type: 'string', description: 'Nombre del archivo subido.' },
                    lines: { type: 'array', maxItems: 300, items: { $ref: '#/components/schemas/Line' } },
                  },
                },
              },
            },
          },
          responses: ok,
        },
      },
    },
  };

  return NextResponse.json(spec);
}
