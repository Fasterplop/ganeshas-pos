'use client';

// Consultar precio — pantalla pensada para el teléfono con escáner láser
// (SVANTTO Android 13, escáner en modo "teclado" con Enter al final).
//
// SOLO LECTURA. Desde acá no se vende ni se edita nada: lo único que escribe
// es la tasa BCV del día, y eso a pedido explícito del empleado.
//
// Tres decisiones que valen la pena explicar:
//
//  1. NO hay búsqueda mientras se escribe. El POS lanza una consulta por cada
//     carácter (pos/page.tsx:372-388), y un escáner teclea 12 caracteres de
//     golpe: son 12 consultas por lectura. Acá se resuelve solo con Enter (o
//     Tab, que algunos escáneres mandan en vez de Enter).
//
//  2. `inputMode="none"` mantiene el foco sin abrir el teclado virtual de
//     Android, que taparía media pantalla. El botón "Teclado" lo habilita
//     cuando hay que escribir a mano (etiqueta rayada, código ilegible).
//
//  3. El stock y las hermanas se piden en consultas aparte en vez de
//     embeberlas en la vista: PostgREST no siempre detecta la relación a
//     través de una vista, y preferimos dos consultas chicas seguras a una
//     que puede romperse según la versión.

import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import CameraScanner, { ScanButton } from '@/components/CameraScanner';
import { usePOSStore } from '@/store/usePOSStore';
import { formatVariant } from '@/lib/productVariant';
import { fmtUSD, fmtVES } from '@/lib/finanzas/money';
import { hasOffer, offerBadge, offerEndsLabel, priceOf } from '@/lib/offers';
import { pricedCols, pricedFallback, pricedTable } from '@/lib/pricedProducts';

// --- Datos -----------------------------------------------------------------

const BASE_COLS =
  'id, sku_barcode, name, price, talla, color, is_active, owner_store_id, parent_group_id';

interface PricedRow {
  id: string;
  sku_barcode: string;
  name: string;
  price: number;
  talla: string | null;
  color: string | null;
  is_active: boolean | null;
  owner_store_id: string | null;
  parent_group_id: string | null;
  effective_price?: number | null;
  offer_id?: string | null;
  offer_percent?: number | null;
  offer_ends_at?: string | null;
}

interface Sibling extends PricedRow {
  stock: number;
}

interface RecentScan {
  sku: string;
  name: string;
  variant: string;
  price: number;
}

const RECENT_KEY = 'gs.consultar-precio.recientes';
const MAX_RECENT = 10;

/** Un código con comodines de PostgREST no se puede usar en un ilike seguro. */
const hasWildcards = (s: string) => /[%*_,()\\]/.test(s);

/** Deja un término de búsqueda libre de los caracteres que rompen .or() */
const sanitizeTerm = (s: string) => s.replace(/[%*_,()\\]/g, ' ').trim();

/** Resultado de una consulta a productos, en su forma más laxa. */
type QueryResult = { data: unknown; error: { code?: string; message?: string } | null };
type QueryFn = (table: string, cols: string) => PromiseLike<QueryResult>;

type ResultState =
  | { kind: 'idle' }
  | { kind: 'searching' }
  | { kind: 'found'; product: PricedRow; stock: number }
  | { kind: 'inactive'; product: PricedRow }
  | { kind: 'notfound'; code: string }
  | { kind: 'choices'; code: string; options: PricedRow[] }
  | { kind: 'error'; message: string };

