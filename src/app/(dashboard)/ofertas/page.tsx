'use client';

// Ofertas — % de descuento con fecha de fin, guardado en el sistema.
//
// Antes el descuento se escribía al imprimir el lote de etiquetas y moría en
// el papel. Con la etiqueta sin precio esa información tiene que vivir en la
// base: acá se carga, el teléfono la muestra y la caja la cobra sola.
//
// El PRECIO no se calcula en esta pantalla. Lo calcula el SQL
// (v_products_priced / effective_product_price). Lo único que se calcula acá
// es la VISTA PREVIA, antes de que la oferta exista.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import Modal from '@/components/Modal';
import { usePOSStore, Store } from '@/store/usePOSStore';
import { formatVariant } from '@/lib/productVariant';
import { fmtUSD } from '@/lib/finanzas/money';
import { caracasToday, formatDate } from '@/lib/finanzas/dates';
import { CATEGORY_LABELS, PRODUCT_CATEGORIES, categoryLabel } from '@/lib/categories';
import { isMissingTableError } from '@/lib/supabaseErrors';
import {
  OFFER_SCOPE_LABEL,
  OFFER_STATE_LABEL,
  formatPercent,
  offerEndsLabel,
  offerState,
  previewOfferPrice,
  type OfferScope,
  type OfferState,
  type ProductOffer,
} from '@/lib/offers';

interface ProductLite {
  id: string;
  name: string;
  sku_barcode: string;
  price: number;
  talla: string | null;
  color: string | null;
  category: string;
  owner_store_id: string | null;
}

interface GroupLite {
  id: string;
  name: string;
  owner_store_id: string;
}

interface OfferRow extends ProductOffer {
  targetLabel: string;
}

interface Preview {
  count: number;
  samples: ProductLite[];
}

const STATE_STYLE: Record<OfferState, string> = {
  vigente: 'bg-green-100 text-green-800',
  programada: 'bg-blue-100 text-blue-800',
  vencida: 'bg-slate-200 text-slate-600',
  desactivada: 'bg-slate-200 text-slate-500',
};

const sanitize = (s: string) => s.replace(/[%*_,()\\]/g, ' ').trim();

