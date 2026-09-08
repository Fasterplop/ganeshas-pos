'use client';

import { useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { usePOSStore } from '@/store/usePOSStore';
import { formatVariant } from '@/lib/productVariant';
import Modal from '@/components/Modal';
import {
  EXCHANGE_NO_DIFF_METHOD,
  EXCHANGE_PAYMENT_OPTIONS,
  PDV_SURCHARGE_RATE,
  creditRatio,
  exchangeErrorMessage,
  isMissingExchangeColumn,
  lineCredit,
  round2,
  type ExchangePaymentMethod,
} from '@/lib/exchange';

// ============================================================================
// Modal de CAMBIO DE PRODUCTO.
//   - Desde el historial del dashboard llega con `initialSaleId` (la venta ya
//     está elegida). Desde el POS llega sin él y primero busca la venta por la
//     cédula del cliente en la tienda activa.
//   - Todo el registro lo hace el RPC register_exchange en una sola
//     transacción (db/exchange_02_schema_and_rpc.sql); acá solo se arma la
//     solicitud y se previsualizan los montos.
// ============================================================================

interface SourceLine {
  id: string;
  product_id: string | null;
  custom_name: string | null;
  quantity: number;
  unit_price: number;
  subtotal: number;
  source_sale_item_id: string | null;
  products: { name: string; talla: string | null; color: string | null } | null;
}

interface SourceSale {
  id: string;
  created_at: string;
  total_amount: number;
  redemption_discount_usd: number;
  punto_de_venta_surcharge_usd: number;
  customer_id: string | null;
  store_id: string;
  kind: 'sale' | 'exchange';
  customers: { full_name: string } | null;
  sale_items: SourceLine[];
}

// Resultado del buscador de productos (misma consulta que el POS + stock por tienda).
interface ProductHit {
  id: string;
  name: string;
  price: number;
  talla: string | null;
  color: string | null;
  sku_barcode: string;
  store_stock?: { stock: number; store_id: string }[];
}

interface NewItem {
  product: ProductHit;
  quantity: number;
}

// Venta candidata en el buscador por cédula (modo POS).
interface SaleHit {
  id: string;
  created_at: string;
  total_amount: number;
  kind: 'sale' | 'exchange';
  sale_items: { quantity: number; custom_name: string | null; products: { name: string } | null }[];
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  // Venta ya elegida (historial). null/undefined = buscar por cédula (POS).
  initialSaleId?: string | null;
  // Se llama al registrar el cambio, con el id de la nueva fila de `sales`.
  onDone?: (exchangeId: string) => void;
}

const lineName = (l: { custom_name: string | null; products: { name: string } | null }) =>
  l.custom_name || l.products?.name || 'Producto';

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString('es-VE', {
    timeZone: 'America/Caracas',
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true,
  });

const SALE_SELECT = `
  id, created_at, total_amount, redemption_discount_usd, punto_de_venta_surcharge_usd,
  customer_id, store_id, kind,
  customers (full_name),
  sale_items (id, product_id, custom_name, quantity, unit_price, subtotal, source_sale_item_id,
              products (name, talla, color))
`;

const PRODUCT_SELECT = 'id, name, price, talla, color, sku_barcode, store_stock (stock, store_id)';

const MIGRATION_MISSING = 'La base de datos aún no tiene la migración de cambios (aplicar db/exchange_02_schema_and_rpc.sql).';

export default function ExchangeModal({ isOpen, onClose, initialSaleId, onDone }: Props) {
  // Cerrado no se monta el cuerpo: cada apertura arranca con estado limpio sin
  // tener que resetearlo en un efecto.
  if (!isOpen) return null;
  return <ExchangeModalBody onClose={onClose} initialSaleId={initialSaleId} onDone={onDone} />;
}

function ExchangeModalBody({ onClose, initialSaleId, onDone }: Omit<Props, 'isOpen'>) {
  const supabase = createClient();
  const { currentStore, bcvRate } = usePOSStore();

  // --- Paso 0: buscar la venta por cédula (solo modo POS) -------------------
  const [docType, setDocType] = useState('V-');
  const [docNumber, setDocNumber] = useState('');
  const [searchingSales, setSearchingSales] = useState(false);
  const [saleHits, setSaleHits] = useState<SaleHit[] | null>(null);
  const [otherStoreCount, setOtherStoreCount] = useState(0);

  // --- Venta origen ---------------------------------------------------------
  const [saleId, setSaleId] = useState<string | null>(initialSaleId ?? null);
  const [sale, setSale] = useState<SourceSale | null>(null);
  const [loadingSale, setLoadingSale] = useState(false);
  const [returnedSoFar, setReturnedSoFar] = useState<Record<string, number>>({});

  // --- Paso 1: cantidades a devolver por línea ------------------------------
  const [returnQty, setReturnQty] = useState<Record<string, number>>({});

  // --- Paso 2: productos nuevos ---------------------------------------------
  const [productSearch, setProductSearch] = useState('');
  const [productHits, setProductHits] = useState<ProductHit[]>([]);
  const [newItems, setNewItems] = useState<NewItem[]>([]);
  const productInputRef = useRef<HTMLInputElement>(null);

  // --- Paso 3: puntos y pago -------------------------------------------------
  const [customerPoints, setCustomerPoints] = useState<number | null>(null);
  const [loyaltyCfg, setLoyaltyCfg] = useState({ points_per_block: 10, discount_per_block_usd: 10 });
  const [redeemBlocks, setRedeemBlocks] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState<ExchangePaymentMethod | null>(null);
  const [pdvSurcharge, setPdvSurcharge] = useState(false);
  const [paymentRef, setPaymentRef] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneId, setDoneId] = useState<string | null>(null);
  const [doneSummary, setDoneSummary] = useState<{ total: number; points: number } | null>(null);

  // Configuración de lealtad de la tienda activa (fallback 10/10, como el POS).
  useEffect(() => {
    if (!currentStore) return;
    (async () => {
      const { data } = await supabase
        .from('loyalty_settings')
        .select('points_per_block, discount_per_block_usd')
        .eq('store_id', currentStore.id)
        .maybeSingle();
      setLoyaltyCfg(data
        ? { points_per_block: data.points_per_block, discount_per_block_usd: Number(data.discount_per_block_usd) }
        : { points_per_block: 10, discount_per_block_usd: 10 });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStore?.id]);

  // Cargar la venta origen + lo ya devuelto de cada línea.
  useEffect(() => {
    if (!saleId) return;
    let cancelled = false;
    (async () => {
      setLoadingSale(true);
      setError(null);
      const { data, error: saleError } = await supabase
        .from('sales')
        .select(SALE_SELECT)
        .eq('id', saleId)
        .maybeSingle();

      if (cancelled) return;
      if (saleError) {
        setError(isMissingExchangeColumn(saleError) ? MIGRATION_MISSING : saleError.message);
        setLoadingSale(false);
        return;
      }
      if (!data) {
        setError('La venta ya no existe (puede haber sido anulada).');
        setLoadingSale(false);
        return;
      }

      const loaded = data as unknown as SourceSale;
      const ids = (loaded.sale_items ?? []).filter(l => Number(l.quantity) > 0).map(l => l.id);
      const returned: Record<string, number> = {};
      if (ids.length > 0) {
        // Embed auto-referenciado de PostgREST es ambiguo: se consulta aparte.
        const { data: rets } = await supabase
          .from('sale_items')
          .select('source_sale_item_id, quantity')
          .in('source_sale_item_id', ids);
        for (const r of rets ?? []) {
          const key = r.source_sale_item_id as string;
          returned[key] = (returned[key] || 0) + Math.max(0, -Number(r.quantity));
        }
      }
      if (cancelled) return;
      setSale(loaded);
      setReturnedSoFar(returned);
      setReturnQty({});
      setLoadingSale(false);

      // Saldo de puntos (pool global) si la venta tiene cliente.
      if (loaded.customer_id) {
        const { data: pts } = await supabase.rpc('get_global_points', { p_document_id: loaded.customer_id });
        if (!cancelled) setCustomerPoints(pts ? (pts.points ?? 0) : null);
      } else {
        setCustomerPoints(null);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saleId]);

  // --- Buscar ventas del cliente en la tienda activa (modo POS) ---------------
  const searchSales = async () => {
    if (!currentStore) return;
    const clean = docNumber.trim();
    if (!clean) return;
    const doc = `${docType}${clean}`;
    setSearchingSales(true);
    setError(null);

    const [{ data, error: err }, { count }] = await Promise.all([
      supabase
        .from('sales')
        .select('id, created_at, total_amount, kind, sale_items (quantity, custom_name, products (name))')
        .eq('customer_id', doc)
        .eq('store_id', currentStore.id)
        .order('created_at', { ascending: false })
        .limit(20),
      supabase
        .from('sales')
        .select('id', { count: 'exact', head: true })
        .eq('customer_id', doc)
        .neq('store_id', currentStore.id),
    ]);

    if (err) {
      setError(isMissingExchangeColumn(err) ? MIGRATION_MISSING : err.message);
      setSaleHits([]);
    } else {
      setSaleHits((data ?? []) as unknown as SaleHit[]);
    }
    setOtherStoreCount(count ?? 0);
    setSearchingSales(false);
  };

  // --- Buscar productos nuevos (misma consulta que el POS) ---------------------
  const handleProductSearchChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setProductSearch(val);
    if (val.trim().length > 1) {
      const { data } = await supabase
        .from('products')
        .select(PRODUCT_SELECT)
        .eq('is_active', true)
        .or(`sku_barcode.ilike.%${val}%,name.ilike.%${val}%`)
        .limit(50);
      setProductHits((data ?? []) as unknown as ProductHit[]);
    } else {
      setProductHits([]);
    }
  };

  const handleProductKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const barcode = productSearch.trim();
    if (!barcode) return;
    const { data } = await supabase
      .from('products')
      .select(PRODUCT_SELECT)
      .eq('sku_barcode', barcode)
      .eq('is_active', true)
      .maybeSingle();
    if (data) {
      addNewItem(data as unknown as ProductHit);
    } else {
      setError(`Producto no encontrado: ${barcode}`);
    }
  };

  const addNewItem = (product: ProductHit) => {
    setNewItems(prev => {
      const existing = prev.find(i => i.product.id === product.id);
      if (existing) return prev.map(i => i.product.id === product.id ? { ...i, quantity: i.quantity + 1 } : i);
      return [...prev, { product, quantity: 1 }];
    });
    setProductSearch('');
    setProductHits([]);
    setError(null);
    setTimeout(() => productInputRef.current?.focus(), 10);
  };

  const changeNewItemQty = (productId: string, delta: number) => {
    setNewItems(prev => prev
      .map(i => i.product.id === productId ? { ...i, quantity: i.quantity + delta } : i)
      .filter(i => i.quantity > 0));
  };

  const stockOf = (p: ProductHit) =>
    p.store_stock?.find(s => s.store_id === currentStore?.id)?.stock ?? 0;

  // --- Cálculos (el RPC los recalcula y valida; esto es la vista previa) -----
  const lines = sale?.sale_items ?? [];
  const ratio = sale ? creditRatio(sale, lines) : 1;
  const returnableLines = lines.filter(l => Number(l.quantity) > 0);
  const remainingOf = (l: SourceLine) => Math.max(0, Number(l.quantity) - (returnedSoFar[l.id] || 0));

  const creditTotal = round2(returnableLines.reduce((acc, l) => {
    const q = returnQty[l.id] || 0;
    return acc + lineCredit(Number(l.unit_price), ratio) * q;
  }, 0));
  const returnedUnits = returnableLines.reduce((acc, l) => acc + (returnQty[l.id] || 0), 0);
  const newTotal = round2(newItems.reduce((acc, i) => acc + Number(i.product.price) * i.quantity, 0));
  const diff = round2(newTotal - creditTotal);

  const maxBlocksByBalance = customerPoints !== null ? Math.floor(customerPoints / loyaltyCfg.points_per_block) : 0;
  const maxBlocksByDiff = diff > 0 ? Math.floor(diff / loyaltyCfg.discount_per_block_usd) : 0;
  const maxBlocks = Math.max(0, Math.min(maxBlocksByBalance, maxBlocksByDiff));
  const effectiveBlocks = Math.min(redeemBlocks, maxBlocks);
  const redemptionUsd = round2(effectiveBlocks * loyaltyCfg.discount_per_block_usd);
  const pointsToConsume = effectiveBlocks * loyaltyCfg.points_per_block;

  const diffNet = round2(diff - redemptionUsd);
  const surcharge = (diffNet > 0 && paymentMethod === 'punto_de_venta' && pdvSurcharge)
    ? round2(diffNet * PDV_SURCHARGE_RATE)
    : 0;
  const total = round2(diffNet + surcharge);
  const pointsEarned = sale?.customer_id ? Math.floor(Math.max(0, total)) : 0;

  const storeMismatch = !!(sale && currentStore && sale.store_id !== currentStore.id);
  const canConfirm = !!sale && !storeMismatch && returnedUnits > 0 && newItems.length > 0
    && diff >= 0 && (total === 0 || !!paymentMethod) && !submitting && bcvRate > 0;

  // --- Confirmar ---------------------------------------------------------------
  const handleConfirm = async () => {
    if (!sale || !canConfirm) return;
    setSubmitting(true);
    setError(null);

    const p_returns = returnableLines
      .filter(l => (returnQty[l.id] || 0) > 0)
      .map(l => ({ sale_item_id: l.id, quantity: returnQty[l.id] }));
    const p_new_items = newItems.map(i => ({ product_id: i.product.id, quantity: i.quantity }));

    const { data, error: rpcError } = await supabase.rpc('register_exchange', {
      p_source_sale_id: sale.id,
      p_returns,
      p_new_items,
      p_payment_method: total > 0 ? paymentMethod : EXCHANGE_NO_DIFF_METHOD,
      p_payment_ref: paymentRef.trim() === '' ? null : paymentRef.trim(),
      p_apply_pdv_surcharge: pdvSurcharge,
      p_redeem_points: pointsToConsume,
      p_expected_total: total,
      p_bcv_rate: bcvRate,
    });

    if (rpcError) {
      setError(exchangeErrorMessage(rpcError));
      setSubmitting(false);
      return;
    }

    const id = data as unknown as string;
    setDoneId(id);
    setDoneSummary({ total, points: pointsEarned });
    setSubmitting(false);
    onDone?.(id);
  };

  // ============================================================================
  // Render
  // ============================================================================
  const title = doneId ? 'Cambio registrado' : 'Cambio de producto';

  return (
    <Modal isOpen onClose={onClose} title={title}>
      {!currentStore ? (
        <p className="text-slate-500">Cargando contexto de la sucursal...</p>
      ) : doneId && doneSummary ? (
        // ------------------------------------------------------------------ éxito
        <div className="text-center py-6">
          <div className="text-7xl mb-4 leading-none">✅</div>
          <p className="text-2xl font-extrabold text-emerald-700 mb-2">¡Cambio registrado con éxito!</p>
          <p className="text-slate-600 text-lg">
            {doneSummary.total > 0
              ? <>Cobrado: <strong>${doneSummary.total.toFixed(2)}</strong> (Bs. {(doneSummary.total * bcvRate).toFixed(2)})</>
              : 'Sin diferencia: no se cobró nada.'}
          </p>
          {doneSummary.points > 0 && (
            <p className="text-teal-700 font-semibold mt-1">✪ El cliente gana {doneSummary.points} puntos</p>
          )}
          <button
            type="button"
            onClick={onClose}
            className="mt-6 px-6 py-3 bg-[#0f5c5c] hover:bg-[#0a4545] text-white rounded-xl font-bold text-lg transition"
          >
            Listo
          </button>
        </div>
      ) : !saleId ? (
        // ------------------------------------------------------ paso 0: buscar venta
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            Busca la venta original por la cédula del cliente. Se muestran solo las ventas de{' '}
            <strong className="text-teal-700">{currentStore.name}</strong>.
          </p>
          <div className="bg-teal-50 border border-teal-200 text-teal-800 text-xs font-semibold px-3 py-2 rounded-lg">
            Las ventas sin cliente (consumidor final) se cambian desde el Historial de Transacciones del dashboard.
          </div>
          <form
            onSubmit={(e) => { e.preventDefault(); searchSales(); }}
            className="flex flex-col sm:flex-row gap-2"
          >
            <div className="flex flex-1">
              <select
                value={docType}
                onChange={(e) => setDocType(e.target.value)}
                className="bg-slate-100 border border-slate-300 border-r-0 rounded-l-lg px-2 text-slate-700 text-lg outline-none focus:ring-2 focus:ring-teal-600 font-medium"
              >
                <option value="V-">V-</option>
                <option value="J-">J-</option>
                <option value="E-">E-</option>
                <option value="G-">G-</option>
              </select>
              <input
                type="text"
                autoFocus
                value={docNumber}
                onChange={(e) => setDocNumber(e.target.value)}
                placeholder="Número de Identificación..."
                className="w-full pl-3 pr-4 py-2.5 border border-slate-300 rounded-r-lg bg-white text-slate-800 text-lg focus:outline-none focus:ring-2 focus:ring-teal-600 transition"
              />
            </div>
            <button
              type="submit"
              disabled={searchingSales || docNumber.trim() === ''}
              className="px-5 py-2.5 bg-[#0f5c5c] hover:bg-[#0a4545] disabled:bg-slate-300 text-white rounded-lg font-bold transition whitespace-nowrap"
            >
              {searchingSales ? 'Buscando...' : '🔍 Buscar ventas'}
            </button>
          </form>

          {error && <p className="text-red-600 text-sm font-medium">{error}</p>}

          {saleHits !== null && (
            <div className="border border-slate-200 rounded-lg overflow-hidden">
              {saleHits.length === 0 ? (
                <p className="p-4 text-center text-slate-500 text-sm">
                  Este cliente no tiene ventas en {currentStore.name}.
                </p>
              ) : (
                <ul className="divide-y divide-slate-100 max-h-72 overflow-y-auto">
                  {saleHits.map(s => (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => setSaleId(s.id)}
                        className="w-full text-left p-3 hover:bg-teal-50 transition flex items-center justify-between gap-3"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-slate-800">
                            {fmtDate(s.created_at)}
                            {s.kind === 'exchange' && (
                              <span className="ml-2 text-[10px] font-bold uppercase tracking-wider text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">🔁 Cambio</span>
                            )}
                          </p>
                          <p className="text-xs text-slate-500 truncate">
                            {s.sale_items?.filter(it => Number(it.quantity) > 0).map(it => `${it.quantity}x ${lineName(it)}`).join(', ') || 'Sin artículos'}
                          </p>
                        </div>
                        <span className="font-bold text-teal-700 shrink-0">${Number(s.total_amount).toFixed(2)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {otherStoreCount > 0 && (
                <p className="px-3 py-2 text-xs text-slate-500 bg-slate-50 border-t border-slate-100">
                  Este cliente tiene {otherStoreCount} {otherStoreCount === 1 ? 'compra' : 'compras'} en otra sucursal: esas se cambian allá.
                </p>
              )}
            </div>
          )}
        </div>
      ) : loadingSale || !sale ? (
        <p className="text-slate-500 py-6 text-center">
          {error ? <span className="text-red-600 font-medium">{error}</span> : 'Cargando venta...'}
        </p>
      ) : (
        // ------------------------------------------------ pasos 1-3: el cambio
        <div className="space-y-5">
          {/* Cabecera de la venta origen */}
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 flex flex-wrap items-center justify-between gap-2 text-sm">
            <div>
              <p className="font-semibold text-slate-800">
                {sale.kind === 'exchange' ? '🔁 Cambio' : 'Venta'} del {fmtDate(sale.created_at)}
              </p>
              <p className="text-slate-500">
                {sale.customers?.full_name ? `${sale.customers.full_name} · ${sale.customer_id}` : 'Consumidor final (sin cliente)'}
                {' · '}Total ${Number(sale.total_amount).toFixed(2)}
              </p>
            </div>
            {!initialSaleId && (
              <button type="button" onClick={() => { setSaleId(null); setSale(null); }} className="text-xs font-semibold text-teal-700 hover:underline">
                ← Elegir otra venta
              </button>
            )}
          </div>

          {storeMismatch && (
            <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm font-medium">
              Esta venta es de otra sucursal. El cambio debe registrarse desde esa tienda.
            </div>
          )}

          {/* 1. Devuelve */}
          <section>
            <h3 className="text-sm font-bold text-slate-500 uppercase tracking-wider mb-2">1. Devuelve</h3>
            {returnableLines.length === 0 ? (
              <p className="text-slate-500 text-sm bg-slate-50 border border-slate-200 rounded-lg p-3">Esta venta no tiene artículos que se puedan devolver.</p>
            ) : (
              <>
                {ratio < 1 && (
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-2">
                    La venta tuvo descuento: el crédito de cada artículo es su precio del ticket prorrateado ({Math.round(ratio * 100)}%).
                  </p>
                )}
                <ul className="divide-y divide-slate-100 border border-slate-200 rounded-lg overflow-hidden">
                  {returnableLines.map(l => {
                    const remaining = remainingOf(l);
                    const q = returnQty[l.id] || 0;
                    const credit = lineCredit(Number(l.unit_price), ratio);
                    const variant = formatVariant(l.products?.talla ?? null, l.products?.color ?? null);
                    return (
                      <li key={l.id} className={`p-3 flex items-center justify-between gap-3 ${remaining === 0 ? 'bg-slate-50 opacity-60' : ''}`}>
                        <div className="min-w-0">
                          <p className="font-semibold text-slate-800 truncate">{lineName(l)}{variant && <span className="text-slate-500 font-normal"> · {variant}</span>}</p>
                          <p className="text-xs text-slate-500">
                            Comprado {l.quantity}{(returnedSoFar[l.id] || 0) > 0 && ` · ya devuelto ${returnedSoFar[l.id]}`}
                            {' · '}crédito ${credit.toFixed(2)} c/u
                            {ratio < 1 && <span className="text-slate-400"> (precio ${Number(l.unit_price).toFixed(2)})</span>}
                          </p>
                        </div>
                        {remaining === 0 ? (
                          <span className="text-xs font-bold text-slate-500 shrink-0">devuelto</span>
                        ) : (
                          <div className="flex items-center gap-2 shrink-0">
                            <button type="button" onClick={() => setReturnQty(p => ({ ...p, [l.id]: Math.max(0, q - 1) }))} disabled={q === 0}
                              className="w-9 h-9 rounded-full bg-slate-100 text-slate-700 hover:bg-red-100 hover:text-red-600 font-bold text-lg disabled:opacity-40 disabled:cursor-not-allowed transition">−</button>
                            <span className="w-7 text-center text-lg font-bold text-slate-800">{q}</span>
                            <button type="button" onClick={() => setReturnQty(p => ({ ...p, [l.id]: Math.min(remaining, q + 1) }))} disabled={q >= remaining}
                              className="w-9 h-9 rounded-full bg-teal-600 text-white hover:bg-teal-700 font-bold text-lg disabled:opacity-40 disabled:cursor-not-allowed transition">+</button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </section>

          {/* 2. Se lleva */}
          <section>
            <h3 className="text-sm font-bold text-slate-500 uppercase tracking-wider mb-2">2. Se lleva</h3>
            <div className="relative">
              <input
                ref={productInputRef}
                type="text"
                value={productSearch}
                onChange={handleProductSearchChange}
                onKeyDown={handleProductKeyDown}
                placeholder="🛒 Busca por nombre o escanea el código de barras..."
                className="w-full px-4 py-2.5 border-2 border-slate-300 rounded-lg bg-white text-slate-800 focus:outline-none focus:border-teal-600 focus:ring-1 focus:ring-teal-600 transition"
              />
              {productHits.length > 0 && (
                <ul className="absolute z-10 w-full bg-white border border-slate-200 shadow-xl rounded-lg mt-1 max-h-56 overflow-y-auto">
                  {productHits.map(p => (
                    <li key={p.id} onClick={() => addNewItem(p)} className="p-2.5 hover:bg-teal-50 cursor-pointer border-b border-slate-100 flex justify-between items-center gap-2 transition">
                      <div className="min-w-0">
                        <p className="font-semibold text-slate-800 truncate">{p.name}</p>
                        <p className="text-xs text-slate-500">
                          {formatVariant(p.talla, p.color) && `${formatVariant(p.talla, p.color)} · `}SKU {p.sku_barcode} · Stock {stockOf(p)}
                        </p>
                      </div>
                      <span className="font-bold text-teal-700 shrink-0">${Number(p.price).toFixed(2)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {newItems.length > 0 && (
              <ul className="mt-2 divide-y divide-slate-100 border border-slate-200 rounded-lg overflow-hidden">
                {newItems.map(i => (
                  <li key={i.product.id} className="p-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-800 truncate">
                        {i.product.name}
                        {formatVariant(i.product.talla, i.product.color) && <span className="text-slate-500 font-normal"> · {formatVariant(i.product.talla, i.product.color)}</span>}
                      </p>
                      <p className="text-xs text-slate-500">${Number(i.product.price).toFixed(2)} c/u · Stock {stockOf(i.product)}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button type="button" onClick={() => changeNewItemQty(i.product.id, -1)}
                        className="w-9 h-9 rounded-full bg-slate-100 text-slate-700 hover:bg-red-100 hover:text-red-600 font-bold text-lg transition">−</button>
                      <span className="w-7 text-center text-lg font-bold text-slate-800">{i.quantity}</span>
                      <button type="button" onClick={() => changeNewItemQty(i.product.id, 1)}
                        className="w-9 h-9 rounded-full bg-teal-600 text-white hover:bg-teal-700 font-bold text-lg transition">+</button>
                      <span className="w-20 text-right font-bold text-slate-800">${(Number(i.product.price) * i.quantity).toFixed(2)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* 3. Resumen y pago */}
          <section>
            <h3 className="text-sm font-bold text-slate-500 uppercase tracking-wider mb-2">3. Resumen y pago</h3>
            <div className="border border-slate-200 rounded-lg p-3 space-y-1 text-sm">
              <div className="flex justify-between"><span className="text-slate-600">Crédito por devolución ({returnedUnits} {returnedUnits === 1 ? 'artículo' : 'artículos'})</span><span className="font-semibold text-amber-700">−${creditTotal.toFixed(2)}</span></div>
              <div className="flex justify-between"><span className="text-slate-600">Productos nuevos</span><span className="font-semibold text-slate-800">${newTotal.toFixed(2)}</span></div>
              <div className="flex justify-between border-t border-slate-100 pt-1"><span className="font-bold text-slate-800">Diferencia</span><span className={`font-bold ${diff < 0 ? 'text-red-600' : 'text-slate-800'}`}>${diff.toFixed(2)}</span></div>
            </div>

            {diff < 0 && returnedUnits > 0 && newItems.length > 0 && (
              <div className="mt-2 bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm font-medium">
                Queda ${Math.abs(diff).toFixed(2)} a favor del cliente. No se devuelve dinero ni se acredita: agrega más productos hasta igualar o superar el crédito.
              </div>
            )}

            {/* Canje de puntos contra la diferencia */}
            {sale.customer_id && customerPoints !== null && diff > 0 && (
              <div className="mt-3 bg-white border-2 border-teal-200 rounded-lg p-3">
                <div className="flex items-center justify-between">
                  <p className="font-bold text-slate-800"><span className="text-teal-600">✪</span> Puntos de Lealtad</p>
                  <span className="font-bold text-teal-700">{customerPoints} pts</span>
                </div>
                {maxBlocks === 0 ? (
                  <p className="text-sm text-slate-500 mt-1">
                    {customerPoints < loyaltyCfg.points_per_block
                      ? `Necesita ${loyaltyCfg.points_per_block} pts para $${loyaltyCfg.discount_per_block_usd.toFixed(2)} de descuento.`
                      : 'La diferencia es muy baja para aplicar descuento por puntos.'}
                  </p>
                ) : (
                  <div className="flex items-center justify-between gap-3 mt-2">
                    <button type="button" onClick={() => setRedeemBlocks(Math.max(0, effectiveBlocks - 1))} disabled={effectiveBlocks === 0}
                      className="w-10 h-10 rounded-full bg-slate-100 text-slate-700 hover:bg-slate-200 font-bold text-xl disabled:opacity-40 disabled:cursor-not-allowed transition">−</button>
                    <div className="text-center">
                      <p className="text-2xl font-extrabold text-teal-700">−${redemptionUsd.toFixed(2)}</p>
                      <p className="text-xs text-slate-500">{pointsToConsume} pts · {effectiveBlocks} de {maxBlocks}</p>
                    </div>
                    <button type="button" onClick={() => setRedeemBlocks(Math.min(maxBlocks, effectiveBlocks + 1))} disabled={effectiveBlocks >= maxBlocks}
                      className="w-10 h-10 rounded-full bg-teal-600 text-white hover:bg-teal-700 font-bold text-xl disabled:opacity-40 disabled:cursor-not-allowed transition">+</button>
                    <button type="button" onClick={() => setRedeemBlocks(effectiveBlocks === maxBlocks ? 0 : maxBlocks)} className="text-xs font-bold text-teal-700 hover:underline whitespace-nowrap">
                      {effectiveBlocks === maxBlocks ? 'Quitar' : 'Aplicar máximo'}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Método de pago de la diferencia */}
            {diffNet > 0 && (
              <div className="mt-3">
                <p className="text-sm font-semibold text-slate-700 mb-2">Método de pago de la diferencia <span className="text-red-500">*</span></p>
                <div className="grid grid-cols-2 gap-2">
                  {EXCHANGE_PAYMENT_OPTIONS.map(o => (
                    <button
                      key={o.value}
                      type="button"
                      onClick={() => setPaymentMethod(o.value)}
                      className={`py-2 rounded-lg border flex items-center justify-center gap-2 text-sm font-medium transition ${paymentMethod === o.value ? 'bg-[#0f5c5c] text-white border-[#0f5c5c]' : 'bg-white text-slate-600 border-slate-200 hover:border-teal-600'}`}
                    >
                      <span className="text-lg">{o.icon}</span>{o.label}
                    </button>
                  ))}
                </div>
                {paymentMethod === 'punto_de_venta' && (
                  <label className="mt-2 flex items-start gap-2 cursor-pointer bg-sky-50 border border-sky-200 rounded-lg p-2.5 text-sm text-slate-700">
                    <input type="checkbox" checked={pdvSurcharge} onChange={(e) => setPdvSurcharge(e.target.checked)} className="mt-0.5 w-4 h-4 accent-sky-600 shrink-0" />
                    <span>Aplicar recargo del <strong>5%</strong> por Punto de Venta{surcharge > 0 && <span className="block text-xs font-semibold text-sky-700">+${surcharge.toFixed(2)} sobre ${diffNet.toFixed(2)}</span>}</span>
                  </label>
                )}
                <input
                  type="text"
                  value={paymentRef}
                  onChange={(e) => setPaymentRef(e.target.value)}
                  placeholder="Referencia de transacción (opcional)"
                  className="mt-2 w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 text-sm focus:outline-none focus:ring-2 focus:ring-teal-600 transition"
                />
              </div>
            )}

            {/* Total */}
            <div className="mt-3 bg-[#0f5c5c] rounded-xl p-4 text-white flex flex-col items-end">
              {total > 0 ? (
                <>
                  <p className="text-teal-100 text-sm">Total a cobrar</p>
                  <p className="text-3xl font-bold">${total.toFixed(2)}</p>
                  <p className="text-teal-200 text-sm">Bs. {(total * bcvRate).toFixed(2)} (Tasa BCV: {bcvRate.toFixed(2)})</p>
                </>
              ) : (
                <p className="text-xl font-bold">Sin diferencia: no se cobra nada</p>
              )}
              {sale.customer_id && (
                <p className="text-teal-200 text-sm mt-1">✪ Puntos que gana: +{pointsEarned}</p>
              )}
            </div>
          </section>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm font-medium">⚠️ {error}</div>
          )}

          <div className="flex justify-end gap-3 pt-3 border-t border-slate-100">
            <button type="button" onClick={onClose} className="px-4 py-2.5 border border-slate-300 rounded-lg font-medium text-slate-700 hover:bg-slate-50 transition">
              Cancelar
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!canConfirm}
              className="px-5 py-2.5 bg-[#0f5c5c] hover:bg-[#0a4545] disabled:bg-slate-300 disabled:cursor-not-allowed text-white rounded-lg font-bold transition"
            >
              {submitting ? 'Registrando...' : '🔁 Confirmar cambio'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