export default function ConsultarPrecioPage() {
  const supabase = createClient();
  const { currentStore, bcvRate, setBcvRate } = usePOSStore();

  const inputRef = useRef<HTMLInputElement>(null);

  // Escáner con la cámara (para un teléfono sin lector láser). Mientras está
  // abierto, el "re-foco" automático del input se suspende (ref, porque lo leen
  // listeners registrados una sola vez).
  const [cameraOpen, setCameraOpen] = useState(false);
  const cameraOpenRef = useRef(false);
  const setCamera = (open: boolean) => {
    cameraOpenRef.current = open;
    setCameraOpen(open);
  };

  const [code, setCode] = useState('');
  const [keyboardOn, setKeyboardOn] = useState(false);
  const [result, setResult] = useState<ResultState>({ kind: 'idle' });
  const [siblings, setSiblings] = useState<Sibling[] | null>(null);
  const [loadingSiblings, setLoadingSiblings] = useState(false);
  const [recent, setRecent] = useState<RecentScan[]>([]);

  // Tasa del día
  const [rateReady, setRateReady] = useState(false);
  const [rateStored, setRateStored] = useState<number | null>(null);
  const [rateFormOpen, setRateFormOpen] = useState(false);
  const [rateInput, setRateInput] = useState('');
  const [rateError, setRateError] = useState<string | null>(null);
  const [rateSaving, setRateSaving] = useState(false);
  // El SQL de la tasa no está aplicado: se trabaja con la tasa en memoria.
  const [rateFallback, setRateFallback] = useState(false);

  const storeId = currentStore?.id ?? null;

  const focusScanner = useCallback(() => {
    setTimeout(() => {
      if (!cameraOpenRef.current) inputRef.current?.focus();
    }, 10);
  }, []);

  // --- Últimos escaneos (por dispositivo) ----------------------------------
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(RECENT_KEY);
      if (raw) setRecent(JSON.parse(raw));
    } catch {
      // localStorage bloqueado (modo privado): la lista simplemente arranca vacía.
    }
  }, []);

  const pushRecent = useCallback((entry: RecentScan) => {
    setRecent(prev => {
      const next = [entry, ...prev.filter(r => r.sku !== entry.sku)].slice(0, MAX_RECENT);
      try {
        window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {
        // sin persistencia: la lista igual funciona durante la sesión.
      }
      return next;
    });
  }, []);

  // --- Tasa BCV ------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.rpc('get_bcv_rate');
      if (cancelled) return;
      if (error) {
        // Falta correr db/scanner_01_bcv_rates.sql: se usa la tasa en memoria.
        setRateFallback(true);
        setRateReady(true);
        return;
      }
      const rate = Number(data);
      if (Number.isFinite(rate) && rate > 0) {
        setRateStored(rate);
        setBcvRate(rate); // el resto de la app aprovecha la tasa en esta sesión
      }
      setRateReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, setBcvRate]);

  const effectiveRate = rateFallback ? bcvRate : (rateStored ?? bcvRate);
  const needsRate = rateReady && !(effectiveRate > 0);

  const saveRate = async () => {
    const value = Number(rateInput.replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) {
      setRateError('Escribe una tasa mayor que cero.');
      return;
    }
    setRateSaving(true);
    setRateError(null);

    if (rateFallback) {
      // Sin tabla en la base: al menos queda en memoria, como en la caja.
      setBcvRate(value);
      setRateSaving(false);
      setRateFormOpen(false);
      setRateInput('');
      focusScanner();
      return;
    }

    const { error } = await supabase.rpc('set_bcv_rate', { p_rate: value });
    setRateSaving(false);
    if (error) {
      setRateError('No se pudo guardar la tasa: ' + error.message);
      return;
    }
    setRateStored(value);
    setBcvRate(value);
    setRateFormOpen(false);
    setRateInput('');
    focusScanner();
  };

  // --- Consultas -----------------------------------------------------------

  /**
   * Lee de la vista con ofertas; si todavía no existe (SQL sin aplicar), cae a
   * `products` y se queda en esa fuente (ver src/lib/pricedProducts.ts). Quien
   * llama recibe la tabla y las columnas, así el mismo filtro sirve en ambos casos.
   */
  const selectProducts = useCallback(async (run: QueryFn): Promise<QueryResult> => {
    const res = await run(pricedTable(), pricedCols(BASE_COLS));
    if (res.error && pricedFallback(res.error)) {
      return run(pricedTable(), pricedCols(BASE_COLS));
    }
    return res;
  }, []);

  const stockFor = useCallback(
    async (productIds: string[]): Promise<Record<string, number>> => {
      if (!storeId || productIds.length === 0) return {};
      const { data } = await supabase
        .from('store_stock')
        .select('product_id, stock')
        .eq('store_id', storeId)
        .in('product_id', productIds);
      const map: Record<string, number> = {};
      for (const row of data ?? []) map[row.product_id as string] = Number(row.stock) || 0;
      return map;
    },
    [supabase, storeId],
  );

  const loadSiblings = useCallback(
    async (product: PricedRow) => {
      setSiblings(null);
      const groupId = product.parent_group_id;
      if (!groupId) return;
      setLoadingSiblings(true);
      const { data } = await selectProducts((t, c) =>
        supabase
          .from(t)
          .select(c)
          .eq('parent_group_id', groupId)
          .eq('is_active', true)
          .order('talla')
          .order('color')
          .limit(200),
      );
      const rows = (data ?? []) as unknown as PricedRow[];
      const stocks = await stockFor(rows.map(r => r.id));
      setSiblings(rows.map(r => ({ ...r, stock: stocks[r.id] ?? 0 })));
      setLoadingSiblings(false);
    },
    [supabase, selectProducts, stockFor],
  );

  const showProduct = useCallback(
    async (product: PricedRow) => {
      if (product.is_active === false) {
        setResult({ kind: 'inactive', product });
        setSiblings(null);
        focusScanner();
        return;
      }
      const stocks = await stockFor([product.id]);
      setResult({ kind: 'found', product, stock: stocks[product.id] ?? 0 });
      pushRecent({
        sku: product.sku_barcode,
        name: product.name,
        variant: formatVariant(product.talla, product.color),
        price: priceOf(product),
      });
      focusScanner();
      void loadSiblings(product);
    },
    [stockFor, pushRecent, focusScanner, loadSiblings],
  );

  const searchByName = useCallback(
    async (rawTerm: string) => {
      const term = sanitizeTerm(rawTerm);
      if (term.length < 2) {
        setResult({ kind: 'notfound', code: rawTerm });
        return;
      }
      const { data, error } = await selectProducts((t, c) =>
        supabase
          .from(t)
          .select(c)
          .eq('is_active', true)
          .or(`name.ilike.%${term}%,sku_barcode.ilike.%${term}%`)
          .limit(25),
      );
      if (error) {
        setResult({ kind: 'error', message: error.message ?? 'Error desconocido.' });
        return;
      }
      const rows = (data ?? []) as unknown as PricedRow[];
      if (rows.length === 0) setResult({ kind: 'notfound', code: rawTerm });
      else if (rows.length === 1) await showProduct(rows[0]);
      else setResult({ kind: 'choices', code: rawTerm, options: rows });
      focusScanner();
    },
    [supabase, selectProducts, showProduct, focusScanner],
  );

  const resolve = useCallback(
    async (raw: string) => {
      const value = raw.trim();
      if (!value) return;

      setResult({ kind: 'searching' });
      setSiblings(null);
      setCode('');

      // 1) Coincidencia exacta del código. SIN filtrar is_active: hay que poder
      //    distinguir "no existe" de "fue eliminado del inventario".
      const exact = await selectProducts((t, c) => supabase.from(t).select(c).eq('sku_barcode', value).limit(1));
      if (exact.error) {
        setResult({ kind: 'error', message: exact.error.message ?? 'Error desconocido.' });
        focusScanner();
        return;
      }
      const exactRows = (exact.data ?? []) as unknown as PricedRow[];
      if (exactRows.length > 0) {
        await showProduct(exactRows[0]);
        return;
      }

      // 2) Mismo código con otra caja de letras (los prefijos ROP-/JUG- van en
      //    mayúsculas, pero un código de fábrica puede haberse escrito a mano).
      if (!hasWildcards(value)) {
        const ci = await selectProducts((t, c) => supabase.from(t).select(c).ilike('sku_barcode', value).limit(2));
        const ciRows = (ci.data ?? []) as unknown as PricedRow[];
        if (ciRows.length === 1) {
          await showProduct(ciRows[0]);
          return;
        }
      }

      // 3) Etiqueta rayada: se busca por nombre o por parte del código.
      await searchByName(value);
    },
    [selectProducts, showProduct, searchByName, focusScanner],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      void resolve(code);
    }
  };

  // El foco vuelve al escáner al tocar fuera de un control y al volver de
  // segundo plano: el empleado nunca debería tener que tocar la pantalla.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !cameraOpenRef.current) inputRef.current?.focus();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const handleSurfaceClick = (e: React.MouseEvent) => {
    if (cameraOpenRef.current) return;
    const el = e.target as HTMLElement;
    if (el.closest('input, button, select, textarea, a')) return;
    inputRef.current?.focus();
  };

  // --- Render --------------------------------------------------------------

  const bsOf = (usd: number) => (effectiveRate > 0 ? fmtVES(usd * effectiveRate) : '—');

  return (
    <div className="flex flex-col gap-4 w-full max-w-2xl mx-auto pb-10" onClick={handleSurfaceClick}>
      <CameraScanner
        isOpen={cameraOpen}
        onClose={() => {
          setCamera(false);
          focusScanner();
        }}
        onScan={code => resolve(code)}
        title="Consultar precio"
      />
      {/* Encabezado */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-slate-800">Consultar precio</h1>
          <p className="text-slate-500 text-sm mt-0.5">{currentStore?.name ?? 'Sin tienda'}</p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-[10px] uppercase tracking-widest text-slate-400 font-bold">Tasa BCV</p>
          <p className="text-sm font-bold text-slate-700">
            {effectiveRate > 0 ? effectiveRate.toLocaleString('es-VE') : '—'}
          </p>
          <button
            onClick={() => {
              setRateInput(effectiveRate > 0 ? String(effectiveRate) : '');
              setRateError(null);
              setRateFormOpen(v => !v);
            }}
            className="text-xs text-teal-700 hover:text-teal-900 font-semibold underline cursor-pointer"
          >
            Actualizar tasa
          </button>
        </div>
      </div>

      {/* Tasa del día: se pide una vez y queda guardada para todos */}
      {(needsRate || rateFormOpen) && (
        <div className="bg-white rounded-xl shadow-sm border border-teal-200 p-4">
          <p className="font-bold text-slate-800 mb-1">
            {needsRate ? 'Falta la tasa BCV de hoy' : 'Actualizar la tasa de hoy'}
          </p>
          <p className="text-xs text-slate-500 mb-3">
            {rateFallback
              ? 'La tasa quedará solo en este teléfono (falta correr db/scanner_01_bcv_rates.sql en Supabase).'
              : 'Se guarda una sola vez por día y la usan todos los dispositivos. Si la tasa sube otra vez hoy, vuelve a actualizarla acá.'}
          </p>
          <div className="flex gap-2">
            <input
              type="number"
              step="0.01"
              inputMode="decimal"
              value={rateInput}
              onChange={e => setRateInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void saveRate();
                }
              }}
              placeholder="Ej. 210.50"
              className="flex-1 p-3 border-2 border-slate-300 rounded-lg bg-white text-slate-800 font-bold focus:outline-none focus:border-teal-600"
            />
            <button
              onClick={() => void saveRate()}
              disabled={rateSaving}
              className="bg-[#0f5c5c] hover:bg-[#0a4545] text-white font-medium px-5 rounded-lg transition disabled:opacity-50 whitespace-nowrap cursor-pointer"
            >
              {rateSaving ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
          {rateError && <p className="text-red-600 text-xs mt-2 font-medium">{rateError}</p>}
        </div>
      )}

      {/* Casilla de escaneo */}
      <div className="bg-white rounded-xl shadow-sm border-2 border-teal-600 p-4">
        <div className="flex items-center justify-between mb-2">
          <label className="text-[10px] uppercase tracking-widest text-teal-700 font-bold">
            Listo para escanear…
          </label>
          <div className="flex items-center gap-2">
            {/* Para un teléfono sin lector láser: lee con la cámara. */}
            <ScanButton onClick={() => setCamera(true)} className="px-3 py-1 text-xs rounded-full" label="Cámara" />
            <button
              onClick={() => {
                setKeyboardOn(v => !v);
                setTimeout(() => inputRef.current?.focus(), 10);
              }}
              className="text-xs font-semibold text-slate-500 hover:text-slate-800 border border-slate-300 rounded-full px-3 py-1 cursor-pointer"
            >
              {keyboardOn ? 'Ocultar teclado' : 'Teclado'}
            </button>
          </div>
        </div>
        <input
          ref={inputRef}
          type="text"
          autoFocus
          value={code}
          inputMode={keyboardOn ? 'text' : 'none'}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          onChange={e => setCode(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={e => {
            // Si el foco se fue a otro control (el input de la tasa, un boton),
            // se respeta. Si se fue a la nada, vuelve al escaner. Con la camara
            // abierta no: el visor tapa la pantalla y no hay que robarle el foco.
            if (cameraOpenRef.current) return;
            const next = e.relatedTarget as HTMLElement | null;
            if (next && next.closest('input, button, select, textarea, a')) return;
            setTimeout(() => inputRef.current?.focus(), 120);
          }}
          placeholder="Dispara el gatillo del escáner"
          className="w-full p-4 text-xl font-mono border-2 border-slate-200 rounded-lg bg-slate-50 text-slate-800 focus:outline-none focus:border-teal-600 focus:bg-white transition"
        />
      </div>

      {/* Resultado */}
      {result.kind === 'searching' && (
        <div className="bg-white rounded-xl border border-slate-200 p-6 text-center text-slate-500">Buscando…</div>
      )}

      {result.kind === 'error' && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 text-sm font-medium">
          No se pudo consultar: {result.message}
        </div>
      )}

      {result.kind === 'notfound' && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-5">
          <p className="font-bold text-amber-900">Código no encontrado</p>
          <p className="text-sm text-amber-800 mt-1 font-mono break-all">{result.code}</p>
          <p className="text-xs text-amber-700 mt-2">
            Revisa que la etiqueta sea de esta tienda, o activa el teclado y busca por nombre.
          </p>
        </div>
      )}

      {result.kind === 'inactive' && (
        <div className="bg-slate-100 border border-slate-300 rounded-xl p-5">
          <p className="font-bold text-slate-800 text-lg">{result.product.name}</p>
          <p className="text-sm text-slate-500 font-mono">{result.product.sku_barcode}</p>
          <p className="mt-3 font-bold text-red-600">No disponible</p>
          <p className="text-sm text-slate-600">
            Este producto fue eliminado del inventario. No se le puede dar precio al cliente.
          </p>
        </div>
      )}

      {result.kind === 'choices' && (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          <p className="px-4 py-3 text-sm font-bold text-slate-700 border-b border-slate-100">
            {result.options.length} coincidencias — toca la correcta
          </p>
          <ul className="divide-y divide-slate-100 max-h-80 overflow-y-auto">
            {result.options.map(p => (
              <li key={p.id}>
                <button
                  onClick={() => void showProduct(p)}
                  className="w-full text-left p-4 hover:bg-teal-50 transition flex justify-between items-center gap-3 cursor-pointer"
                >
                  <span className="min-w-0">
                    <span className="block font-semibold text-slate-800 truncate">{p.name}</span>
                    <span className="block text-xs text-slate-500">
                      {formatVariant(p.talla, p.color) || 'Sin talla/color'} · {p.sku_barcode}
                    </span>
                  </span>
                  <span className="font-bold text-teal-700 shrink-0">{fmtUSD(priceOf(p))}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.kind === 'found' && (
        <ProductCard product={result.product} stock={result.stock} bsOf={bsOf} storeName={currentStore?.name} />
      )}

      {/* Otras tallas y colores del mismo modelo */}
      {result.kind === 'found' && (
        <VariantsPanel
          product={result.product}
          siblings={siblings}
          loading={loadingSiblings}
          onPick={p => void showProduct(p)}
        />
      )}

      {/* Últimos escaneos */}
      {recent.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          <p className="px-4 py-3 text-[10px] uppercase tracking-widest text-slate-400 font-bold border-b border-slate-100">
            Últimos escaneos
          </p>
          <ul className="divide-y divide-slate-100">
            {recent.map(r => (
              <li key={r.sku}>
                <button
                  onClick={() => void resolve(r.sku)}
                  className="w-full text-left px-4 py-3 hover:bg-slate-50 transition flex justify-between items-center gap-3 cursor-pointer"
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-slate-700 truncate">{r.name}</span>
                    {r.variant && <span className="block text-xs text-slate-400">{r.variant}</span>}
                  </span>
                  <span className="text-sm font-bold text-slate-500 shrink-0">{fmtUSD(r.price)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// --- Ficha del producto ------------------------------------------------------

function ProductCard({
  product,
  stock,
  bsOf,
  storeName,
}: {
  product: PricedRow;
  stock: number;
  bsOf: (usd: number) => string;
  storeName?: string;
}) {
  const variant = formatVariant(product.talla, product.color);
  const price = priceOf(product);
  const onSale = hasOffer(product);
  const endsLabel = onSale ? offerEndsLabel(product.offer_ends_at) : '';

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
      <p className="text-xl sm:text-2xl font-bold text-slate-800 leading-tight">{product.name}</p>
      <p className="text-sm text-slate-500 mt-1">
        {variant && <span className="font-semibold text-slate-600">{variant} · </span>}
        <span className="font-mono">{product.sku_barcode}</span>
      </p>

      {onSale && (
        <div className="mt-3 inline-flex items-center gap-2">
          <span className="bg-red-100 text-red-700 text-xs font-black px-2.5 py-1 rounded-full tracking-wide">
            {offerBadge(product.offer_percent)}
          </span>
          {endsLabel && <span className="text-xs text-slate-500 font-medium">{endsLabel}</span>}
        </div>
      )}

      <div className="mt-3 flex items-baseline gap-3 flex-wrap">
        {onSale && <span className="text-xl text-slate-400 line-through">{fmtUSD(product.price)}</span>}
        <span className="text-5xl font-black text-slate-900 leading-none">{fmtUSD(price)}</span>
      </div>

      <p className="text-lg font-semibold text-slate-600 mt-2">{bsOf(price)}</p>
      <p className="text-[11px] text-slate-400">tasa BCV del día</p>

      <div className="mt-4 pt-4 border-t border-slate-100">
        <p className="text-[10px] uppercase tracking-widest text-slate-400 font-bold">
          Disponibles en {storeName ?? 'esta tienda'}
        </p>
        {stock > 0 ? (
          <p className="text-3xl font-bold text-teal-700">{stock}</p>
        ) : (
          <p className="text-xl font-bold text-red-600">Agotado en esta tienda</p>
        )}
      </div>
    </div>
  );
}

// --- Variantes del modelo ----------------------------------------------------

function VariantsPanel({
  product,
  siblings,
  loading,
  onPick,
}: {
  product: PricedRow;
  siblings: Sibling[] | null;
  loading: boolean;
  onPick: (p: PricedRow) => void;
}) {
  if (!product.parent_group_id) {
    return (
      <div className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-500">
        Este producto no tiene variantes registradas.
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <p className="px-4 py-3 text-[10px] uppercase tracking-widest text-slate-400 font-bold border-b border-slate-100">
        Todas las tallas y colores de este modelo
      </p>

      {loading && <p className="p-4 text-sm text-slate-500">Cargando variantes…</p>}

      {!loading && siblings && siblings.length === 0 && (
        <p className="p-4 text-sm text-slate-500">No se encontraron otras variantes activas.</p>
      )}

      {!loading && siblings && siblings.length > 0 && (
        <ul className="divide-y divide-slate-100">
          {siblings.map(s => {
            const isCurrent = s.id === product.id;
            const label = formatVariant(s.talla, s.color) || 'Sin talla/color';
            return (
              <li key={s.id}>
                <button
                  onClick={() => onPick(s)}
                  className={`w-full text-left px-4 py-3 flex items-center justify-between gap-3 transition cursor-pointer ${
                    isCurrent ? 'bg-teal-50' : 'hover:bg-slate-50'
                  }`}
                >
                  <span className="min-w-0">
                    <span className={`block font-bold truncate ${isCurrent ? 'text-teal-800' : 'text-slate-700'}`}>
                      {label}
                      {isCurrent && <span className="ml-2 text-[10px] font-black uppercase">escaneada</span>}
                    </span>
                    <span className="block text-xs font-mono text-slate-400">{s.sku_barcode}</span>
                  </span>
                  <span className="text-right shrink-0">
                    <span className="block font-bold text-slate-800">{fmtUSD(priceOf(s))}</span>
                    <span className={`block text-xs font-semibold ${s.stock > 0 ? 'text-teal-600' : 'text-red-500'}`}>
                      {s.stock > 0 ? `${s.stock} disp.` : 'agotado'}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