export default function OfertasPage() {
  const supabase = createClient();
  const { currentStore } = usePOSStore();

  const [stores, setStores] = useState<Store[]>([]);
  const [offers, setOffers] = useState<OfferRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);

  // --- Formulario ----------------------------------------------------------
  const [modalOpen, setModalOpen] = useState(false);
  const [scope, setScope] = useState<OfferScope>('product');
  const [percent, setPercent] = useState<string>('20');
  const [endsAt, setEndsAt] = useState<string>('');
  const [storeId, setStoreId] = useState<string>('');
  const [category, setCategory] = useState<string>('ropa');
  const [targetProduct, setTargetProduct] = useState<ProductLite | null>(null);
  const [targetGroup, setTargetGroup] = useState<GroupLite | null>(null);
  const [search, setSearch] = useState('');
  const [productHits, setProductHits] = useState<ProductLite[]>([]);
  const [groupHits, setGroupHits] = useState<GroupLite[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const percentNum = Number(percent.replace(',', '.'));
  const percentValid = Number.isFinite(percentNum) && percentNum > 0 && percentNum < 100;

  // --- Carga ---------------------------------------------------------------
  const loadOffers = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('product_offers')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) {
      setPageError(
        isMissingTableError(error)
          ? 'Las ofertas todavía no están instaladas en la base de datos. Falta correr db/scanner_03_offers.sql en Supabase.'
          : error.message,
      );
      setOffers([]);
      setLoading(false);
      return;
    }

    const rows = (data ?? []) as unknown as ProductOffer[];

    // Nombres de los objetivos, en dos consultas y no en 1+N.
    const productIds = rows.filter(o => o.product_id).map(o => o.product_id as string);
    const groupIds = rows.filter(o => o.group_id).map(o => o.group_id as string);

    const names: Record<string, string> = {};
    if (productIds.length > 0) {
      const { data: ps } = await supabase
        .from('products')
        .select('id, name, sku_barcode, talla, color')
        .in('id', productIds);
      for (const p of ps ?? []) {
        const v = formatVariant(p.talla as string, p.color as string);
        names[p.id as string] = `${p.name}${v ? ` · ${v}` : ''} (${p.sku_barcode})`;
      }
    }
    if (groupIds.length > 0) {
      const { data: gs } = await supabase.from('product_groups').select('id, name').in('id', groupIds);
      for (const g of gs ?? []) names[g.id as string] = `${g.name} — todas sus tallas`;
    }

    setOffers(
      rows.map(o => ({
        ...o,
        targetLabel:
          o.scope === 'category'
            ? categoryLabel(o.category ?? '')
            : names[(o.product_id ?? o.group_id) as string] ?? '(objetivo eliminado)',
      })),
    );
    setPageError(null);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from('stores').select('id, name, is_active').order('name');
      setStores((data ?? []) as unknown as Store[]);
    })();
    void loadOffers();
  }, [supabase, loadOffers]);

  // --- Buscadores del objetivo --------------------------------------------
  useEffect(() => {
    const term = sanitize(search);
    if (term.length < 2) {
      setProductHits([]);
      setGroupHits([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      if (scope === 'product') {
        const { data } = await supabase
          .from('products')
          .select('id, name, sku_barcode, price, talla, color, category, owner_store_id')
          .eq('is_active', true)
          .or(`name.ilike.%${term}%,sku_barcode.ilike.%${term}%`)
          .limit(20);
        if (!cancelled) setProductHits((data ?? []) as unknown as ProductLite[]);
      } else if (scope === 'group') {
        const { data } = await supabase
          .from('product_groups')
          .select('id, name, owner_store_id')
          .eq('is_active', true)
          .ilike('name', `%${term}%`)
          .limit(20);
        if (!cancelled) setGroupHits((data ?? []) as unknown as GroupLite[]);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search, scope, supabase]);

  // --- Vista previa: a cuántos productos toca y cómo les queda el precio ----
  const loadPreview = useCallback(async () => {
    setPreview(null);
    if (!percentValid) return;

    const cols = 'id, name, sku_barcode, price, talla, color, category, owner_store_id';

    if (scope === 'product') {
      if (!targetProduct) return;
      setPreview({ count: 1, samples: [targetProduct] });
      return;
    }

    const base = () => {
      let q = supabase.from('products').select(cols, { count: 'exact' }).eq('is_active', true);
      if (scope === 'group') q = q.eq('parent_group_id', targetGroup?.id ?? '');
      else {
        q = q.eq('category', category);
        if (storeId) q = q.eq('owner_store_id', storeId);
      }
      return q;
    };

    if (scope === 'group' && !targetGroup) return;

    // El más barato y el más caro alcanzan para ver el efecto del redondeo.
    const [{ count }, cheap, expensive] = await Promise.all([
      base().limit(1),
      base().order('price', { ascending: true }).limit(1),
      base().order('price', { ascending: false }).limit(1),
    ]);

    const samples = [
      ...((cheap.data ?? []) as unknown as ProductLite[]),
      ...((expensive.data ?? []) as unknown as ProductLite[]),
    ];
    const unique = samples.filter((p, i) => samples.findIndex(q => q.id === p.id) === i);
    setPreview({ count: count ?? 0, samples: unique });
  }, [supabase, scope, targetProduct, targetGroup, category, storeId, percentValid]);

  useEffect(() => {
    if (!modalOpen) return;
    void loadPreview();
  }, [modalOpen, loadPreview]);

  // --- Guardar / desactivar ------------------------------------------------
  const resetForm = () => {
    setScope('product');
    setPercent('20');
    setEndsAt('');
    setStoreId('');
    setCategory('ropa');
    setTargetProduct(null);
    setTargetGroup(null);
    setSearch('');
    setProductHits([]);
    setGroupHits([]);
    setPreview(null);
    setFormError(null);
  };

  const openModal = () => {
    resetForm();
    setStoreId(currentStore?.id ?? '');
    setModalOpen(true);
  };

  const save = async () => {
    setFormError(null);
    if (!percentValid) {
      setFormError('El descuento tiene que estar entre 0 y 100 (sin incluirlos).');
      return;
    }
    if (scope === 'product' && !targetProduct) {
      setFormError('Elige el producto al que aplica la oferta.');
      return;
    }
    if (scope === 'group' && !targetGroup) {
      setFormError('Elige el modelo al que aplica la oferta.');
      return;
    }
    if (endsAt && endsAt < caracasToday()) {
      setFormError('La fecha de fin ya pasó: la oferta nacería vencida.');
      return;
    }

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setFormError('Sesión vencida. Vuelve a entrar.');
      return;
    }

    setSaving(true);
    const { error } = await supabase.from('product_offers').insert([
      {
        scope,
        product_id: scope === 'product' ? targetProduct!.id : null,
        group_id: scope === 'group' ? targetGroup!.id : null,
        category: scope === 'category' ? category : null,
        // La tienda solo acota las ofertas de categoría: un producto y un
        // modelo ya pertenecen a una tienda por sí mismos.
        store_id: scope === 'category' && storeId ? storeId : null,
        percent: percentNum,
        ends_at: endsAt || null,
        created_by: user.id,
      },
    ]);
    setSaving(false);

    if (error) {
      setFormError(
        isMissingTableError(error)
          ? 'Falta correr db/scanner_03_offers.sql en Supabase.'
          : 'No se pudo guardar la oferta: ' + error.message,
      );
      return;
    }
    setModalOpen(false);
    resetForm();
    void loadOffers();
  };

  const deactivate = async (offer: OfferRow) => {
    if (!window.confirm(`¿Desactivar esta oferta de ${formatPercent(offer.percent)}%? La caja volverá a cobrar el precio normal.`)) return;
    const { error } = await supabase.from('product_offers').update({ is_active: false }).eq('id', offer.id);
    if (error) {
      alert('No se pudo desactivar: ' + error.message);
      return;
    }
    void loadOffers();
  };

  const activeCount = useMemo(() => offers.filter(o => offerState(o) === 'vigente').length, [offers]);

  /**
   * Enlace a /labels con el objetivo de la oferta ya cargado en el lote.
   *
   * Imprimir desde acá es el complemento natural de la oferta: en la Tienda de
   * Juguetes la etiqueta lleva precio, así que una oferta nueva suele querer
   * etiqueta nueva. (En Ropa la etiqueta va sin precio y no hace falta
   * reimprimir, pero el botón sirve igual para reponer etiquetas.)
   *
   * Devuelve null para las ofertas de categoría: pueden tocar cientos de
   * productos y mandar ese lote de un clic sería un error caro en papel.
   */
  const labelHref = (o: OfferRow): string | null => {
    if (o.scope === 'product' && o.product_id) return `/labels?producto=${o.product_id}`;
    if (o.scope === 'group' && o.group_id) return `/labels?grupo=${o.group_id}`;
    return null;
  };

  // --- Render --------------------------------------------------------------
  if (pageError) {
    return (
      <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-xl p-6 max-w-2xl">
        <p className="font-bold mb-1">Ofertas no disponibles</p>
        <p className="text-sm">{pageError}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 w-full">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-slate-800">Ofertas</h1>
          <p className="text-slate-500 text-sm mt-1">
            {activeCount === 0
              ? 'No hay ofertas vigentes: la caja cobra el precio normal.'
              : `${activeCount} ${activeCount === 1 ? 'oferta vigente' : 'ofertas vigentes'}. La caja las aplica sola al escanear.`}
          </p>
        </div>
        <button
          onClick={openModal}
          className="bg-[#0f5c5c] hover:bg-[#0a4545] text-white font-medium py-2.5 px-5 rounded-lg transition whitespace-nowrap cursor-pointer"
        >
          + Nueva oferta
        </button>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        {loading ? (
          <p className="p-8 text-center text-slate-500">Cargando ofertas…</p>
        ) : offers.length === 0 ? (
          <p className="p-10 text-center text-slate-500">
            Todavía no hay ofertas. Crea una y el teléfono y la caja la aplican al instante.
          </p>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead className="bg-slate-700 text-white text-sm">
              <tr>
                <th className="p-3">Aplica a</th>
                <th className="p-3 hidden sm:table-cell">Alcance</th>
                <th className="p-3 text-center">Descuento</th>
                <th className="p-3 hidden md:table-cell">Vigencia</th>
                <th className="p-3 text-center">Estado</th>
                <th className="p-3 text-center">Acción</th>
              </tr>
            </thead>
            <tbody>
              {offers.map(o => {
                const state = offerState(o);
                return (
                  <tr key={o.id} className="border-b border-slate-100 hover:bg-slate-50 transition">
                    <td className="p-3">
                      <p className="font-medium text-slate-800">{o.targetLabel}</p>
                      <p className="text-xs text-slate-500 sm:hidden">{OFFER_SCOPE_LABEL[o.scope]}</p>
                      <p className="text-xs text-slate-500 md:hidden">
                        {o.ends_at ? offerEndsLabel(o.ends_at) : 'sin fecha de fin'}
                      </p>
                    </td>
                    <td className="p-3 text-sm text-slate-600 hidden sm:table-cell">
                      {OFFER_SCOPE_LABEL[o.scope]}
                      {o.store_id && (
                        <span className="block text-xs text-slate-400">
                          {stores.find(s => s.id === o.store_id)?.name ?? 'tienda'}
                        </span>
                      )}
                    </td>
                    <td className="p-3 text-center font-black text-red-600">−{formatPercent(o.percent)}%</td>
                    <td className="p-3 text-sm text-slate-600 hidden md:table-cell">
                      {formatDate(o.starts_at)} → {o.ends_at ? formatDate(o.ends_at) : 'sin fin'}
                    </td>
                    <td className="p-3 text-center">
                      <span className={`text-[11px] font-bold uppercase px-2 py-1 rounded ${STATE_STYLE[state]}`}>
                        {OFFER_STATE_LABEL[state]}
                      </span>
                    </td>
                    <td className="p-3 text-center">
                      <div className="flex flex-col items-center gap-1">
                        {/* Solo tiene sentido para producto y modelo: una oferta
                            de categoría puede tocar cientos de productos y no se
                            manda un lote así sin elegirlo a mano. */}
                        {labelHref(o) && (
                          <Link
                            href={labelHref(o) as string}
                            className="text-sm font-semibold text-teal-700 hover:text-teal-900 underline whitespace-nowrap"
                          >
                            🏷️ Imprimir etiqueta
                          </Link>
                        )}
                        {o.is_active ? (
                          <button
                            onClick={() => void deactivate(o)}
                            className="text-sm font-semibold text-red-500 hover:text-red-700 underline cursor-pointer"
                          >
                            Desactivar
                          </button>
                        ) : (
                          !labelHref(o) && <span className="text-xs text-slate-400">—</span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <p className="text-xs text-slate-400 max-w-3xl leading-relaxed">
        Si un producto queda alcanzado por varias ofertas, manda la más específica:
        <strong> producto</strong> antes que <strong>modelo</strong>, y <strong>modelo</strong> antes que
        <strong> categoría</strong>. A igual nivel gana el descuento más alto. Cuando llega la fecha de fin la
        oferta se apaga sola, sin reimprimir ninguna etiqueta.
      </p>

      {/* MODAL: NUEVA OFERTA */}
      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title="Nueva oferta">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">¿A qué aplica?</label>
            <div className="bg-slate-100 p-1 rounded-lg flex flex-col sm:flex-row gap-1">
              {(['product', 'group', 'category'] as const).map(sc => (
                <button
                  key={sc}
                  type="button"
                  onClick={() => {
                    setScope(sc);
                    setTargetProduct(null);
                    setTargetGroup(null);
                    setSearch('');
                    setPreview(null);
                  }}
                  className={`flex-1 px-3 py-2 text-xs font-bold rounded-md transition-all cursor-pointer ${
                    scope === sc ? 'bg-white shadow-sm text-teal-800' : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  {OFFER_SCOPE_LABEL[sc]}
                </button>
              ))}
            </div>
          </div>

          {scope === 'category' ? (
            <>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Categoría</label>
                <select
                  value={category}
                  onChange={e => setCategory(e.target.value)}
                  className="w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none"
                >
                  {PRODUCT_CATEGORIES.map(c => (
                    <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Tienda</label>
                <select
                  value={storeId}
                  onChange={e => setStoreId(e.target.value)}
                  className="w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none"
                >
                  <option value="">Todas las tiendas</option>
                  {stores.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
            </>
          ) : (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                {scope === 'product' ? 'Producto' : 'Modelo (producto padre)'}
              </label>

              {targetProduct || targetGroup ? (
                <div className="flex items-center justify-between gap-3 bg-teal-50 border border-teal-200 rounded-lg px-3 py-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-teal-900 truncate">
                      {targetProduct ? targetProduct.name : targetGroup!.name}
                    </p>
                    {targetProduct && (
                      <p className="text-xs text-teal-700 font-mono">
                        {targetProduct.sku_barcode} · {fmtUSD(targetProduct.price)}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => { setTargetProduct(null); setTargetGroup(null); setPreview(null); }}
                    className="text-xs font-semibold text-teal-700 underline shrink-0 cursor-pointer"
                  >
                    cambiar
                  </button>
                </div>
              ) : (
                <>
                  <input
                    type="text"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder={scope === 'product' ? 'Busca por nombre o código…' : 'Busca el modelo por nombre…'}
                    className="w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none"
                  />
                  {(scope === 'product' ? productHits.length : groupHits.length) > 0 && (
                    <ul className="border border-slate-200 rounded-lg mt-1 max-h-48 overflow-y-auto divide-y divide-slate-100">
                      {scope === 'product'
                        ? productHits.map(p => (
                            <li key={p.id}>
                              <button
                                type="button"
                                onClick={() => { setTargetProduct(p); setSearch(''); setProductHits([]); }}
                                className="w-full text-left p-2.5 hover:bg-teal-50 transition flex justify-between gap-3 cursor-pointer"
                              >
                                <span className="min-w-0">
                                  <span className="block text-sm font-semibold text-slate-800 truncate">{p.name}</span>
                                  <span className="block text-xs text-slate-500 font-mono">{p.sku_barcode}</span>
                                </span>
                                <span className="text-sm font-bold text-teal-700 shrink-0">{fmtUSD(p.price)}</span>
                              </button>
                            </li>
                          ))
                        : groupHits.map(g => (
                            <li key={g.id}>
                              <button
                                type="button"
                                onClick={() => { setTargetGroup(g); setSearch(''); setGroupHits([]); }}
                                className="w-full text-left p-2.5 hover:bg-teal-50 transition text-sm font-semibold text-slate-800 cursor-pointer"
                              >
                                {g.name}
                              </button>
                            </li>
                          ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          )}

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-sm font-medium text-slate-700 mb-1">Descuento (%)</label>
              <input
                type="number"
                min="1"
                max="99"
                step="1"
                value={percent}
                onChange={e => setPercent(e.target.value)}
                className="w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none"
              />
            </div>
            <div className="flex-1">
              <label className="block text-sm font-medium text-slate-700 mb-1">Termina el (opcional)</label>
              <input
                type="date"
                value={endsAt}
                min={caracasToday()}
                onChange={e => setEndsAt(e.target.value)}
                className="w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none"
              />
            </div>
          </div>
          <p className="text-[11px] text-slate-400 -mt-2">
            Sin fecha de fin la oferta sigue hasta que se desactive a mano. Con fecha, el último día
            se cobra con descuento y al día siguiente se apaga sola.
          </p>

          {/* Vista previa */}
          {preview && percentValid && (
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
              <p className="text-xs font-bold text-slate-600 mb-2">
                Afecta a {preview.count} {preview.count === 1 ? 'producto' : 'productos'}
              </p>
              {preview.samples.map(p => (
                <div key={p.id} className="flex justify-between items-center gap-3 text-xs py-1">
                  <span className="truncate text-slate-600">{p.name}</span>
                  <span className="shrink-0 font-mono">
                    <span className="text-slate-400 line-through">{fmtUSD(p.price)}</span>
                    <span className="text-slate-900 font-bold ml-2">
                      {fmtUSD(previewOfferPrice(p.price, percentNum))}
                    </span>
                  </span>
                </div>
              ))}
              {preview.count === 0 && (
                <p className="text-xs text-amber-700 font-medium">
                  Ningún producto activo queda alcanzado. Revisa la categoría o la tienda.
                </p>
              )}
            </div>
          )}

          {formError && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm font-medium">
              {formError}
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              className="flex-1 py-2.5 rounded-lg border border-slate-300 text-slate-600 font-medium hover:bg-slate-50 transition cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="flex-1 py-2.5 rounded-lg bg-[#0f5c5c] hover:bg-[#0a4545] text-white font-medium transition disabled:opacity-50 cursor-pointer"
            >
              {saving ? 'Guardando…' : 'Crear oferta'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
