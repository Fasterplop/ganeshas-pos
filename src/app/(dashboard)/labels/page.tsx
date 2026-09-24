'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Heart } from 'lucide-react';
import { formatVariant } from '@/lib/productVariant';
import BarcodeLabel from '@/components/labels/BarcodeLabel';
import { isClothingStore } from '@/lib/stores';
import { hasOffer, offerBadge, priceOf } from '@/lib/offers';
import { pricedFallback, pricedTable } from '@/lib/pricedProducts';
import { findProductByBarcode } from '@/lib/barcodeLookup';
import CameraScanner, { ScanButton } from '@/components/CameraScanner';

interface LabelProduct {
  id: string;
  name: string;
  sku_barcode: string;
  price: number;              // precio de lista
  effective_price: number;    // precio a cobrar (con la oferta vigente aplicada)
  offer_percent: number | null;
  owner_store_id: string | null;
  copies: number | string;
  talla: string | null;
  color: string | null;
}

// Modo de impresión de la etiqueta 62x29.
//
// "Sin precio" es la propuesta nueva: el precio ya no se imprime, así que un
// cambio de precio no obliga a reimprimir la tienda entera. Pero SOLO aplica a
// la Tienda de Ropa: en la juguetería el precio se mantiene impreso, por
// decisión del negocio. Como el buscador no filtra por tienda, un mismo lote
// puede mezclar las dos, así que la decisión se toma PRODUCTO POR PRODUCTO y
// se muestra en la tabla antes de imprimir.
type PriceMode = 'sin_precio' | 'con_precio';

export default function LabelsPage() {
  const supabase = createClient();

  // 1. Estados para controlar la nueva funcionalidad
  const [labelMode, setLabelMode] = useState<'barcode' | 'gift' | 'double_logo' | 'thankyou'>('barcode');
  const [giftLabelCount, setGiftLabelCount] = useState<number>(1);
  // Tarjeta de agradecimiento 4x6
const [thankYouHandle, setThankYouHandle] = useState<'ganesha_store01' | 'ganesha_jugueteria'>('ganesha_store01');
const [thankYouCount, setThankYouCount] = useState<number>(1);
  // Estados para el buscador
  const [productSearch, setProductSearch] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);

  // Estado para la lista de productos a imprimir
  const [selectedProducts, setSelectedProducts] = useState<LabelProduct[]>([]);

  // Configuración global del lote (Descuento porcentual)
  const [discountPercent, setDiscountPercent] = useState(0);

  // Con precio / Sin precio. Por defecto "Sin precio", como pide la propuesta.
  const [priceMode, setPriceMode] = useState<PriceMode>('sin_precio');

  // Nombre de cada tienda, para saber cuáles productos son de ropa. El id que
  // viene en el producto no dice nada por sí solo: en este proyecto la tienda
  // se reconoce por su nombre (ver src/lib/stores.ts).
  const [storeNames, setStoreNames] = useState<Record<string, string>>({});

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from('stores').select('id, name');
      const map: Record<string, string> = {};
      for (const s of data ?? []) map[s.id as string] = s.name as string;
      setStoreNames(map);
    })();
  }, [supabase]);

  // Precarga desde el módulo de Ofertas: /labels?producto=<id> o ?grupo=<id>.
  // Así el dueño imprime las etiquetas de lo que acaba de poner en oferta sin
  // tener que volver a buscar el producto a mano.
  const searchParams = useSearchParams();
  const preloadProduct = searchParams.get('producto');
  const preloadGroup = searchParams.get('grupo');

  useEffect(() => {
    if (!preloadProduct && !preloadGroup) return;
    let cancelled = false;

    (async () => {
      const run = (table: string) => {
        const q = supabase.from(table).select('*').eq('is_active', true);
        return preloadProduct ? q.eq('id', preloadProduct) : q.eq('parent_group_id', preloadGroup).order('talla').order('color');
      };

      let res = await run(pricedTable());
      if (pricedFallback(res.error)) res = await run(pricedTable());
      if (cancelled || !res.data) return;

      setSelectedProducts(prev => {
        const yaEstan = new Set(prev.map(p => p.id));
        const nuevos = (res.data as Record<string, unknown>[])
          .filter(p => !yaEstan.has(p.id as string))
          .map(p => ({
            id: p.id as string,
            name: p.name as string,
            sku_barcode: p.sku_barcode as string,
            price: Number(p.price),
            effective_price: priceOf(p as { price: number; effective_price?: number | null }),
            offer_percent: p.offer_id ? Number(p.offer_percent) : null,
            owner_store_id: (p.owner_store_id as string) ?? null,
            copies: 1,
            talla: (p.talla as string) ?? null,
            color: (p.color as string) ?? null,
          }));
        return [...prev, ...nuevos];
      });
    })();

    return () => { cancelled = true; };
  }, [preloadProduct, preloadGroup, supabase]);

  // ¿Esta etiqueta se imprime sin precio? Solo si el interruptor está en
  // "sin precio" Y el producto es de la tienda de ropa. Juguetes —y cualquier
  // producto sin tienda dueña, que es el caso seguro— siempre lleva precio.
  const printsWithoutPrice = (p: { owner_store_id: string | null }) =>
    priceMode === 'sin_precio' && isClothingStore(storeNames[p.owner_store_id ?? '']);

  // Precio que va impreso en una etiqueta CON precio.
  //
  // Si el producto tiene una OFERTA vigente en el sistema, manda la oferta y el
  // % del lote se ignora: la caja va a cobrar la oferta, y una etiqueta que
  // diga otra cosa es una discusión en el mostrador. El % del lote sigue
  // existiendo para los productos SIN oferta (ferias, ventas fuera de tienda).
  const labelPriceOf = (p: LabelProduct) => {
    if (p.offer_percent) return p.effective_price;
    return p.price - p.price * (discountPercent / 100);
  };

  // Precio anterior, tachado. Null cuando no hay ningún descuento que mostrar.
  const labelOriginalOf = (p: LabelProduct) =>
    labelPriceOf(p) < p.price ? p.price : null;

  // 1. LÓGICA DE BÚSQUEDA TIPO DROPDOWN
  //    Lee de la vista con ofertas para que la etiqueta CON precio imprima el
  //    mismo número que va a cobrar la caja. Si el SQL de ofertas todavía no se
  //    aplicó, cae a `products` y el precio efectivo es el de lista.
  const handleSearchChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setProductSearch(val);

    if (val.trim().length > 1) {
      const term = val.replace(/[%*_,()\\]/g, ' ').trim();
      if (!term) { setSearchResults([]); return; }
      const filter = `sku_barcode.ilike.%${term}%,name.ilike.%${term}%`;
      const run = (table: string) =>
        supabase.from(table).select('*').eq('is_active', true).or(filter).limit(50);

      let res = await run(pricedTable());
      if (pricedFallback(res.error)) res = await run(pricedTable());

      setSearchResults(res.data || []);
    } else {
      setSearchResults([]);
    }
  };

  const handleAddFromSearch = (product: any) => {
    const exists = selectedProducts.find(p => p.id === product.id);
    if (exists) {
      updateCopies(product.id, getSafeCopies(exists.copies) + 1);
    } else {
      setSelectedProducts([...selectedProducts, {
        id: product.id,
        name: product.name,
        sku_barcode: product.sku_barcode,
        price: product.price,
        effective_price: priceOf(product),
        offer_percent: product.offer_id ? Number(product.offer_percent) : null,
        owner_store_id: product.owner_store_id ?? null,
        copies: 1,
        talla: product.talla ?? null,
        color: product.color ?? null
      }]);
    }
    setProductSearch('');
    setSearchResults([]); 
  };

  // Escáner con la cámara (continuo): cada código leído suma una etiqueta. Va
  // con actualización funcional porque las lecturas llegan seguidas y un
  // closure viejo de selectedProducts perdería alguna.
  const [cameraOpen, setCameraOpen] = useState(false);
  const addByBarcode = async (code: string): Promise<string> => {
    const { product } = await findProductByBarcode(supabase, code);
    if (!product) return `✗ No encontrado: ${code}`;
    setSelectedProducts(prev => {
      const exists = prev.find(p => p.id === product.id);
      if (exists) {
        return prev.map(p => (p.id === product.id ? { ...p, copies: getSafeCopies(p.copies) + 1 } : p));
      }
      return [...prev, {
        id: product.id,
        name: product.name,
        sku_barcode: product.sku_barcode,
        price: product.price,
        effective_price: priceOf(product),
        offer_percent: product.offer_id ? Number(product.offer_percent) : null,
        owner_store_id: product.owner_store_id ?? null,
        copies: 1,
        talla: product.talla ?? null,
        color: product.color ?? null,
      }];
    });
    const variant = formatVariant(product.talla, product.color);
    return `✓ ${product.name}${variant ? ` (${variant})` : ''} · +1 etiqueta`;
  };

  const handleRemoveProduct = (id: string) => {
    setSelectedProducts(selectedProducts.filter(p => p.id !== id));
  };

  // 2. LÓGICA DE CONTROL DE COPIAS POR PRODUCTO
  const getSafeCopies = (val: number | string) => {
    return typeof val === 'number' ? val : (parseInt(val) || 0);
  };

  const updateCopies = (id: string, value: number | string) => {
    setSelectedProducts(selectedProducts.map(p => {
      if (p.id === id) {
        // Si el campo se vacía por completo (al borrar), lo dejamos como string vacío
        if (value === '') return { ...p, copies: '' };
        
        // Filtramos solo los números
        const numericString = String(value).replace(/\D/g, '');
        if (numericString === '') return { ...p, copies: '' };

        // Parseamos a entero para eliminar ceros a la izquierda (ej. "01" -> 1)
        const num = parseInt(numericString, 10);
        return { ...p, copies: num > 100 ? 100 : num };
      }
      return p;
    }));
  };

  const handleIncrement = (id: string, current: number | string) => {
    const safe = getSafeCopies(current);
    if (safe < 100) updateCopies(id, safe + 1);
  };

  const handleDecrement = (id: string, current: number | string) => {
    const safe = getSafeCopies(current);
    if (safe > 1) updateCopies(id, safe - 1);
  };

  const totalLabelsToPrint = selectedProducts.reduce((acc, curr) => acc + getSafeCopies(curr.copies), 0);

  // Aviso de lote mixto: nadie debería descubrir después de imprimir 40
  // etiquetas que la mitad salió distinta.
  const clothingCount = useMemo(
    () => selectedProducts.filter(printsWithoutPrice).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedProducts, priceMode, storeNames],
  );
  const mixedBatchNotice =
    priceMode === 'sin_precio' && clothingCount > 0 && clothingCount < selectedProducts.length;

  const handlePrint = async () => {
    if (totalLabelsToPrint === 0) return;

    window.print();

    // Registrar la primera impresión, igual que hace /inventory. Hasta ahora
    // imprimir en LOTE no quitaba el badge "Nuevo" del inventario, así que un
    // producto etiquetado desde acá seguía apareciendo como pendiente. El RPC
    // es idempotente (solo sella si label_printed_at es NULL) y si falla —SQL
    // sin aplicar— no se interrumpe nada: solo se loguea.
    await Promise.all(
      selectedProducts.map(async p => {
        const { error } = await supabase.rpc('mark_label_printed', { p_product_id: p.id });
        if (error) console.error('No se pudo registrar la impresión de', p.sku_barcode, error);
      }),
    );
  };

  return (
    <div className="flex flex-col gap-6 h-full font-sans w-full">
      
      {/* ================= HEADER Y TABS (NO SE IMPRIME) ================= */}
      <div className="print:hidden flex flex-col md:flex-row justify-between items-start md:items-center gap-4 shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-slate-800">Impresión de Etiquetas</h1>
          <p className="text-slate-500 text-sm mt-1">Selecciona el formato a imprimir</p>
        </div>
        
        <div className="bg-slate-200 p-1 rounded-lg flex flex-wrap items-center shadow-inner gap-1">
          <button
            onClick={() => setLabelMode('barcode')}
            className={`px-4 py-2 text-sm font-bold rounded-md transition-all ${
              labelMode === 'barcode' ? 'bg-white shadow-sm text-teal-800' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            Códigos de Barras
          </button>
          <button
            onClick={() => setLabelMode('gift')}
            className={`px-4 py-2 text-sm font-bold rounded-md transition-all ${
              labelMode === 'gift' ? 'bg-white shadow-sm text-teal-800' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            Regalos (Círculo 2x2)
          </button>
          <button
            onClick={() => setLabelMode('double_logo')}
            className={`px-4 py-2 text-sm font-bold rounded-md transition-all ${
              labelMode === 'double_logo' ? 'bg-white shadow-sm text-teal-800' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            Logo Doble (Círculo 2x2)
          </button>
            <button
  onClick={() => setLabelMode('thankyou')}
  className={`px-4 py-2 text-sm font-bold rounded-md transition-all ${
    labelMode === 'thankyou' ? 'bg-white shadow-sm text-teal-800' : 'text-slate-500 hover:text-slate-700'
  }`}
>
  Agradecimiento (4x6)
</button>

        </div>
      </div>

      {/* ================= MODO: CÓDIGOS DE BARRAS ================= */}
      {labelMode === 'barcode' && (
        <>
          <div className="print:hidden flex flex-col md:flex-row gap-6 h-full font-sans">
            
            {/* Panel Izquierdo: Buscador y Lista de Productos */}
            <div className="flex-1 bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex flex-col">
              
              {/* BUSCADOR CON DROPDOWN (Estilo POS) */}
              <div className="relative mb-6">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={productSearch}
                    onChange={handleSearchChange}
                    placeholder="🔍 Buscar por nombre o código de barras para añadir a impresión..."
                    className="w-full pl-4 pr-4 py-3 border-2 border-slate-300 rounded-lg bg-white text-slate-800 focus:outline-none focus:border-teal-600 focus:ring-1 focus:ring-teal-600 transition font-medium"
                  />
                  <ScanButton onClick={() => setCameraOpen(true)} className="lg:hidden px-4" />
                </div>
                <CameraScanner
                  isOpen={cameraOpen}
                  onClose={() => setCameraOpen(false)}
                  onScan={addByBarcode}
                  continuous
                  title="Escanear para etiquetas"
                />
                {searchResults.length > 0 && (
                  <ul className="absolute z-10 w-full bg-white border border-slate-200 shadow-xl rounded-lg mt-1 max-h-60 overflow-y-auto">
                    {searchResults.map(p => (
                      <li 
                        key={p.id} 
                        onClick={() => handleAddFromSearch(p)}
                        className="p-3 hover:bg-teal-50 cursor-pointer border-b border-slate-100 flex justify-between items-center transition"
                      >
                        <div>
                          <p className="font-semibold text-slate-800">{p.name}</p>
                          {formatVariant(p.talla, p.color) && (
                            <p className="text-xs text-slate-500">{formatVariant(p.talla, p.color)}</p>
                          )}
                          <p className="text-xs text-slate-500">SKU: {p.sku_barcode}</p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="font-bold text-teal-700">${priceOf(p).toFixed(2)}</p>
                          {hasOffer(p) && (
                            <p className="text-[10px] font-black text-red-600">{offerBadge(p.offer_percent)}</p>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* TABLA MULTI-PRODUCTOS */}
              <div className="flex-1 overflow-auto">
                <table className="w-full text-left border-collapse min-w-[500px]">
                  <thead className="bg-slate-700 text-white text-sm sticky top-0 z-0">
                    <tr>
                      <th className="p-3 rounded-tl-lg">Producto</th>
                      <th className="p-3 text-center">Etiquetas</th>
                      <th className="p-3 text-right">Cómo sale</th>
                      <th className="p-3 rounded-tr-lg text-center">Remover</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedProducts.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="p-10 text-center text-slate-500 bg-slate-50 border-b border-slate-200">
                          Utiliza el buscador de arriba para agregar productos a imprimir.
                        </td>
                      </tr>
                    ) : (
                      selectedProducts.map(product => (
                        <tr key={product.id} className="border-b border-slate-100 hover:bg-slate-50 transition">
                          <td className="p-3">
                            <p className="font-medium text-slate-800">{product.name}</p>
                            {formatVariant(product.talla, product.color) && (
                              <p className="text-sm text-slate-500">{formatVariant(product.talla, product.color)}</p>
                            )}
                            <p className="text-sm text-slate-500">SKU: {product.sku_barcode}</p>
                          </td>
                          <td className="p-3">
                            <div className="flex items-center justify-center gap-2">
                              <button onClick={() => handleDecrement(product.id, product.copies)} className="w-8 h-8 flex items-center justify-center rounded-full bg-slate-200 text-slate-600 hover:bg-teal-100 hover:text-teal-700 transition font-bold shrink-0">−</button>
                              <input 
                                type="text"
                                inputMode="numeric"
                                value={product.copies}
                                onChange={(e) => updateCopies(product.id, e.target.value)}
                                className="w-12 text-center font-medium border border-slate-300 rounded bg-white text-slate-800 py-1 outline-none focus:ring-1 focus:ring-teal-600"
                              />
                              <button onClick={() => handleIncrement(product.id, product.copies)} className="w-8 h-8 flex items-center justify-center rounded-full bg-slate-200 text-slate-600 hover:bg-teal-100 hover:text-teal-700 transition font-bold shrink-0">+</button>
                            </div>
                          </td>
                          <td className="p-3 text-right">
                            {printsWithoutPrice(product) ? (
                              <span className="inline-block text-[11px] font-bold uppercase tracking-wide bg-slate-200 text-slate-700 px-2 py-1 rounded">
                                Sin precio
                              </span>
                            ) : (
                              <div>
                                <p className="text-slate-800 font-bold">${labelPriceOf(product).toFixed(2)}</p>
                                {labelPriceOf(product) < product.price && (
                                  <p className="text-[11px] text-slate-400 line-through">${product.price.toFixed(2)}</p>
                                )}
                                <p className="text-[10px] uppercase tracking-wide text-slate-400 font-bold">
                                  {product.offer_percent ? 'Con precio · oferta' : 'Con precio'}
                                </p>
                              </div>
                            )}
                          </td>
                          <td className="p-3 text-center">
                            <button onClick={() => handleRemoveProduct(product.id)} className="text-red-400 hover:text-red-600 hover:bg-red-50 p-2 rounded transition">
                              🗑️
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Panel Derecho: Configuración e Impresión */}
            <div className="w-full md:w-80 space-y-6">
              <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
                <h3 className="font-medium text-slate-800 mb-4 flex items-center gap-2">
                  🏷️ Formato de la Etiqueta
                </h3>

                <div className="bg-slate-100 p-1 rounded-lg flex mb-3">
                  <button
                    onClick={() => setPriceMode('sin_precio')}
                    className={`flex-1 px-3 py-2 text-sm font-bold rounded-md transition-all cursor-pointer ${
                      priceMode === 'sin_precio' ? 'bg-white shadow-sm text-teal-800' : 'text-slate-500 hover:text-slate-700'
                    }`}
                  >
                    Sin precio
                  </button>
                  <button
                    onClick={() => setPriceMode('con_precio')}
                    className={`flex-1 px-3 py-2 text-sm font-bold rounded-md transition-all cursor-pointer ${
                      priceMode === 'con_precio' ? 'bg-white shadow-sm text-teal-800' : 'text-slate-500 hover:text-slate-700'
                    }`}
                  >
                    Con precio
                  </button>
                </div>
                <p className="text-[10px] text-slate-400 mb-4 leading-relaxed">
                  &laquo;Sin precio&raquo; solo aplica a la <strong>Tienda de Ropa</strong>: nombre más grande,
                  talla y color en su propia línea y código de barras más alto. Los productos de la
                  juguetería salen siempre con precio. La columna <em>Cómo sale</em> lo muestra por fila.
                </p>

                {mixedBatchNotice && (
                  <div className="bg-amber-50 border border-amber-200 text-amber-800 text-[11px] rounded-lg px-3 py-2 mb-4 font-medium">
                    Este lote mezcla las dos tiendas: {clothingCount} etiqueta(s) saldrán sin precio y{' '}
                    {selectedProducts.length - clothingCount} con precio.
                  </div>
                )}

                <h3 className="font-medium text-slate-800 mb-4 flex items-center gap-2 border-t border-slate-100 pt-4">
                  ⚙️ Descuento del Lote
                </h3>

                <div className="space-y-4 mb-6">
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">Descuento Global (%)</label>
                    <input 
                      type="number" 
                      value={discountPercent} 
                      onChange={(e) => setDiscountPercent(Number(e.target.value))}
                      min="0"
                      max="100"
                      className="w-full p-2 border border-slate-300 rounded-md bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-600"
                    />
                    <p className="text-[10px] text-slate-400 mt-1">
                      Si dejas 0%, imprimirá el precio base del producto. No se aplica a las etiquetas
                      sin precio, ni a los productos que ya tienen una <strong>oferta</strong> cargada
                      en el sistema: en esos manda la oferta, que es lo que va a cobrar la caja.
                    </p>
                  </div>
                </div>

                {/* El % del lote NO toca products.price: solo se dibuja en el
                    papel. Sin este aviso es una trampa: la etiqueta dice $108 y
                    la caja cobra $135, y el cliente lo descubre pagando. */}
                {discountPercent > 0 && (
                  <div className="bg-red-50 border border-red-300 text-red-800 text-[11px] rounded-lg px-3 py-2.5 mb-6 leading-relaxed">
                    <p className="font-bold mb-1">⚠️ Este descuento solo se imprime en el papel</p>
                    <p>
                      <strong>No cambia el precio del producto.</strong> La caja va a seguir cobrando
                      el precio completo, aunque la etiqueta diga otra cosa.
                    </p>
                    <p className="mt-1">
                      Para que la caja cobre el descuento sola, el dueño tiene que cargarlo como{' '}
                      <strong>oferta</strong> en el módulo <strong>Ofertas</strong>, y este campo se deja en 0.
                    </p>
                  </div>
                )}

                <div className="border-t border-slate-100 pt-4 mb-4">
                  <p className="text-slate-500 text-xs mb-1 text-right">Total a Imprimir</p>
                  <p className="text-4xl font-bold text-slate-800 text-right mb-1">{totalLabelsToPrint}</p>
                  <p className="text-[10px] text-slate-400 text-right">Formato: Brother DK-1209 (62x29 mm)</p>
                </div>

                <button 
                  onClick={() => void handlePrint()}
                  disabled={totalLabelsToPrint === 0}
                  className="w-full bg-[#0f5c5c] hover:bg-[#0a4545] text-white font-medium py-3 px-4 rounded-lg transition flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  🖨️ Imprimir Todo
                </button>
              </div>
            </div>
          </div>

          {/* VISTA DE IMPRESIÓN - CÓDIGOS DE BARRAS */}
          <div className="hidden print:block">
            {selectedProducts.flatMap(product => {
              const copiesNum = getSafeCopies(product.copies);
              const noPrice = printsWithoutPrice(product);

              return Array.from({ length: copiesNum }).map((_, i) => (
                <BarcodeLabel
                  key={`${product.id}-${i}`}
                  name={product.name}
                  skuBarcode={product.sku_barcode}
                  talla={product.talla}
                  color={product.color}
                  price={labelPriceOf(product)}
                  originalPrice={labelOriginalOf(product)}
                  showPrice={!noPrice}
                />
              ));
            })}
          </div>
        </>
      )}

      {/* ================= MODO: ETIQUETAS DE REGALO (2x2) ================= */}
      {labelMode === 'gift' && (
        <>
          <div className="print:hidden flex flex-col md:flex-row gap-6 h-full font-sans">
            <div className="w-full md:w-80 bg-white p-6 rounded-xl shadow-sm border border-slate-200 h-max">
              <h3 className="font-bold text-slate-800 mb-4 text-lg">Ajustes de Rollo 2x2</h3>
              <div className="mb-6">
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
                  Cantidad a Imprimir
                </label>
                <input
                  type="number"
                  min="1"
                  value={giftLabelCount}
                  onChange={(e) => setGiftLabelCount(Number(e.target.value))}
                  className="w-full border border-slate-200 rounded-lg p-3 font-semibold text-slate-700 focus:outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-500"
                />
              </div>
              <button
                onClick={() => window.print()}
                className="w-full bg-[#0f5c5c] text-white py-3 rounded-lg font-bold hover:bg-[#0a4545] transition flex items-center justify-center gap-2 shadow-md"
              >
                🖨️ Imprimir Regalos
              </button>
            </div>

            {/* Área de Visualización */}
            <div className="flex-1 bg-slate-50 border border-slate-200 rounded-xl p-6 flex flex-wrap gap-4 items-start overflow-y-auto">
               <p className="w-full text-slate-400 text-sm mb-2">Vista Previa (Formato Regalo):</p>
               {Array.from({ length: giftLabelCount }).map((_, index) => (
                <GiftCircleLabel key={`gift-preview-${index}`} />
               ))}
            </div>
          </div>

          {/* VISTA DE IMPRESIÓN */}
          <div className="hidden print:block print:w-auto print:m-0">
            {Array.from({ length: giftLabelCount }).map((_, index) => (
              <GiftCircleLabel key={`gift-print-${index}`} />
            ))}
          </div>
        </>
      )}

      {/* ================= MODO: LOGO DOBLE (2x2) ================= */}
      {labelMode === 'double_logo' && (
        <>
          <div className="print:hidden flex flex-col md:flex-row gap-6 h-full font-sans">
            <div className="w-full md:w-80 bg-white p-6 rounded-xl shadow-sm border border-slate-200 h-max">
              <h3 className="font-bold text-slate-800 mb-4 text-lg">Ajustes de Rollo 2x2</h3>
              <div className="mb-6">
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
                  Cantidad a Imprimir
                </label>
                <input
                  type="number"
                  min="1"
                  value={giftLabelCount}
                  onChange={(e) => setGiftLabelCount(Number(e.target.value))}
                  className="w-full border border-slate-200 rounded-lg p-3 font-semibold text-slate-700 focus:outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-500"
                />
              </div>
              <button
                onClick={() => window.print()}
                className="w-full bg-[#0f5c5c] text-white py-3 rounded-lg font-bold hover:bg-[#0a4545] transition flex items-center justify-center gap-2 shadow-md"
              >
                🖨️ Imprimir Logo Doble
              </button>
            </div>

            {/* Área de Visualización */}
            <div className="flex-1 bg-slate-50 border border-slate-200 rounded-xl p-6 flex flex-wrap gap-4 items-start overflow-y-auto">
               <p className="w-full text-slate-400 text-sm mb-2">Vista Previa (Formato Logo Doble):</p>
               {Array.from({ length: giftLabelCount }).map((_, index) => (
                <DoubleLogoCircleLabel key={`double-logo-preview-${index}`} />
               ))}
            </div>
          </div>

          {/* VISTA DE IMPRESIÓN */}
          <div className="hidden print:block print:w-auto print:m-0">
            {Array.from({ length: giftLabelCount }).map((_, index) => (
              <DoubleLogoCircleLabel key={`double-logo-print-${index}`} />
            ))}
          </div>
        </>
      )}

      {/* ================= MODO: AGRADECIMIENTO (4x6) ================= */}
{labelMode === 'thankyou' && (
  <>
    <div className="print:hidden flex flex-col md:flex-row gap-6 h-full font-sans">
      <div className="w-full md:w-80 bg-white p-6 rounded-xl shadow-sm border border-slate-200 h-max">
        <h3 className="font-bold text-slate-800 mb-4 text-lg">Tarjeta de Agradecimiento 4x6</h3>

        {/* Selector de cuenta / tienda */}
        <div className="mb-6">
          <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
            Cuenta de Instagram
          </label>
          <div className="bg-slate-100 p-1 rounded-lg flex flex-col gap-1">
            <button
              onClick={() => setThankYouHandle('ganesha_store01')}
              className={`px-3 py-2 text-sm font-bold rounded-md transition-all text-left ${
                thankYouHandle === 'ganesha_store01' ? 'bg-white shadow-sm text-teal-800' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              @ganesha_store01
            </button>
            <button
              onClick={() => setThankYouHandle('ganesha_jugueteria')}
              className={`px-3 py-2 text-sm font-bold rounded-md transition-all text-left ${
                thankYouHandle === 'ganesha_jugueteria' ? 'bg-white shadow-sm text-teal-800' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              @ganesha_jugueteria
            </button>
          </div>
        </div>

        {/* Cantidad */}
        <div className="mb-6">
          <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
            Cantidad a Imprimir
          </label>
          <input
            type="number"
            min="1"
            value={thankYouCount}
            onChange={(e) => setThankYouCount(Number(e.target.value))}
            className="w-full border border-slate-200 rounded-lg p-3 font-semibold text-slate-700 focus:outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-500"
          />
        </div>

        <button
          onClick={() => window.print()}
          className="w-full bg-[#0f5c5c] text-white py-3 rounded-lg font-bold hover:bg-[#0a4545] transition flex items-center justify-center gap-2 shadow-md"
        >
          🖨️ Imprimir Tarjetas
        </button>
      </div>

      {/* Vista Previa */}
      <div className="flex-1 bg-slate-50 border border-slate-200 rounded-xl p-6 flex flex-wrap gap-4 items-start overflow-y-auto">
        <p className="w-full text-slate-400 text-sm mb-2">Vista Previa (4x6 pulgadas):</p>
        {Array.from({ length: thankYouCount }).map((_, index) => (
          <ThankYouCard key={`ty-preview-${index}`} instagram={thankYouHandle} />
        ))}
      </div>
    </div>

    {/* VISTA DE IMPRESIÓN */}
    <div className="hidden print:block print:w-auto print:m-0">
      {Array.from({ length: thankYouCount }).map((_, index) => (
        <ThankYouCard key={`ty-print-${index}`} instagram={thankYouHandle} />
      ))}
    </div>
  </>
)}

      {/* INYECCIÓN GLOBAL DE REGLAS DE IMPRESIÓN PARA LOS FORMATOS DE 2x2 PULGADAS */}
      {(labelMode === 'gift' || labelMode === 'double_logo') && (
        <style dangerouslySetInnerHTML={{ __html: `
          @media print {
            @page { size: 2in 2in; margin: 0; }
            body { margin: 0; -webkit-print-color-adjust: exact; }
          }
        `}} />
      )}

      {labelMode === 'thankyou' && (
  <style dangerouslySetInnerHTML={{ __html: `
    @media print {
      @page { size: 4in 6in; margin: 0; }
      body { margin: 0; -webkit-print-color-adjust: exact; }
    }
  `}} />
)}

    </div>
  );
}

function GiftCircleLabel() {
  return (
    <div className="w-[2in] h-[2in] print:w-[2in] print:h-[2in] print:break-after-page print:m-0 flex items-center justify-center bg-white">
      {/* Contenedor interno expandido a 1.95in y padding reducido (py-2 px-3) */}
      <div className="relative w-[1.95in] h-[1.95in] rounded-full border-2 border-dashed border-slate-300 print:border-none print:rounded-none flex flex-col items-center justify-center py-2 px-3 bg-white overflow-hidden">
        
        {/* Logo Superior Ampliado */}
        <img
          src="/logo.jpg"
          alt="Ganesha"
          className="h-16 max-w-[85%] w-auto object-contain grayscale mb-4" 
        />

        {/* Campos de texto Ampliados - Ajustamos de px-2 a px-6 para esquivar el corte curvo */}
        <div className="w-full flex flex-col gap-5 px-6">
          <div className="flex items-end w-full">
            {/* Fuente más grande (text-lg) */}
            <span className="text-lg font-bold text-black leading-none mr-2 pb-0.5">De:</span>
            {/* Línea más gruesa (border-b-[3px]) */}
            <div className="flex-1 border-b-[3px] border-black"></div>
          </div>
          <div className="flex items-end w-full">
            <span className="text-lg font-bold text-black leading-none mr-2 pb-0.5">Para:</span>
            <div className="flex-1 border-b-[3px] border-black"></div>
          </div>
        </div>

      </div>
    </div>
  );
}

function DoubleLogoCircleLabel() {
  return (
    <div className="w-[2in] h-[2in] print:w-[2in] print:h-[2in] print:break-after-page print:m-0 flex items-center justify-center bg-white">
      {/* Contenedor expandido y padding vertical mínimo (py-3) para empujar los logos a los polos */}
      <div className="relative w-[1.95in] h-[1.95in] rounded-full border-2 border-dashed border-slate-300 print:border-none print:rounded-none flex flex-col items-center justify-between py-3 px-2 bg-white overflow-hidden">
        
        {/* Logo Arriba Volteado 180 grados */}
        <img
          src="/logo.jpg"
          alt="Ganesha Top"
          className="h-20 max-w-[85%] w-auto object-contain grayscale rotate-180" 
        />

        {/* Espacio vacío central estructurado */}
        <div className="flex-1 w-full"></div>

        {/* Logo Abajo en su posición normal */}
        <img
          src="/logo.jpg"
          alt="Ganesha Bottom"
          className="h-20 max-w-[85%] w-auto object-contain grayscale" 
        />

      </div>
    </div>
  );
}

function ThankYouCard({ instagram }: { instagram: string }) {
  return (
    <div className="w-[4in] h-[6in] print:w-[4in] print:h-[6in] print:break-after-page print:m-0 flex items-center justify-center bg-white">
      <div className="w-full h-full flex flex-col items-center justify-center text-center px-8 py-10 bg-white">
        <img
          src="/logo.jpg"
          alt="Ganesha Store"
          className="w-[60%] max-w-[2.4in] object-contain grayscale mb-6"
        />

        <p className="text-2xl font-semibold text-neutral-800 mb-3">¡Gracias por tu compra!</p>

        <Heart className="w-7 h-7 text-neutral-400 fill-neutral-400 mb-5" strokeWidth={1} />

        <p className="text-lg text-neutral-600 leading-snug mb-6 max-w-[3in]">
          Tu pedido fue preparado con mucho cariño. Gracias por elegirnos. ¡Disfrútalo mucho!
        </p>

        <div className="w-[2.6in] border-t-2 border-dotted border-neutral-300 mb-6"></div>

        <p className="text-base text-neutral-600 mb-1">Síguenos en Instagram</p>
        <p className="text-lg font-medium text-neutral-800 mb-3">@{instagram}</p>
        <svg
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  strokeWidth={1.5}
  strokeLinecap="round"
  strokeLinejoin="round"
  className="w-7 h-7 text-neutral-700"
>
  <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
  <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
  <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" />
</svg>
      </div>
    </div>
  );
}