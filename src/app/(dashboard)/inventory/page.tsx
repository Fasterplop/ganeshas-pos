'use client';

import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { createClient } from '@/lib/supabase/client';
import Modal from '@/components/Modal';
import { usePOSStore, Store } from '@/store/usePOSStore';
import { SlidersHorizontal, ChevronRight, ChevronDown, ChevronsDown, ChevronsUp } from 'lucide-react';
import ExcelJS from 'exceljs';
import { variantLabel, formatVariant } from '@/lib/productVariant';
import BarcodeLabel from '@/components/labels/BarcodeLabel';
import { storePrefix, isClothingStore } from '@/lib/stores';
import { barcodeErrorMessage } from '@/lib/productBarcode';
import { categoryLabel } from '@/lib/categories';
import CameraScanner, { ScanButton } from '@/components/CameraScanner';

const productSchema = z.object({
  sku_barcode: z.string().optional(),
  name: z.string().min(3, { message: 'El nombre es obligatorio' }),
  category: z.enum(['juguetes', 'ropa', 'zapato', 'perfume', 'accesorios', 'lentes', 'uniforme_escolar', 'utiles_escolares', 'bolso', 'navaja_suiza'], {
    message: 'Selecciona una categoría válida',
  }),
  price: z.number({ message: 'Debe ser un número válido' }).min(0.01, { message: 'El precio debe ser mayor a 0' }),
  stock: z.number({ message: 'Debe ser un número válido' }),
  owner_store_id: z.string().min(1, { message: 'Selecciona una tienda' }),
  talla: z.string().optional(),
  color: z.string().optional(),
});

type ProductFormValues = z.infer<typeof productSchema>;

// Ajuste masivo de precios ya aplicado y todavía reversible (db/bulk_price_update.sql).
interface PriceAdjustment {
  id: string;
  percent: number;
  round_to: number;
  products_count: number;
  created_at: string;
}

// Resultado de la última operación del modal de precios (pantalla de "listo").
type PriceResult =
  | { kind: 'applied'; products: number }
  | { kind: 'reverted'; restored: number; skipped: number };
type ProductCategory = ProductFormValues['category'];

interface Product {
  id: string;
  sku_barcode: string;
  name: string;
  category: string;
  price: number;
  stock: number;
  owner_store_id: string | null;
  talla: string | null;
  color: string | null;
  created_at: string | null;       // alta del producto (null = anterior a la migración)
  label_printed_at: string | null; // primera impresión de etiqueta (null = nunca)
  parent_group_id: string | null;  // NULL = producto sin variantes (igual que hoy)
}

// "Producto padre": agrupa variantes (talla/color) de productos ya existentes.
// No es vendible ni escaneable; solo agrupa filas reales de `products`.
interface ProductGroup {
  id: string;
  name: string;
  category: string;
  default_price: number;
  owner_store_id: string;
  is_active: boolean;
}

// Una fila de la tabla de variantes embebida en el modal de alta.
interface VariantRowInput {
  key: string; // key local estable para React, no va a la BD
  sku_barcode: string;
  talla: string;
  color: string;
  // '' mientras el campo está vacío mientras se edita (si no, Number('') = 0
  // queda "pegado" y no se puede borrar el último dígito). Se normaliza a
  // número recién al guardar.
  stock: number | '';
  price: number | '';
}

// Categoría por defecto sugerida según la tienda.
function defaultCategoryForStore(storeName: string): 'juguetes' | 'ropa' | 'zapato' | 'perfume' {
  const n = storeName.toLowerCase();
  if (n.includes('ropa')) return 'ropa';
  if (n.includes('juguet')) return 'juguetes';
  return 'juguetes';
}

// Todas las categorías, en el orden del enum (única fuente de verdad: el schema).
const ALL_CATEGORIES: readonly ProductCategory[] = productSchema.shape.category.options;

// Categorías exclusivas de una tienda, decididas por el NOMBRE de la tienda
// (misma convención que storePrefix / lowStockMaxFor). Las que no aparecen
// aquí se ofrecen en todas las tiendas.
const CATEGORY_STORE_RULE: Partial<Record<ProductCategory, (storeNameLower: string) => boolean>> = {
  utiles_escolares: (n) => n.includes('juguet'),
};

// Categorías que se ofrecen en el formulario para una tienda dueña dada.
function categoriesForStore(storeName?: string | null): ProductCategory[] {
  const n = (storeName ?? '').toLowerCase();
  return ALL_CATEGORIES.filter(c => CATEGORY_STORE_RULE[c]?.(n) ?? true);
}

// --- Semáforo de stock ---------------------------------------------------
// "Stock bajo" = con existencias pero por debajo del umbral de SU TIENDA:
// juguetería rota más lento, así que ahí es 1 o menos; en el resto (ropa) es
// 2 o menos. El color ámbar y el filtro usan el mismo umbral. Los agotados
// (=< 0) tienen su propio color rojo y su propio filtro; verde por encima.
function lowStockMaxFor(storeName?: string | null): number {
  return (storeName ?? '').toLowerCase().includes('juguet') ? 1 : 2;
}
type StockTier = 'out' | 'low' | 'ok';
function stockTier(stock: number, lowMax: number): StockTier {
  if (stock <= 0) return 'out';      // rojo  → agotado / negativo
  if (stock <= lowMax) return 'low'; // ámbar → bajo
  return 'ok';                       // verde → normal
}
const isOut = (stock: number) => stock <= 0;                              // Agotados
const isLow = (stock: number, lowMax: number) => stock > 0 && stock <= lowMax; // Stock bajo

const TIER_BADGE: Record<StockTier, string> = {
  out: 'bg-red-50 text-red-600',
  low: 'bg-amber-50 text-amber-600',
  ok: 'bg-emerald-50 text-emerald-600',
};

// "Nuevo": producto dado de alta hace menos de 1 día al que todavía NO se le
// imprimió la etiqueta. Al imprimirla (se registra el clic) el badge desaparece.
const NEW_PRODUCT_MS = 24 * 60 * 60 * 1000;
function isNewProduct(p: Product): boolean {
  if (p.label_printed_at) return false; // ya se imprimió su etiqueta
  if (!p.created_at) return false;      // productos anteriores a la migración
  return Date.now() - new Date(p.created_at).getTime() < NEW_PRODUCT_MS;
}

// Columnas ordenables de la tabla (Stock Local y Talla/Color).
type SortKey = 'stock' | 'variant';

const PAGE_SIZE = 50; // paginación: 50 productos por página

// Tarjeta de resumen (Productos / Unidades / Costo) y filtros clickeables
// (Stock bajo / Agotados). Cuando trae onClick actúa como botón-filtro.
function StatCard({
  label, value, icon, sub, tone = 'default', active = false, onClick,
}: {
  label: string;
  value: string | number;
  icon: string;
  sub?: React.ReactNode;
  tone?: 'default' | 'amber' | 'red';
  active?: boolean;
  onClick?: () => void;
}) {
  const clickable = !!onClick;
  const activeRing =
    tone === 'red' ? 'border-red-300 bg-red-50 ring-2 ring-red-200'
    : tone === 'amber' ? 'border-amber-300 bg-amber-50 ring-2 ring-amber-200'
    : 'border-teal-300 bg-teal-50 ring-2 ring-teal-200';
  const iconWrap =
    tone === 'amber' ? 'bg-amber-100 text-amber-600'
    : tone === 'red' ? 'bg-red-100 text-red-500'
    : 'bg-teal-50 text-teal-600';
  const valueColor =
    tone === 'amber' ? 'text-amber-600'
    : tone === 'red' ? 'text-red-600'
    : 'text-slate-800';
  const className = `relative text-left bg-white rounded-xl border p-3 md:p-4 flex items-center gap-2 md:gap-3 transition
    ${active ? activeRing : 'border-slate-200'}
    ${clickable ? 'hover:border-slate-300 hover:shadow-sm cursor-pointer' : 'cursor-default'}`;
  const inner = (
    <>
      <span className={`shrink-0 w-9 h-9 md:w-11 md:h-11 rounded-full flex items-center justify-center text-base md:text-lg ${iconWrap}`}>{icon}</span>
      <span className="min-w-0">
        <span className="block text-[11px] md:text-xs font-medium text-slate-500 truncate">{label}</span>
        <span className={`block text-lg md:text-2xl font-bold leading-tight truncate ${valueColor}`}>{value}</span>
        {sub}
      </span>
      {active && (
        <span className={`absolute top-2 right-2 w-5 h-5 rounded-full text-white text-xs flex items-center justify-center ${tone === 'red' ? 'bg-red-500' : 'bg-amber-500'}`}>✓</span>
      )}
    </>
  );
  // Clickeable → botón-filtro; informativa → div (evita el "atenuado" de un botón disabled).
  return clickable ? (
    <button type="button" onClick={onClick} className={className}>{inner}</button>
  ) : (
    <div className={className}>{inner}</div>
  );
}

export default function InventoryPage() {
  const { currentStore } = usePOSStore();
  const supabase = createClient();

  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [canRestockAll, setCanRestockAll] = useState(false);   // reponer en TODAS las tiendas
  const [canRestockLocal, setCanRestockLocal] = useState(false); // reponer solo en su tienda asignada

  const [searchTerm, setSearchTerm] = useState('');

  // Escáner con la cámara: qué campo se llena con el código leído. Una sola
  // lectura y se cierra; nunca envía un formulario por su cuenta.
  const [cameraTarget, setCameraTarget] = useState<
    | { kind: 'search' }
    | { kind: 'form' }
    | { kind: 'variant'; key: string }
    | { kind: 'addVariant' }
    | { kind: 'barcode' }
    | null
  >(null);

  // Orden de columnas, filtro por semáforo de stock y paginación.
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [stockFilter, setStockFilter] = useState<'all' | 'low' | 'out'>('all');
  const [page, setPage] = useState(1);

  // Filtro por categoría: se elige desde el botón "Filtros" junto al buscador.
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [filtersOpen, setFiltersOpen] = useState(false);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);

  const [formError, setFormError] = useState<string | null>(null);

  // --- Variantes de producto (grupos) ---
  const [groups, setGroups] = useState<ProductGroup[]>([]);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const toggleGroupExpanded = (groupId: string) =>
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId); else next.add(groupId);
      return next;
    });

  // Alta con variantes: toggle + filas de la tabla embebida del modal.
  const [hasVariants, setHasVariants] = useState(false);
  const [variantRows, setVariantRows] = useState<VariantRowInput[]>([]);
  const newVariantRow = (price: number): VariantRowInput => ({
    key: `v-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    sku_barcode: '', talla: '', color: '', stock: 0, price,
  });

  // Modal "Vincular a producto padre" (para productos sueltos existentes).
  const [linkingProduct, setLinkingProduct] = useState<Product | null>(null);
  const [linkMode, setLinkMode] = useState<'existing' | 'new'>('new');
  const [linkGroupSearch, setLinkGroupSearch] = useState('');
  const [linkNewGroupName, setLinkNewGroupName] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkSubmitting, setLinkSubmitting] = useState(false);

  // Modal "Editar producto padre" (renombrar el grupo).
  const [editingGroup, setEditingGroup] = useState<ProductGroup | null>(null);
  const [editGroupName, setEditGroupName] = useState('');
  const [editGroupError, setEditGroupError] = useState<string | null>(null);
  const [editGroupSubmitting, setEditGroupSubmitting] = useState(false);

  // Modal "Agregar variante" a un producto padre YA existente.
  const [addingVariantGroup, setAddingVariantGroup] = useState<ProductGroup | null>(null);
  const [addVariantSku, setAddVariantSku] = useState('');
  const [addVariantTalla, setAddVariantTalla] = useState('');
  const [addVariantColor, setAddVariantColor] = useState('');
  const [addVariantStock, setAddVariantStock] = useState<number | ''>(0);
  const [addVariantPrice, setAddVariantPrice] = useState<number | ''>(0);
  const [addVariantError, setAddVariantError] = useState<string | null>(null);
  const [addVariantSubmitting, setAddVariantSubmitting] = useState(false);

  const [promoName, setPromoName] = useState('Liquidación');
  const [discountPercent, setDiscountPercent] = useState(0);
  // Formato de la etiqueta: 'auto' sigue la regla del negocio (sin precio solo
  // en la Tienda de Ropa); los otros dos la fuerzan para un caso suelto.
  const [labelPriceMode, setLabelPriceMode] = useState<'auto' | 'sin_precio' | 'con_precio'>('auto');

  // --- Cambiar el código de barras de un producto --------------------------
  // Va por el RPC set_product_barcode (db/scanner_02_…sql), que revalida rol y
  // alcance en el servidor. Lo abre cualquiera que ya pueda añadir productos.
  const [barcodeTarget, setBarcodeTarget] = useState<Product | null>(null);
  const [barcodeValue, setBarcodeValue] = useState('');
  const [barcodeError, setBarcodeError] = useState<string | null>(null);
  const [barcodeSaving, setBarcodeSaving] = useState(false);

  // --- Ajuste masivo de precios (solo owner, sobre la tienda que se ve) ---
  const [priceModalOpen, setPriceModalOpen] = useState(false);
  const [priceDirection, setPriceDirection] = useState<'up' | 'down'>('up');
  const [pricePercent, setPricePercent] = useState<number | ''>(10);
  // Por defecto sin decimales: $141.60 queda en $142.
  const [priceRoundTo, setPriceRoundTo] = useState(1);
  // El botón "Aplicar" no ejecuta: abre la confirmación (toca TODO el catálogo).
  const [priceConfirming, setPriceConfirming] = useState(false);
  const [priceApplying, setPriceApplying] = useState(false);
  const [priceError, setPriceError] = useState<string | null>(null);
  const [priceResult, setPriceResult] = useState<PriceResult | null>(null);
  // Último ajuste de esta tienda que todavía se puede deshacer (null = ninguno).
  const [lastAdjustment, setLastAdjustment] = useState<PriceAdjustment | null>(null);
  const [priceRevertConfirming, setPriceRevertConfirming] = useState(false);
  const [priceReverting, setPriceReverting] = useState(false);

  // Tiendas activas + tienda que se está VIENDO (filtro local, solo para vista).
  const [stores, setStores] = useState<Store[]>([]);
  const [viewStoreId, setViewStoreId] = useState<string>('');

  const { register, handleSubmit, reset, watch, setValue, getValues, formState: { errors, isSubmitting } } = useForm<ProductFormValues>({
    resolver: zodResolver(productSchema),
    defaultValues: { stock: 0, sku_barcode: '' }
  });

  // --- Código autogenerado, estable mientras el formulario esté abierto ------
  //
  // Antes el código se sorteaba DENTRO del submit: dos clics seguidos daban
  // ROP-575914 y ROP-170871, dos códigos distintos, y el UNIQUE de
  // products.sku_barcode —que existe justo para esto— no llegaba a dispararse.
  // Por eso un doble clic creaba dos productos en vez de fallar.
  //
  // Ahora cada "ranura" (el producto suelto, o cada fila de variante) recuerda
  // su código mientras el formulario está abierto. Si el guardado se repite
  // —doble clic, reintento por red lenta— vuelve a mandar EL MISMO código y la
  // base lo rechaza. Se limpia al cerrar el formulario.
  const autoSkuRef = useRef<Record<string, string>>({});
  const autoSku = (prefix: string, slot: string) => {
    const k = `${prefix}:${slot}`;
    if (!autoSkuRef.current[k]) {
      autoSkuRef.current[k] = `${prefix}-${Math.floor(100000 + Math.random() * 900000)}`;
    }
    return autoSkuRef.current[k];
  };

  // La tienda que se está viendo.
  const effectiveStore = stores.find(s => s.id === viewStoreId) ?? currentStore;

  // Capacidades según rol y permiso especial:
  const isOwner = userRole === 'owner';
  const isCashier = userRole === 'cashier';
  const isOwnStore = !!currentStore && viewStoreId === currentStore.id;

  // Alcance de reposición del cajero:
  //   global → repone/añade en cualquier tienda.
  //   local  → repone/añade SOLO en su tienda asignada (== currentStore).
  const isGlobalRestocker = isCashier && canRestockAll;
  const isLocalRestocker = isCashier && canRestockLocal && !canRestockAll;
  const isRestocker = isGlobalRestocker || isLocalRestocker; // cajero reponedor (cualquier alcance)
  // El reponedor local solo puede operar cuando está viendo su tienda asignada.
  const canRestockHere = isGlobalRestocker || (isLocalRestocker && isOwnStore);

  // Añadir productos: owner (su tienda) o reponedor (según su alcance).
  // El cajero SIN reposición no puede añadir.
  const canAdd = (isOwner && isOwnStore) || canRestockHere;
  // Borrar: solo owner en su propia tienda.
  const canDelete = isOwner && isOwnStore;
  // Abrir el editor (reponer stock): owner (su tienda) o reponedor (según alcance).
  const canEditRow = (isOwner && isOwnStore) || canRestockHere;
  // Solo lectura: no puede gestionar nada aquí (cajero sin reposición, reponedor
  // local viendo otra tienda, u owner en otra tienda).
  const readOnly = !canAdd && !canEditRow;
  // Al EDITAR, el reponedor solo puede tocar el stock (al AÑADIR usa el formulario completo).
  const editStockOnly = isRestocker && !!editingProduct;

  // Tienda seleccionada en el formulario de alta (para el aviso y el prefijo del SKU).
  const watchedOwnerStoreId = watch('owner_store_id');
  const formStore = stores.find(s => s.id === watchedOwnerStoreId) ?? currentStore;

  // Categorías del select: las permitidas para la tienda dueña elegida. Al editar
  // un producto cuya categoría ya no está permitida (dato legado), se conserva
  // como opción para que el select no la cambie en silencio.
  const allowedCategories = categoriesForStore(formStore?.name);
  const selectableCategories: string[] =
    editingProduct && !allowedCategories.includes(editingProduct.category as ProductCategory)
      ? [...allowedCategories, editingProduct.category]
      : allowedCategories;

  // Rol del usuario + tiendas activas (para los selectores de vista y de alta).
  async function loadStores() {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      // Intentamos leer los permisos de reposición; si alguna columna aún no
      // existe (SQL sin aplicar), degradamos sin romper el resto de la vista.
      const { data: profile, error } = await supabase
        .from('profiles')
        .select('role, can_restock_all, can_restock_local')
        .eq('id', user.id)
        .single();

      if (profile) {
        setUserRole(profile.role);
        setCanRestockAll(profile.can_restock_all ?? false);
        setCanRestockLocal(profile.can_restock_local ?? false);
      } else if (error) {
        // Migración de can_restock_local sin aplicar: probamos con la global.
        const { data: mid } = await supabase.from('profiles').select('role, can_restock_all').eq('id', user.id).single();
        if (mid) {
          setUserRole(mid.role);
          setCanRestockAll(mid.can_restock_all ?? false);
          setCanRestockLocal(false);
        } else {
          const { data: basic } = await supabase.from('profiles').select('role').eq('id', user.id).single();
          if (basic) {
            setUserRole(basic.role);
            setCanRestockAll(false);
            setCanRestockLocal(false);
          }
        }
      }
    }
    const { data: activeStores } = await supabase
      .from('stores')
      .select('id, name, is_active')
      .eq('is_active', true)
      .order('name');
    if (activeStores) setStores(activeStores as Store[]);
  }

  // Inventario (productos + stock) de UNA tienda: los productos cuya tienda dueña
  // es esa, con el stock de esa tienda (puede ser negativo si hubo sobreventa).
  //
  // OJO: Supabase corta cada respuesta en 1000 filas. Con más de 1000 productos,
  // leer store_stock completo (o products sin paginar) deja fuera las filas más
  // nuevas, que se mostrarían con stock 0 ("Agotados") aunque tengan stock. Por
  // eso: el stock de la tienda va EMBEBIDO en la consulta de productos (una fila
  // por producto) y se pagina con .range() hasta traerlo todo.
  async function fetchProducts(storeId: string) {
    setLoading(true);

    const PAGE = 1000;
    const BASE_COLS = 'id, sku_barcode, name, category, price, owner_store_id, talla, color';
    const fetchPage = (cols: string, from: number) =>
      supabase
        .from('products')
        .select(`${cols}, store_stock(stock)` as '*')
        .eq('is_active', true)
        .eq('owner_store_id', storeId)
        .eq('store_stock.store_id', storeId)
        .order('name')
        .order('id') // desempate estable para que la paginación no duplique/salte filas
        .range(from, from + PAGE - 1);

    // created_at/label_printed_at/parent_group_id alimentan el badge "Nuevo" y
    // las variantes agrupadas. Si esas columnas aún no existen (migración sin
    // aplicar), degradamos escalón por escalón para no dejar el inventario vacío.
    let globalProducts: Record<string, unknown>[] | null = null;
    for (const cols of [
      `${BASE_COLS}, created_at, label_printed_at, parent_group_id`,
      `${BASE_COLS}, created_at, label_printed_at`,
      BASE_COLS,
    ]) {
      const rows: Record<string, unknown>[] = [];
      let failed = false;
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await fetchPage(cols, from);
        if (error) { failed = true; break; }
        rows.push(...(data ?? []));
        if (!data || data.length < PAGE) break;
      }
      if (!failed) { globalProducts = rows; break; }
    }

    if (globalProducts) {
      const mergedProducts: Product[] = globalProducts.map(p => {
        const row = p as Partial<Product> & { id: string; store_stock?: { stock: number }[] };
        return {
          id: row.id,
          sku_barcode: row.sku_barcode ?? '',
          name: row.name ?? '',
          category: row.category ?? '',
          price: row.price ?? 0,
          owner_store_id: row.owner_store_id ?? null,
          talla: row.talla ?? null,
          color: row.color ?? null,
          created_at: row.created_at ?? null,
          label_printed_at: row.label_printed_at ?? null,
          parent_group_id: row.parent_group_id ?? null,
          stock: row.store_stock?.[0]?.stock ?? 0,
        };
      });
      setProducts(mergedProducts);
    } else {
      setProducts([]);
    }

    setLoading(false);
  }

  // Grupos de variantes ("producto padre") de la tienda que se está viendo.
  // Pocos registros hoy, pero se pagina igual que products/customers (regla
  // del proyecto: toda consulta masiva pagina, Supabase corta en 1000 filas).
  async function fetchGroups(storeId: string) {
    const PAGE = 1000;
    const rows: ProductGroup[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('product_groups')
        .select('id, name, category, default_price, owner_store_id, is_active')
        .eq('owner_store_id', storeId)
        .eq('is_active', true)
        .order('name')
        .order('id')
        .range(from, from + PAGE - 1);
      if (error) { setGroups([]); return; } // migración sin aplicar: sin grupos, sin romper la vista
      rows.push(...((data as ProductGroup[]) ?? []));
      if (!data || data.length < PAGE) break;
    }
    setGroups(rows);
  }

  async function refreshInventory(storeId: string) {
    await Promise.all([fetchProducts(storeId), fetchGroups(storeId)]);
  }

  // Al cambiar la tienda de operación: reseteamos la vista a esa tienda y recargamos catálogos.
  useEffect(() => {
    setIsModalOpen(false);
    setSelectedProduct(null);
    if (currentStore) {
      loadStores();
      setViewStoreId(currentStore.id);
    } else {
      setProducts([]);
    }
  }, [currentStore?.id]);

  // Cargar el inventario de la tienda que se está viendo.
  useEffect(() => {
    if (viewStoreId) refreshInventory(viewStoreId);
  }, [viewStoreId]);

  // Cualquier cambio de búsqueda/filtro/orden/tienda vuelve a la primera página.
  useEffect(() => {
    setPage(1);
  }, [searchTerm, stockFilter, categoryFilter, sortKey, sortDir, viewStoreId]);

  // Si la búsqueda encuentra una variante, expandimos su grupo automáticamente
  // para que las hermanas (y el padre) se vean sin un clic extra.
  useEffect(() => {
    const term = searchTerm.trim().toLowerCase();
    if (term.length < 2) return;
    const matched = products.filter(p =>
      p.parent_group_id && (p.name.toLowerCase().includes(term) || p.sku_barcode.toLowerCase().includes(term))
    );
    if (matched.length === 0) return;
    setExpandedGroups(prev => {
      const next = new Set(prev);
      matched.forEach(p => next.add(p.parent_group_id as string));
      return next;
    });
  }, [searchTerm, products]);

  // Al cambiar de tienda, el filtro de categoría vuelve a "Todas" (cada tienda
  // tiene su propio surtido de categorías).
  useEffect(() => {
    setCategoryFilter('all');
    setFiltersOpen(false);
  }, [viewStoreId]);

  // Al seleccionar un producto: el nombre de promoción arranca con el nombre
  // del producto y el descuento se reinicia (opcional, 0 = sin descuento).
  useEffect(() => {
    if (selectedProduct) {
      setPromoName(selectedProduct.name);
      setDiscountPercent(0);
    }
  }, [selectedProduct?.id]);

  // Manejador dinámico para abrir el formulario asignando los valores por defecto requeridos
  const handleOpenAddModal = () => {
    setEditingProduct(null);
    setFormError(null);
    setHasVariants(false);
    setVariantRows([]);

    reset({
      sku_barcode: '',
      name: '',
      category: defaultCategoryForStore(effectiveStore?.name || currentStore?.name || ''),
      price: 0,
      stock: 1, // stock inicial por defecto
      owner_store_id: viewStoreId || currentStore?.id || '', // default: la tienda que se está viendo
      talla: '',
      color: '',
    });
    setIsModalOpen(true);
  };

  // Crea UNA fila de producto (standalone o variante hija de un grupo) + su
  // stock inicial en la tienda dueña. La usan tanto el alta simple como el
  // alta "con variantes" (una llamada por fila de la tabla embebida).
  async function createProductRow(row: {
    sku_barcode: string; name: string; category: string; price: number;
    talla: string; color: string; stock: number; ownerStoreId: string; parentGroupId?: string | null;
  }): Promise<{ error: string | null }> {
    const { data: newProduct, error: productError } = await supabase
      .from('products')
      .insert([{
        sku_barcode: row.sku_barcode,
        name: row.name,
        category: row.category,
        price: row.price,
        is_active: true,
        owner_store_id: row.ownerStoreId,
        talla: row.talla.trim() ? row.talla.trim() : null,
        color: row.color.trim() ? row.color.trim() : null,
        parent_group_id: row.parentGroupId ?? null,
      }])
      .select('id')
      .single();

    if (productError || !newProduct) {
      if (productError?.code === '23505') return { error: `⚠️ Ya existe un producto con el código "${row.sku_barcode}".` };
      return { error: 'Error al crear producto: ' + productError?.message };
    }

    if (row.stock > 0) {
      if (isRestocker) {
        const { error } = await supabase.rpc('restock_stock', {
          p_product_id: newProduct.id,
          p_store_id: row.ownerStoreId,
          p_new_stock: row.stock,
        });
        if (error) return { error: `Producto "${row.sku_barcode}" creado, pero no se pudo cargar el stock inicial: ${error.message}` };
      } else {
        const { error: stockError } = await supabase
          .from('store_stock')
          .upsert({ product_id: newProduct.id, store_id: row.ownerStoreId, stock: row.stock }, { onConflict: 'product_id, store_id' });
        if (stockError) return { error: `Producto "${row.sku_barcode}" creado, pero no se pudo cargar el stock inicial: ${stockError.message}` };
      }
    }
    return { error: null };
  }

  // --- Vincular un producto suelto existente a un producto padre ---------
  const openLinkModal = (product: Product) => {
    setLinkingProduct(product);
    setLinkMode('new');
    setLinkGroupSearch('');
    setLinkNewGroupName(product.name);
    setLinkError(null);
  };
  const closeLinkModal = () => {
    setLinkingProduct(null);
    setLinkError(null);
    setLinkSubmitting(false);
  };
  const matchingGroups = linkGroupSearch.trim()
    ? groups.filter(g => g.name.toLowerCase().includes(linkGroupSearch.trim().toLowerCase()))
    : groups;

  const handleLinkExisting = async (groupId: string, groupName: string) => {
    if (!linkingProduct) return;
    if (!window.confirm(`¿Vincular "${linkingProduct.name}" (${linkingProduct.sku_barcode}) a "${groupName}"?`)) return;
    setLinkSubmitting(true);
    setLinkError(null);
    const { error } = await supabase
      .from('products')
      .update({ parent_group_id: groupId })
      .eq('id', linkingProduct.id);
    setLinkSubmitting(false);
    if (error) { setLinkError('No se pudo vincular: ' + error.message); return; }
    closeLinkModal();
    refreshInventory(viewStoreId);
  };

  const handleLinkCreateNew = async () => {
    if (!linkingProduct) return;
    if (!linkNewGroupName.trim()) { setLinkError('Ponle un nombre al producto padre.'); return; }
    if (!window.confirm(`¿Crear el producto padre "${linkNewGroupName.trim()}" y vincular "${linkingProduct.name}" (${linkingProduct.sku_barcode})?`)) return;
    setLinkSubmitting(true);
    setLinkError(null);
    const { data: newGroup, error: groupError } = await supabase
      .from('product_groups')
      .insert([{
        name: linkNewGroupName.trim(),
        category: linkingProduct.category,
        default_price: linkingProduct.price,
        owner_store_id: linkingProduct.owner_store_id ?? viewStoreId,
        is_active: true,
      }])
      .select('id')
      .single();
    if (groupError || !newGroup) {
      setLinkSubmitting(false);
      setLinkError('No se pudo crear el producto padre: ' + groupError?.message);
      return;
    }
    const { error: linkErr } = await supabase
      .from('products')
      .update({ parent_group_id: newGroup.id })
      .eq('id', linkingProduct.id);
    setLinkSubmitting(false);
    if (linkErr) { setLinkError('Grupo creado, pero no se pudo vincular el producto: ' + linkErr.message); return; }
    closeLinkModal();
    refreshInventory(viewStoreId);
  };

  // --- Editar el nombre de un producto padre --------------------------------
  const openEditGroupModal = (group: ProductGroup) => {
    setEditingGroup(group);
    setEditGroupName(group.name);
    setEditGroupError(null);
  };
  const closeEditGroupModal = () => {
    setEditingGroup(null);
    setEditGroupError(null);
    setEditGroupSubmitting(false);
  };
  const handleSaveGroupName = async () => {
    if (!editingGroup) return;
    const newName = editGroupName.trim();
    if (!newName) { setEditGroupError('El nombre no puede quedar vacío.'); return; }
    setEditGroupSubmitting(true);
    setEditGroupError(null);
    const { error } = await supabase
      .from('product_groups')
      .update({ name: newName })
      .eq('id', editingGroup.id);
    setEditGroupSubmitting(false);
    if (error) { setEditGroupError('No se pudo guardar: ' + error.message); return; }
    closeEditGroupModal();
    refreshInventory(viewStoreId);
  };

  // --- Agregar una variante nueva a un producto padre ya existente ---------
  const openAddVariantModal = (group: ProductGroup) => {
    setAddingVariantGroup(group);
    setAddVariantSku('');
    setAddVariantTalla('');
    setAddVariantColor('');
    setAddVariantStock(0);
    setAddVariantPrice(group.default_price);
    setAddVariantError(null);
  };
  const closeAddVariantModal = () => {
    autoSkuRef.current = {};
    setAddingVariantGroup(null);
    setAddVariantError(null);
    setAddVariantSubmitting(false);
  };
  const handleAddVariantSubmit = async () => {
    if (!addingVariantGroup) return;
    setAddVariantSubmitting(true);
    setAddVariantError(null);

    // Esa talla y color ya existen en este modelo. Es la via lenta del
    // duplicado: no un doble clic, sino volver a agregar dias despues una
    // variante que ya estaba. Quedaban dos filas identicas con codigos
    // distintos y el stock repartido entre las dos.
    const claveNueva = `${addVariantTalla.trim().toUpperCase()}|${addVariantColor.trim().toUpperCase()}`;
    const repetida = products.find(
      pr => pr.parent_group_id === addingVariantGroup.id &&
            `${(pr.talla ?? '').trim().toUpperCase()}|${(pr.color ?? '').trim().toUpperCase()}` === claveNueva,
    );
    if (repetida) {
      const etiqueta = formatVariant(addVariantTalla, addVariantColor) || 'sin talla ni color';
      setAddVariantSubmitting(false);
      setAddVariantError(
        `Este modelo ya tiene esa variante (${etiqueta}), con el código ${repetida.sku_barcode}. ` +
        'Si quieres sumarle unidades, edítala y repón su stock en vez de agregarla otra vez.'
      );
      return;
    }

    const targetStore = stores.find(s => s.id === addingVariantGroup.owner_store_id) ?? currentStore;
    let sku = addVariantSku.trim();
    if (!sku && targetStore) {
      sku = autoSku(storePrefix(targetStore.name), 'addvariant');
    }

    const { error } = await createProductRow({
      sku_barcode: sku,
      name: addingVariantGroup.name,
      category: addingVariantGroup.category,
      price: addVariantPrice === '' ? 0 : addVariantPrice,
      talla: addVariantTalla,
      color: addVariantColor,
      stock: addVariantStock === '' ? 0 : addVariantStock,
      ownerStoreId: addingVariantGroup.owner_store_id,
      parentGroupId: addingVariantGroup.id,
    });

    setAddVariantSubmitting(false);
    if (error) { setAddVariantError(error); return; }
    closeAddVariantModal();
    setExpandedGroups(prev => new Set(prev).add(addingVariantGroup.id));
    refreshInventory(viewStoreId);
  };

  const onSubmitProduct = async (data: ProductFormValues) => {
    if (!currentStore) return;
    setFormError(null);

    // Cajero (normal o reponedor): solo puede AUMENTAR el stock, nunca bajarlo.
    if (editingProduct && isCashier && data.stock < editingProduct.stock) {
      setFormError(`⚠️ Como cajero solo puedes aumentar el stock (actual: ${editingProduct.stock}).`);
      return;
    }

    // Cajero REPONEDOR editando: solo repone stock en la tienda que ve (cruza
    // tiendas vía RPC), sin tocar ningún otro dato del producto.
    if (editingProduct && editStockOnly) {
      const { error } = await supabase.rpc('restock_stock', {
        p_product_id: editingProduct.id,
        p_store_id: viewStoreId,
        p_new_stock: data.stock,
      });
      if (error) {
        setFormError('No se pudo reponer el stock: ' + error.message);
        return;
      }
      closeModal();
      refreshInventory(viewStoreId);
      return;
    }

    // En edición (owner / cajero normal), el producto pertenece a la tienda que se
    // ve (== su tienda de operación). En creación, la tienda dueña la elige el usuario.
    const targetStoreId = editingProduct ? viewStoreId : data.owner_store_id;
    const targetStore = stores.find(s => s.id === targetStoreId) ?? currentStore;

    // Al crear, la categoría debe estar disponible para la tienda dueña elegida
    // (el select ya la restringe; esto cubre cualquier estado intermedio).
    if (!editingProduct && !categoriesForStore(targetStore.name).includes(data.category)) {
      setFormError(`La categoría "${categoryLabel(data.category)}" no está disponible para ${targetStore.name}.`);
      return;
    }

    let finalSku = data.sku_barcode?.trim();
    if (!finalSku) {
      // SKU autogenerado con prefijo de la TIENDA dueña (JUG/ROP), no de la
      // categoría. Estable mientras el formulario siga abierto: ver autoSku.
      finalSku = autoSku(storePrefix(targetStore.name), 'suelto');
    }

    if (editingProduct) {
      // OJO: `sku_barcode` NO se manda acá. Cambiar el código de un producto que
      // ya está etiquetado en el piso de venta es una operación aparte, con su
      // propia confirmación y su propio RPC validado en el servidor
      // (set_product_barcode). Ver el botón "Cambiar código" del formulario.
      const { error: productError } = await supabase
        .from('products')
        .update({
          name: data.name,
          category: data.category,
          price: data.price,
          talla: data.talla?.trim() ? data.talla.trim() : null,
          color: data.color?.trim() ? data.color.trim() : null
        })
        .eq('id', editingProduct.id);

      if (productError) {
        if (productError.code === '23505') setFormError('⚠️ Ya existe un producto con este código.');
        else setFormError('Error al actualizar info global: ' + productError.message);
        return;
      }

      // ESTA ES LA SOLUCIÓN: Usar upsert obligará a crear la fila si es un producto viejo
      const { error: stockError } = await supabase
        .from('store_stock')
        .upsert({
          product_id: editingProduct.id,
          store_id: targetStoreId,
          stock: data.stock
        }, { onConflict: 'product_id, store_id' });

      if (stockError) {
        setFormError('Error al actualizar el stock local: ' + stockError.message);
        return;
      }

    } else if (hasVariants) {
      // MODO CREACIÓN CON VARIANTES: 1) crear el producto padre (grupo),
      // 2) crear una fila de producto por variante, vinculada al grupo.
      if (variantRows.length < 2) {
        setFormError('Agrega al menos 2 variantes, o desmarca "¿Este producto tiene variantes?".');
        return;
      }

      // Dos filas con la misma talla y color son dos productos que nadie va a
      // poder distinguir en el inventario. Es la via por la que aparecieron
      // varias tallas repetidas dentro de un mismo modelo.
      const vistas = new Map<string, number>();
      for (const [i, v] of variantRows.entries()) {
        const k = `${(v.talla ?? '').trim().toUpperCase()}|${(v.color ?? '').trim().toUpperCase()}`;
        if (vistas.has(k)) {
          const etiqueta = formatVariant(v.talla, v.color) || 'sin talla ni color';
          setFormError(
            `Las filas ${vistas.get(k)! + 1} y ${i + 1} tienen la misma talla y color (${etiqueta}). ` +
            'Deja una sola, o diferencialas.'
          );
          return;
        }
        vistas.set(k, i);
      }

      // Ya existe un modelo con ese nombre en esta tienda. Es exactamente lo
      // que pasa al guardar dos veces: como product_groups no tiene un UNIQUE,
      // la base aceptaba el segundo modelo sin chistar.
      //
      // Es un aviso, no una garantia: `groups` solo trae los modelos de la
      // tienda que se esta VIENDO, asi que si se crea para la otra tienda el
      // chequeo no encuentra nada y deja pasar. La defensa de verdad contra el
      // doble clic es el boton bloqueado y el codigo estable de arriba; el
      // UNIQUE en product_groups hay que agregarlo en la base, y no se puede
      // hasta limpiar los 7 modelos repetidos que ya existen.
      const nombreNuevo = data.name.trim().toUpperCase();
      const yaExiste = groups.find(
        g => g.owner_store_id === targetStoreId && g.name.trim().toUpperCase() === nombreNuevo,
      );
      if (yaExiste) {
        setFormError(
          `Ya existe un modelo llamado "${yaExiste.name}" en ${targetStore.name}. ` +
          'Si querías agregarle tallas, ciérralo acá y usa "Agregar variante" sobre ese modelo en el inventario.'
        );
        return;
      }
      const { data: newGroup, error: groupError } = await supabase
        .from('product_groups')
        .insert([{
          name: data.name,
          category: data.category,
          default_price: data.price,
          owner_store_id: targetStoreId,
          is_active: true,
        }])
        .select('id')
        .single();

      if (groupError || !newGroup) {
        setFormError('Error al crear el producto padre: ' + groupError?.message);
        return;
      }

      const rowErrors: string[] = [];
      let creadas = 0;
      for (const [idx, v] of variantRows.entries()) {
        let sku = v.sku_barcode.trim();
        if (!sku) {
          // Cada fila recuerda su código: un reintento manda los mismos.
          sku = autoSku(storePrefix(targetStore.name), `v${idx}`);
        }
        const { error } = await createProductRow({
          sku_barcode: sku,
          name: data.name,
          category: data.category,
          price: v.price === '' ? 0 : v.price,
          talla: v.talla,
          color: v.color,
          stock: v.stock === '' ? 0 : v.stock,
          ownerStoreId: targetStoreId,
          parentGroupId: newGroup.id,
        });
        if (error) rowErrors.push(error);
        else creadas++;
      }
      if (creadas === 0) {
        // El modelo quedo creado pero sin una sola talla. Pasa cuando se corta
        // la conexion a mitad del guardado: son inserciones sueltas, no una
        // transaccion. Decirlo claro evita el modelo fantasma que nadie sabe
        // de donde salio, y evita que se vuelva a guardar creando otro modelo.
        setFormError(
          `Se creo el modelo "${data.name}" pero NO se pudo guardar ninguna talla. ` +
          'Buscalo en el inventario y agregale las tallas con "Agregar variante", ' +
          'o borralo y vuelve a empezar. No lo guardes otra vez desde aca: crearia un modelo repetido.'
        );
        refreshInventory(viewStoreId);
        return;
      }
      if (rowErrors.length > 0) {
        alert('Producto padre creado. Algunas variantes tuvieron problemas:\n' + rowErrors.join('\n'));
      }
    } else {
      // MODO CREACIÓN: Insertar Producto Globalmente, atado a su tienda dueña.
      const { error } = await createProductRow({
        sku_barcode: finalSku,
        name: data.name,
        category: data.category,
        price: data.price,
        talla: data.talla ?? '',
        color: data.color ?? '',
        stock: data.stock,
        ownerStoreId: targetStoreId,
      });
      if (error) { setFormError(error); return; }
    }

    closeModal();
    refreshInventory(viewStoreId);
  };

  // --- Cambiar el código de barras -----------------------------------------
  const openBarcodeModal = (product: Product) => {
    setBarcodeTarget(product);
    setBarcodeValue('');
    setBarcodeError(null);
  };

  const closeBarcodeModal = () => {
    setBarcodeTarget(null);
    setBarcodeValue('');
    setBarcodeError(null);
    setBarcodeSaving(false);
  };

  const submitBarcodeChange = async () => {
    if (!barcodeTarget) return;
    const nuevo = barcodeValue.trim();
    if (!nuevo) {
      setBarcodeError('Escribe o escanea el código nuevo.');
      return;
    }
    if (nuevo === barcodeTarget.sku_barcode) {
      closeBarcodeModal();
      return;
    }

    setBarcodeSaving(true);
    setBarcodeError(null);
    const { error } = await supabase.rpc('set_product_barcode', {
      p_product_id: barcodeTarget.id,
      p_new_sku: nuevo,
    });
    setBarcodeSaving(false);

    if (error) {
      setBarcodeError(barcodeErrorMessage(error));
      return;
    }

    // El código nuevo se refleja al instante en la lista, en el producto
    // seleccionado (para que "Imprimir Etiqueta" salga ya con el nuevo) y en el
    // formulario de edición si está abierto.
    setProducts(prev => prev.map(pr => (pr.id === barcodeTarget.id ? { ...pr, sku_barcode: nuevo } : pr)));
    setSelectedProduct(prev => (prev && prev.id === barcodeTarget.id ? { ...prev, sku_barcode: nuevo } : prev));
    setEditingProduct(prev => (prev && prev.id === barcodeTarget.id ? { ...prev, sku_barcode: nuevo } : prev));
    setValue('sku_barcode', nuevo);
    closeBarcodeModal();
    refreshInventory(viewStoreId);
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (window.confirm('¿Estás seguro de que deseas eliminar este producto de TODAS las sucursales?')) {
      const { error } = await supabase
        .from('products')
        .update({ is_active: false })
        .eq('id', id);

      if (error) {
        alert('Error al eliminar el producto: ' + error.message);
        return;
      }
      if (selectedProduct?.id === id) setSelectedProduct(null);
      refreshInventory(viewStoreId);
    }
  };

  // Quita una variante de su grupo (vuelve a ser un producto suelto). No
  // borra ni desactiva nada, solo limpia el vínculo.
  const handleUnlinkVariant = async (e: React.MouseEvent, product: Product) => {
    e.stopPropagation();
    if (!window.confirm(`¿Desvincular "${product.name}" (${product.sku_barcode}) de su producto padre?`)) return;
    const { error } = await supabase
      .from('products')
      .update({ parent_group_id: null })
      .eq('id', product.id);
    if (error) { alert('No se pudo desvincular: ' + error.message); return; }
    refreshInventory(viewStoreId);
  };

  // Elimina un grupo: los hijos vuelven a ser productos sueltos (no se
  // borra ni desactiva ninguno), y el grupo queda inactivo.
  const handleDeleteGroup = async (e: React.MouseEvent, groupId: string, childIds: string[]) => {
    e.stopPropagation();
    if (!window.confirm('¿Eliminar este producto padre? Sus variantes NO se borran, solo dejan de estar agrupadas.')) return;
    const { error: unlinkError } = await supabase
      .from('products')
      .update({ parent_group_id: null })
      .in('id', childIds);
    if (unlinkError) { alert('No se pudo desagrupar las variantes: ' + unlinkError.message); return; }
    const { error: groupError } = await supabase
      .from('product_groups')
      .update({ is_active: false })
      .eq('id', groupId);
    if (groupError) { alert('Variantes desagrupadas, pero no se pudo desactivar el grupo: ' + groupError.message); }
    refreshInventory(viewStoreId);
  };

  const handleEdit = (e: React.MouseEvent, product: Product) => {
    e.stopPropagation();
    setEditingProduct(product);
    setFormError(null);
    reset({
      sku_barcode: product.sku_barcode,
      name: product.name,
      category: product.category as ProductFormValues['category'],
      price: product.price,
      stock: product.stock,
      owner_store_id: product.owner_store_id ?? currentStore?.id ?? '',
      talla: product.talla ?? '',
      color: product.color ?? '',
    });
    setIsModalOpen(true);
  };

  const closeModal = () => {
    // Los códigos autogenerados solo valen mientras el formulario está
    // abierto: al cerrarlo, la próxima alta arranca con códigos nuevos.
    autoSkuRef.current = {};
    setIsModalOpen(false);
    setEditingProduct(null);
    setFormError(null);
    setHasVariants(false);
    setVariantRows([]);
    reset({ sku_barcode: '', name: '', category: defaultCategoryForStore(currentStore?.name ?? ''), price: 0, stock: 0, owner_store_id: currentStore?.id ?? '', talla: '', color: '' });
  };

  const LOW_STOCK_THRESHOLD = 5; // ajústalo a tu realidad

const handleExportCSV = async () => {
  if (products.length === 0 || !currentStore) return;

  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet('Inventario', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  const groupsById = new Map(groups.map(g => [g.id, g] as const));

  ws.columns = [
    { header: 'SKU',                          key: 'sku',      width: 18 },
    { header: 'Nombre',                       key: 'nombre',   width: 36 },
    { header: 'Producto padre',               key: 'padre',    width: 28 },
    { header: 'Talla/Color',                  key: 'variante', width: 18 },
    { header: 'Categoría',                    key: 'categoria', width: 16 },
    { header: 'Precio',                       key: 'precio',   width: 14, style: { numFmt: '"$"#,##0.00' } },
    { header: `Stock (${effectiveStore?.name ?? currentStore.name})`, key: 'stock', width: 18 },
    { header: 'Valor inventario',             key: 'valor',    width: 18, style: { numFmt: '"$"#,##0.00' } },
  ];

  // --- Header ---
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
  headerRow.height = 22;
  headerRow.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
  });

  let totalUnidades = 0;
  let totalValor = 0;

  products.forEach(p => {
    const stock = Number(p.stock) || 0;
    const precio = Number(p.price) || 0;
    const valor = precio * stock;
    totalUnidades += stock;
    totalValor += valor;

    const row = ws.addRow({
      sku: p.sku_barcode,
      nombre: p.name,
      padre: p.parent_group_id ? (groupsById.get(p.parent_group_id)?.name ?? '') : '',
      variante: variantLabel(p.talla, p.color),
      categoria: categoryLabel(p.category),
      precio,           // número real → Excel formatea
      stock,
      valor,
    });

    // Resaltar stock bajo
    if (stock <= LOW_STOCK_THRESHOLD) {
      row.getCell('stock').fill = {
        type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' }, // red-100
      };
      row.getCell('stock').font = { color: { argb: 'FFB91C1C' }, bold: true }; // red-700
    }
  });

  // --- Totales ---
  const totalRow = ws.addRow({
    nombre: 'TOTAL',
    stock: totalUnidades,
    valor: totalValor,
  });
  totalRow.font = { bold: true };
  totalRow.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
  });

  ws.autoFilter = { from: 'A1', to: 'H1' };

  // --- Descarga ---
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `inventario_${(effectiveStore?.name ?? currentStore.name).replace(/\s+/g, '_').toLowerCase()}.xlsx`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

  // Imprimir etiqueta: además de abrir el diálogo, registra el clic en la BD
  // (products.label_printed_at). Con eso el producto deja de ser "Nuevo".
  const handlePrint = async () => {
    if (!selectedProduct) return alert('Selecciona un producto primero');

    const { id, label_printed_at } = selectedProduct;
    const firstPrint = !label_printed_at;

    if (firstPrint) {
      // Optimista: el badge "Nuevo" desaparece de inmediato.
      const printedAt = new Date().toISOString();
      setProducts(prev => prev.map(p => (p.id === id ? { ...p, label_printed_at: printedAt } : p)));
      setSelectedProduct(prev => (prev && prev.id === id ? { ...prev, label_printed_at: printedAt } : prev));
    }

    window.print();

    if (firstPrint) {
      const { error } = await supabase.rpc('mark_label_printed', { p_product_id: id });
      // Si falla (p. ej. SQL sin aplicar), el próximo refresco remuestra el badge.
      if (error) console.error('No se pudo registrar la impresión de etiqueta:', error);
    }
  };

  // Umbral de "stock bajo" de la tienda que se está viendo (juguetería: 1; resto: 2).
  const lowStockMax = lowStockMaxFor(effectiveStore?.name ?? currentStore?.name);

  // --- Resumen (sobre TODO el inventario de la tienda, ignora búsqueda/filtro) ---
  const totalProducts = products.length;
  const totalUnits = products.reduce((sum, p) => sum + (p.stock || 0), 0);
  const totalCost = products.reduce((sum, p) => sum + (p.price || 0) * (p.stock || 0), 0);
  const lowCount = products.filter(p => isLow(p.stock, lowStockMax)).length;
  const outCount = products.filter(p => isOut(p.stock)).length;

  // --- Ajuste masivo de precios: vista previa ---
  // Se calcula sobre `products` (el catálogo COMPLETO de la tienda ya paginado,
  // no la página visible de la tabla), así que el conteo y los totales que se
  // muestran son los mismos que va a tocar el RPC.
  const priceSignedPercent = (Number(pricePercent) || 0) * (priceDirection === 'down' ? -1 : 1);
  // Misma fórmula que db/bulk_price_update.sql, para que la vista previa no mienta.
  const previewPrice = (price: number) => {
    const step = priceRoundTo > 0 ? priceRoundTo : 0.01;
    return Math.max(Math.round(((price || 0) * (1 + priceSignedPercent / 100)) / step) * step, step);
  };
  // Tres productos de referencia (el más barato, uno del medio y el más caro)
  // para ver de un vistazo cómo queda el catálogo.
  const priceSamples = (() => {
    if (products.length === 0) return [] as Product[];
    const sorted = [...products].sort((a, b) => (a.price || 0) - (b.price || 0));
    const idx = [...new Set([0, Math.floor(sorted.length / 2), sorted.length - 1])];
    return idx.map(i => sorted[i]);
  })();
  const totalCostAfter = products.reduce((sum, p) => sum + previewPrice(p.price) * (p.stock || 0), 0);

  // Mensaje de error de los RPC de precios. Los RAISE del SQL viajan dentro de
  // error.message, así que se reconocen por su texto.
  const priceRpcError = (error: { code?: string; message?: string }, fallback: string) => {
    const msg = (error.message ?? '').toLowerCase();
    if (msg.includes('not_authorized')) return 'Solo el propietario puede ajustar los precios.';
    if (msg.includes('percent_out_of_range')) return 'El porcentaje está fuera del rango permitido (de -90% a +300%).';
    if (msg.includes('percent_zero')) return 'Indica un porcentaje distinto de 0.';
    if (msg.includes('already_reverted')) return 'Ese ajuste ya fue deshecho.';
    if (msg.includes('not_latest')) return 'Hay un ajuste más reciente sin deshacer: hay que deshacer ese primero.';
    if (msg.includes('adjustment_not_found')) return 'Ya no existe el registro de ese ajuste.';
    if (error.code === 'PGRST202' || msg.includes('could not find the function')) {
      return 'Falta aplicar db/bulk_price_update.sql en el SQL Editor de Supabase.';
    }
    return fallback;
  };

  // Último ajuste reversible de la tienda. Si la tabla todavía no existe
  // (SQL sin aplicar), simplemente no se ofrece deshacer.
  const fetchLastAdjustment = async (storeId: string) => {
    const { data, error } = await supabase
      .from('price_adjustments')
      .select('id, percent, round_to, products_count, created_at')
      .eq('store_id', storeId)
      .is('reverted_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    setLastAdjustment(error ? null : ((data as PriceAdjustment | null) ?? null));
  };

  const openPriceModal = () => {
    setPriceDirection('up');
    setPricePercent(10);
    setPriceRoundTo(1);
    setPriceConfirming(false);
    setPriceRevertConfirming(false);
    setPriceError(null);
    setPriceResult(null);
    setLastAdjustment(null);
    setPriceModalOpen(true);
    if (viewStoreId) fetchLastAdjustment(viewStoreId);
  };

  const applyBulkPriceUpdate = async () => {
    if (!viewStoreId || priceSignedPercent === 0) return;
    setPriceApplying(true);
    setPriceError(null);

    const { data, error } = await supabase.rpc('bulk_update_prices', {
      p_store_id: viewStoreId,
      p_percent: priceSignedPercent,
      p_round_to: priceRoundTo,
    });

    setPriceApplying(false);
    setPriceConfirming(false);

    if (error) {
      setPriceError(priceRpcError(error, 'No se pudieron ajustar los precios. Ningún precio fue modificado.'));
      return;
    }

    const res = data as { adjustment_id?: string; products?: number } | null;
    const products = Number(res?.products) || 0;
    setPriceResult({ kind: 'applied', products });
    // El ajuste recién hecho queda listo para deshacer sin recargar la página.
    if (res?.adjustment_id) {
      setLastAdjustment({
        id: res.adjustment_id,
        percent: priceSignedPercent,
        round_to: priceRoundTo,
        products_count: products,
        created_at: new Date().toISOString(),
      });
    }
    await refreshInventory(viewStoreId);
  };

  // Deshacer: devuelve a cada producto el precio EXACTO que tenía antes del
  // ajuste (el RPC guardó precio por precio; con redondeo, el porcentaje
  // inverso no alcanzaría). Respeta los precios cambiados a mano después.
  const revertLastAdjustment = async () => {
    if (!lastAdjustment || !viewStoreId) return;
    setPriceReverting(true);
    setPriceError(null);

    const { data, error } = await supabase.rpc('revert_price_adjustment', {
      p_adjustment_id: lastAdjustment.id,
    });

    setPriceReverting(false);
    setPriceRevertConfirming(false);

    if (error) {
      setPriceError(priceRpcError(error, 'No se pudo deshacer el ajuste. Ningún precio fue modificado.'));
      return;
    }

    const res = data as { restored?: number; skipped?: number } | null;
    setPriceResult({ kind: 'reverted', restored: Number(res?.restored) || 0, skipped: Number(res?.skipped) || 0 });
    setLastAdjustment(null);
    await refreshInventory(viewStoreId);
  };

  // Categorías presentes en el inventario de la tienda (opciones del botón Filtros).
  const availableCategories = [...new Set(products.map(p => p.category))]
    .filter(Boolean)
    .sort((a, b) => categoryLabel(a).localeCompare(categoryLabel(b), 'es'));

  // Pipeline de la tabla: búsqueda → categoría → filtro de semáforo → orden → paginación.
  //
  // Si la búsqueda encuentra una variante (por su propio SKU o nombre), se
  // suman también TODAS sus hermanas (aunque su SKU/nombre no coincida) para
  // que se vea el grupo completo con su padre, no solo la fila encontrada.
  const searchLower = searchTerm.toLowerCase();
  const directMatchIds = new Set(
    products
      .filter(p =>
        (p.name.toLowerCase().includes(searchLower) || p.sku_barcode.toLowerCase().includes(searchLower)) &&
        (categoryFilter === 'all' || p.category === categoryFilter)
      )
      .map(p => p.id)
  );
  const matchedGroupIds = new Set(
    products.filter(p => directMatchIds.has(p.id) && p.parent_group_id).map(p => p.parent_group_id as string)
  );
  const searched = products.filter(p =>
    directMatchIds.has(p.id) || (p.parent_group_id && matchedGroupIds.has(p.parent_group_id))
  );
  const statusFiltered = searched.filter(p => {
    if (stockFilter === 'low') return isLow(p.stock, lowStockMax);
    if (stockFilter === 'out') return isOut(p.stock);
    return true;
  });
  // Orden por Stock Local o por Talla/Color. En talla/color se compara el texto
  // visible ("Talla · Color") con colación numérica (8 < 10) y los productos
  // SIN variante ("N/A") van siempre al final, en ambas direcciones.
  const sortedProducts = sortKey === 'stock'
    ? [...statusFiltered].sort((a, b) => (sortDir === 'asc' ? a.stock - b.stock : b.stock - a.stock))
    : sortKey === 'variant'
    ? [...statusFiltered].sort((a, b) => {
        const va = variantLabel(a.talla, a.color);
        const vb = variantLabel(b.talla, b.color);
        if ((va === 'N/A') !== (vb === 'N/A')) return va === 'N/A' ? 1 : -1;
        const cmp = va.localeCompare(vb, 'es', { numeric: true, sensitivity: 'base' });
        return sortDir === 'asc' ? cmp : -cmp;
      })
    : statusFiltered;

  // Agrupa las variantes de un mismo producto padre en UNA sola fila de
  // pantalla ("N variantes"), en la posición del primer hijo encontrado en
  // el orden ya calculado arriba. Los filtros (búsqueda/categoría/semáforo)
  // siguen operando por variante: si solo algunas hermanas pasan el filtro,
  // la fila del grupo solo trae esas. Agrupar es puramente presentación.
  const groupsById = new Map(groups.map(g => [g.id, g] as const));
  type DisplayRow =
    | { type: 'standalone'; product: Product }
    | { type: 'group'; groupId: string; group: ProductGroup | null; children: Product[] };
  const displayRows: DisplayRow[] = [];
  {
    const seenGroupIds = new Set<string>();
    for (const p of sortedProducts) {
      if (p.parent_group_id) {
        if (seenGroupIds.has(p.parent_group_id)) continue;
        seenGroupIds.add(p.parent_group_id);
        const children = sortedProducts.filter(x => x.parent_group_id === p.parent_group_id);
        displayRows.push({ type: 'group', groupId: p.parent_group_id, group: groupsById.get(p.parent_group_id) ?? null, children });
      } else {
        displayRows.push({ type: 'standalone', product: p });
      }
    }
  }

  const totalPages = Math.max(1, Math.ceil(displayRows.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paginatedRows = displayRows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  // IDs de todos los productos padre visibles (con el filtro/búsqueda actual,
  // en todas las páginas) para el botón "expandir todos" del encabezado.
  const allGroupIds = displayRows.filter((r): r is Extract<DisplayRow, { type: 'group' }> => r.type === 'group').map(r => r.groupId);
  const allGroupsExpanded = allGroupIds.length > 0 && allGroupIds.every(id => expandedGroups.has(id));
  const toggleAllGroupsExpanded = () =>
    setExpandedGroups(allGroupsExpanded ? new Set() : new Set(allGroupIds));

  // --- Render de una fila de PRODUCTO (standalone o variante hija) --------
  const renderDesktopRow = (product: Product, opts?: { indent?: boolean }) => {
    const tier = stockTier(product.stock, lowStockMax);
    return (
      <tr
        key={product.id}
        onClick={() => setSelectedProduct(product)}
        className={`border-b transition cursor-pointer ${opts?.indent ? 'border-slate-200 bg-slate-100' : 'border-slate-100'} ${selectedProduct?.id === product.id ? 'bg-teal-50' : opts?.indent ? 'hover:bg-slate-200/70' : 'hover:bg-slate-50'}`}
      >
        <td className={`p-3 text-slate-500 font-mono text-sm ${opts?.indent ? 'pl-8' : ''}`}>{product.sku_barcode}</td>
        <td className="p-3 font-medium text-slate-800">
          {/* La variante no repite el nombre del padre (ya se ve en la fila del grupo): solo el badge "Nuevo" si aplica. */}
          {!opts?.indent && (
            <span className="inline-flex items-center gap-2">
              {product.name}
              {isNewProduct(product) && (
                <span
                  title={product.created_at ? `Agregado: ${new Date(product.created_at).toLocaleString('es-VE')}` : undefined}
                  className="shrink-0 text-[10px] font-bold text-teal-700 bg-teal-50 border border-teal-200 px-2 py-0.5 rounded-full"
                >
                  Nuevo
                </span>
              )}
            </span>
          )}
        </td>
        <td className="p-3 text-sm text-slate-600">{variantLabel(product.talla, product.color)}</td>
        <td className="p-3">
          <span className="bg-blue-50 text-blue-700 px-2 py-1 rounded-full text-xs capitalize">{categoryLabel(product.category)}</span>
        </td>
        <td className="p-3 text-right font-medium text-slate-600">${product.price.toFixed(2)}</td>
        <td className="p-3">
          <div className="flex justify-end">
            <span className={`inline-flex items-center justify-center min-w-[2.5rem] px-2.5 py-1 rounded-lg font-bold text-sm ${TIER_BADGE[tier]}`}>
              {product.stock}
            </span>
          </div>
        </td>
        <td className="p-3 text-center">
          {canEditRow ? (
            <>
              <button
                onClick={(e) => handleEdit(e, product)}
                className="text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded transition p-1.5 cursor-pointer"
                title={isRestocker ? 'Reponer stock' : 'Editar'}
              >
                {isRestocker ? '📦' : '✏️'}
              </button>
              {canDelete && (
                <button
                  onClick={(e) => handleDelete(e, product.id)}
                  className="text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition p-1.5 ml-2 cursor-pointer"
                  title="Desactivar Globalmente"
                >
                  🗑️
                </button>
              )}
              {canDelete && !isRestocker && !product.parent_group_id && (
                <button
                  onClick={(e) => { e.stopPropagation(); openLinkModal(product); }}
                  className="text-slate-400 hover:text-purple-600 hover:bg-purple-50 rounded transition p-1.5 ml-2 cursor-pointer"
                  title="Vincular a producto padre"
                >
                  🔗
                </button>
              )}
              {canDelete && !isRestocker && product.parent_group_id && (
                <button
                  onClick={(e) => handleUnlinkVariant(e, product)}
                  className="text-slate-400 hover:text-amber-600 hover:bg-amber-50 rounded transition p-1.5 ml-2 cursor-pointer"
                  title="Desvincular del grupo"
                >
                  ⛓️‍💥
                </button>
              )}
            </>
          ) : (
            <span className="text-slate-300">—</span>
          )}
        </td>
      </tr>
    );
  };

  // Fila de GRUPO (colapsada) + banner + filas hijas cuando está expandida.
  const renderDesktopGroup = (row: Extract<DisplayRow, { type: 'group' }>) => {
    const { groupId, group, children } = row;
    const isExpanded = expandedGroups.has(groupId);
    const totalStock = children.reduce((s, c) => s + c.stock, 0);
    const prices = [...new Set(children.map(c => c.price))];
    const priceLabel = prices.length === 1 ? `$${prices[0].toFixed(2)}` : `desde $${Math.min(...prices).toFixed(2)}`;
    const tier = stockTier(totalStock, lowStockMax);
    const rows: React.ReactElement[] = [
      <tr
        key={`group-${groupId}`}
        onClick={() => toggleGroupExpanded(groupId)}
        className={`border-b transition cursor-pointer ${isExpanded ? 'border-slate-200 bg-slate-100 hover:bg-slate-200/70' : 'border-slate-100 bg-slate-50/70 hover:bg-slate-100'}`}
      >
        <td className="p-3 text-slate-500">
          {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </td>
        <td className="p-3 font-semibold text-slate-800">{group?.name ?? children[0]?.name}</td>
        <td className="p-3">
          <span className="inline-flex items-center gap-1 bg-blue-50 text-blue-700 px-2 py-1 rounded-full text-xs font-semibold">
            {children.length} {children.length === 1 ? 'variante' : 'variantes'}
          </span>
        </td>
        <td className="p-3">
          <span className="bg-blue-50 text-blue-700 px-2 py-1 rounded-full text-xs capitalize">{categoryLabel(group?.category ?? children[0]?.category ?? '')}</span>
        </td>
        <td className="p-3 text-right font-medium text-slate-600">{priceLabel}</td>
        <td className="p-3">
          <div className="flex justify-end">
            <span className={`inline-flex items-center justify-center min-w-[2.5rem] px-2.5 py-1 rounded-lg font-bold text-sm ${TIER_BADGE[tier]}`}>
              {totalStock}
            </span>
          </div>
        </td>
        <td className="p-3 text-center">
          {canDelete && !isRestocker ? (
            <>
              {group && (
                <button
                  onClick={(e) => { e.stopPropagation(); openEditGroupModal(group); }}
                  className="text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded transition p-1.5 cursor-pointer"
                  title="Editar nombre del producto padre"
                >
                  ✏️
                </button>
              )}
              <button
                onClick={(e) => handleDeleteGroup(e, groupId, children.map(c => c.id))}
                className="text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition p-1.5 ml-2 cursor-pointer"
                title="Eliminar producto padre (las variantes no se borran)"
              >
                🗑️
              </button>
            </>
          ) : (
            <span className="text-slate-300">—</span>
          )}
        </td>
      </tr>,
    ];
    if (isExpanded) {
      rows.push(
        <tr key={`group-${groupId}-info`} className="bg-slate-100">
          <td colSpan={7} className="px-6 py-2 text-xs text-slate-600 border-b border-slate-200">
            ℹ️ Se conservan los códigos ya impresos: cada variante mantiene su propio SKU de siempre.
          </td>
        </tr>
      );
      children.forEach(child => rows.push(renderDesktopRow(child, { indent: true })));
      if (group && canAdd) {
        rows.push(
          <tr key={`group-${groupId}-add`} className="bg-slate-100 border-b border-slate-200">
            <td colSpan={7} className="px-6 py-2">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); openAddVariantModal(group); }}
                className="text-sm font-semibold text-emerald-700 hover:text-emerald-800 cursor-pointer"
              >
                + Agregar variante a este producto padre
              </button>
            </td>
          </tr>
        );
      }
    }
    return rows;
  };

  const renderMobileCard = (product: Product, opts?: { indent?: boolean }) => {
    const tier = stockTier(product.stock, lowStockMax);
    const variant = variantLabel(product.talla, product.color);
    const selected = selectedProduct?.id === product.id;
    return (
      <div
        key={product.id}
        onClick={() => setSelectedProduct(product)}
        className={`border rounded-xl p-3 shadow-sm flex flex-col gap-2 cursor-pointer transition ${selected ? 'border-teal-400 ring-2 ring-teal-100 bg-teal-50' : opts?.indent ? 'border-slate-200 bg-slate-100' : 'border-slate-200 bg-white'} ${opts?.indent ? 'ml-3' : ''}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {/* La variante no repite el nombre del padre (ya se ve en la tarjeta del grupo): solo el badge "Nuevo" si aplica. */}
            {!opts?.indent && (
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-bold text-slate-800 text-sm leading-snug">{product.name}</h3>
                {isNewProduct(product) && (
                  <span className="shrink-0 text-[10px] font-bold text-teal-700 bg-teal-50 border border-teal-200 px-2 py-0.5 rounded-full">
                    Nuevo
                  </span>
                )}
              </div>
            )}
            <p className="text-[11px] font-mono text-slate-500 mt-0.5">{product.sku_barcode}</p>
          </div>
          <div className="shrink-0 text-center">
            <span className={`inline-flex items-center justify-center min-w-[2.5rem] px-2.5 py-1 rounded-lg font-bold text-sm ${TIER_BADGE[tier]}`}>
              {product.stock}
            </span>
            <span className="block text-[9px] uppercase tracking-wide text-slate-400 mt-0.5">Stock</span>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-100">
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            <span className="bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full text-[10px] capitalize">{categoryLabel(product.category)}</span>
            {variant !== 'N/A' && <span className="text-[11px] text-slate-500 truncate">{variant}</span>}
            <span className="text-sm font-bold text-slate-700">${product.price.toFixed(2)}</span>
          </div>
          <div className="shrink-0 flex items-center">
            {canEditRow ? (
              <>
                <button
                  onClick={(e) => handleEdit(e, product)}
                  className="text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded transition p-2 cursor-pointer"
                  title={isRestocker ? 'Reponer stock' : 'Editar'}
                >
                  {isRestocker ? '📦' : '✏️'}
                </button>
                {canDelete && (
                  <button
                    onClick={(e) => handleDelete(e, product.id)}
                    className="text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition p-2 ml-1 cursor-pointer"
                    title="Desactivar Globalmente"
                  >
                    🗑️
                  </button>
                )}
                {canDelete && !isRestocker && !product.parent_group_id && (
                  <button
                    onClick={(e) => { e.stopPropagation(); openLinkModal(product); }}
                    className="text-slate-400 hover:text-purple-600 hover:bg-purple-50 rounded transition p-2 ml-1 cursor-pointer"
                    title="Vincular a producto padre"
                  >
                    🔗
                  </button>
                )}
                {canDelete && !isRestocker && product.parent_group_id && (
                  <button
                    onClick={(e) => handleUnlinkVariant(e, product)}
                    className="text-slate-400 hover:text-amber-600 hover:bg-amber-50 rounded transition p-2 ml-1 cursor-pointer"
                    title="Desvincular del grupo"
                  >
                    ⛓️‍💥
                  </button>
                )}
              </>
            ) : (
              <span className="text-slate-300 text-sm">—</span>
            )}
          </div>
        </div>
      </div>
    );
  };

  const renderMobileGroup = (row: Extract<DisplayRow, { type: 'group' }>) => {
    const { groupId, group, children } = row;
    const isExpanded = expandedGroups.has(groupId);
    const totalStock = children.reduce((s, c) => s + c.stock, 0);
    const prices = [...new Set(children.map(c => c.price))];
    const priceLabel = prices.length === 1 ? `$${prices[0].toFixed(2)}` : `desde $${Math.min(...prices).toFixed(2)}`;
    const tier = stockTier(totalStock, lowStockMax);
    return (
      <div key={`group-${groupId}`} className="space-y-2">
        <div
          onClick={() => toggleGroupExpanded(groupId)}
          className={`border rounded-xl p-3 shadow-sm flex flex-col gap-2 cursor-pointer transition ${isExpanded ? 'bg-slate-100 border-slate-300' : 'bg-white border-slate-200'}`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="font-bold text-slate-800 text-sm leading-snug flex items-center gap-1">
                {isExpanded ? <ChevronDown className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />}
                {group?.name ?? children[0]?.name}
              </h3>
            </div>
            <div className="shrink-0 text-center">
              <span className={`inline-flex items-center justify-center min-w-[2.5rem] px-2.5 py-1 rounded-lg font-bold text-sm ${TIER_BADGE[tier]}`}>
                {totalStock}
              </span>
              <span className="block text-[9px] uppercase tracking-wide text-slate-400 mt-0.5">Stock</span>
            </div>
          </div>
          <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-100">
            <div className="flex items-center gap-2 flex-wrap min-w-0">
              <span className="bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full text-[10px] capitalize">{categoryLabel(group?.category ?? children[0]?.category ?? '')}</span>
              <span className="bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full text-[10px] font-semibold">{children.length} {children.length === 1 ? 'variante' : 'variantes'}</span>
              <span className="text-sm font-bold text-slate-700">{priceLabel}</span>
            </div>
            {canDelete && !isRestocker && (
              <div className="flex items-center">
                {group && (
                  <button
                    onClick={(e) => { e.stopPropagation(); openEditGroupModal(group); }}
                    className="text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded transition p-2 cursor-pointer"
                    title="Editar nombre del producto padre"
                  >
                    ✏️
                  </button>
                )}
                <button
                  onClick={(e) => handleDeleteGroup(e, groupId, children.map(c => c.id))}
                  className="text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition p-2 cursor-pointer"
                  title="Eliminar producto padre"
                >
                  🗑️
                </button>
              </div>
            )}
          </div>
        </div>
        {isExpanded && (
          <div className="pl-2 space-y-2">
            <p className="text-[11px] text-slate-600 bg-slate-100 border border-slate-200 rounded-lg px-3 py-1.5">
              ℹ️ Cada variante mantiene su propio SKU ya impreso.
            </p>
            {children.map(child => renderMobileCard(child, { indent: true }))}
            {group && canAdd && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); openAddVariantModal(group); }}
                className="text-sm font-semibold text-emerald-700 hover:text-emerald-800 cursor-pointer px-1"
              >
                + Agregar variante a este producto padre
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };
  // Indicador de orden: ↕ tenue en toda columna ordenable (señala que es clickeable),
  // y ▲/▼ sólido en la columna activa según la dirección.
  const sortIcon = (key: SortKey) => {
    const active = sortKey === key;
    return (
      <span className={`text-[10px] ${active ? 'opacity-100' : 'opacity-40'}`}>
        {active ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}
      </span>
    );
  };
  const toggleStockFilter = (f: 'low' | 'out') => setStockFilter(prev => (prev === f ? 'all' : f));

  // Título/subtítulo del panel de la tabla según el filtro activo.
  const panelTitle = stockFilter === 'low' ? 'Productos con stock bajo'
    : stockFilter === 'out' ? 'Productos agotados'
    : 'Productos';
  const panelSubtitle = stockFilter === 'low'
    ? `${lowCount} ${lowCount === 1 ? 'producto necesita' : 'productos necesitan'} reposición`
    : stockFilter === 'out'
    ? `${outCount} ${outCount === 1 ? 'producto sin stock' : 'productos sin stock'}`
    : `${totalProducts} ${totalProducts === 1 ? 'producto' : 'productos'} en inventario`;
  const filterChipLabel = stockFilter === 'low' ? `Stock: ${lowStockMax} o menos` : 'Agotados';

  const originalPrice = selectedProduct?.price || 0;
  const finalPrice = originalPrice - (originalPrice * (discountPercent / 100));

  // Etiqueta sin precio: misma regla que /labels, decidida por la TIENDA DUEÑA
  // del producto y no por la que se está viendo. Solo la Tienda de Ropa; en la
  // juguetería el precio se sigue imprimiendo. El cajero puede forzar "con
  // precio" para un caso suelto (una feria, una liquidación puntual).
  const productStoreName = stores.find(st => st.id === selectedProduct?.owner_store_id)?.name;
  const labelWithoutPrice = labelPriceMode === 'auto'
    ? isClothingStore(productStoreName)
    : labelPriceMode === 'sin_precio';

  // Lo que hace el código leído con la cámara depende de qué botón la abrió.
  const handleCameraScan = (code: string) => {
    const target = cameraTarget;
    if (!target) return;
    if (target.kind === 'search') setSearchTerm(code);
    else if (target.kind === 'form') setValue('sku_barcode', code, { shouldDirty: true });
    else if (target.kind === 'variant')
      setVariantRows(rows => rows.map(r => (r.key === target.key ? { ...r, sku_barcode: code } : r)));
    else if (target.kind === 'addVariant') setAddVariantSku(code);
    else if (target.kind === 'barcode') setBarcodeValue(code);
  };

  if (!currentStore) {
    return <div className="h-full flex items-center justify-center text-slate-500">Cargando contexto de la sucursal...</div>;
  }

  return (
    <>
      {/* En móvil/tablet (< lg) el contenido fluye y scrollea el <main>; en PC
          ocupa el alto completo con scroll interno de la tabla (sin cambios). */}
      <div className="print:hidden flex flex-col gap-4 md:gap-6 lg:h-full font-sans">

        {/* Encabezado: título, tienda y acciones */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div className="flex flex-col">
            <h1 className="text-2xl font-bold text-slate-800">Inventario</h1>
            {isCashier ? (
              /* Filtro de VISTA (solo cajeros). Cambia qué inventario se ve;
                 no cambia la tienda asignada del cajero. */
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <span className="text-slate-500 text-sm">Ver inventario de:</span>
                <select
                  value={viewStoreId || currentStore.id}
                  onChange={(e) => setViewStoreId(e.target.value)}
                  className="text-sm font-semibold text-teal-700 bg-teal-50 border border-teal-200 rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-teal-600 cursor-pointer"
                >
                  {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                {readOnly && (
                  <span className="text-[11px] font-bold uppercase tracking-wider text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded">
                    Solo lectura
                  </span>
                )}
                {isGlobalRestocker && (
                  <span className="text-[11px] font-bold uppercase tracking-wider text-teal-700 bg-teal-50 border border-teal-200 px-2 py-0.5 rounded">
                    Reponedor
                  </span>
                )}
                {isLocalRestocker && (
                  <span className="text-[11px] font-bold uppercase tracking-wider text-teal-700 bg-teal-50 border border-teal-200 px-2 py-0.5 rounded">
                    Reponedor · su tienda
                  </span>
                )}
              </div>
            ) : (
              <p className="text-slate-500 text-sm">Mostrando stock para: <strong className="text-teal-700">{currentStore.name}</strong></p>
            )}
          </div>

          <div className="flex gap-2 w-full md:w-auto">
            {/* Exportar Excel: solo el owner. */}
            {isOwner && (
              <button onClick={handleExportCSV} className="flex-1 md:flex-none px-4 py-2 text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200 transition cursor-pointer font-medium">
                Exportar Excel
              </button>
            )}

            {/* Ajuste masivo de precios: mismo permiso que borrar (owner en su
                propia tienda), porque toca el catálogo entero de una vez. */}
            {canDelete && (
              <button onClick={openPriceModal} className="flex-1 md:flex-none px-4 py-2 text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200 transition cursor-pointer font-medium whitespace-nowrap">
                Ajustar precios %
              </button>
            )}

            {/* Añadir: owner y cajero normal, solo en su propia tienda (no en vista de otra). */}
            {canAdd && (
              <button onClick={handleOpenAddModal} className="flex-1 md:flex-none px-4 py-2 text-white bg-[#0f5c5c] rounded-lg hover:bg-[#0a4545] transition whitespace-nowrap shadow-sm cursor-pointer font-medium">
                + Añadir Producto
              </button>
            )}
          </div>
        </div>

        {/* Tarjetas de resumen + filtros clickeables */}
        <div className={`grid gap-3 md:gap-4 grid-cols-2 sm:grid-cols-3 ${isOwner ? 'lg:grid-cols-5' : 'lg:grid-cols-4'}`}>
          <StatCard icon="🛍️" label="Productos" value={loading ? '—' : totalProducts} />
          <StatCard icon="📦" label="Unidades en stock" value={loading ? '—' : totalUnits} />
          {/* Costo del inventario: solo visible para el owner. */}
          {isOwner && (
            <StatCard
              icon="💰"
              label="Costo del inventario"
              value={loading ? '—' : `$${totalCost.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              sub={<span className="inline-flex items-center gap-1 mt-1 text-[10px] font-semibold text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded">🔒 Solo propietario</span>}
            />
          )}
          {/* Stock bajo: con existencias pero <= umbral de la tienda (juguetería 1, resto 2). */}
          <StatCard
            icon="⚠️"
            label="Stock bajo"
            value={loading ? '—' : lowCount}
            tone="amber"
            active={stockFilter === 'low'}
            onClick={() => toggleStockFilter('low')}
          />
          {/* Agotados: sin stock o negativo. Filtro clickeable. */}
          <StatCard
            icon="🚫"
            label="Agotados"
            value={loading ? '—' : outCount}
            tone="red"
            active={stockFilter === 'out'}
            onClick={() => toggleStockFilter('out')}
          />
        </div>

        {/* Contenido: tabla + descuento rápido (lado a lado solo en PC) */}
        <div className="flex flex-col lg:flex-row gap-4 lg:gap-6 lg:flex-1 lg:min-h-0">

          {/* Tabla de Productos */}
          <div className="flex-1 bg-white rounded-xl shadow-sm border border-slate-200 flex flex-col overflow-hidden">

            {/* Barra: título del panel + búsqueda (izquierda) + chip de filtro (derecha) */}
            <div className="p-4 md:p-6 md:pb-4 flex flex-col lg:flex-row lg:items-center gap-3 md:gap-4 border-b border-slate-100">
              <div className="min-w-0">
                <h2 className="text-base md:text-lg font-bold text-slate-800">{panelTitle}</h2>
                <p className="text-xs md:text-sm text-slate-500">{panelSubtitle}</p>
              </div>
              <div className="relative w-full lg:w-72 flex gap-2">
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="🔍 Buscar código o nombre..."
                  className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-600 transition"
                />
                <ScanButton onClick={() => setCameraTarget({ kind: 'search' })} />
              </div>

              {/* Botón Filtros: muestra/oculta los chips de categoría EN LÍNEA
                  (la categoría activa va en negro; clic de nuevo la limpia). */}
              <div className="flex flex-wrap items-center gap-2 w-full lg:w-auto">
                <button
                  onClick={() => setFiltersOpen(o => !o)}
                  className={`inline-flex items-center gap-2 text-sm font-semibold border rounded-lg px-4 py-2 transition cursor-pointer ${
                    filtersOpen || categoryFilter !== 'all'
                      ? 'text-teal-700 bg-teal-50 border-teal-400'
                      : 'text-slate-600 bg-white border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  <SlidersHorizontal className="w-4 h-4" />
                  Filtros
                  {/* Con los chips ocultos, el botón recuerda el filtro activo. */}
                  {!filtersOpen && categoryFilter !== 'all' && (
                    <span className="max-w-[10rem] truncate text-xs font-bold bg-teal-600 text-white px-2 py-0.5 rounded-full">
                      {categoryLabel(categoryFilter)}
                    </span>
                  )}
                </button>

                {filtersOpen && availableCategories.map(c => (
                  <button
                    key={c}
                    onClick={() => setCategoryFilter(prev => (prev === c ? 'all' : c))}
                    className={`text-sm font-semibold rounded-lg px-4 py-2 border transition cursor-pointer animate-in fade-in ${
                      categoryFilter === c
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    {categoryLabel(c)}
                  </button>
                ))}
              </div>
              {/* En móvil/tablet no hay encabezados de tabla: el orden va aquí. */}
              <div className="lg:hidden flex gap-2">
                <button
                  onClick={() => toggleSort('stock')}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 text-xs font-semibold text-slate-600 bg-white border border-slate-300 rounded-lg px-3 py-2 hover:bg-slate-50 transition cursor-pointer"
                >
                  Ordenar por stock {sortIcon('stock')}
                </button>
                <button
                  onClick={() => toggleSort('variant')}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 text-xs font-semibold text-slate-600 bg-white border border-slate-300 rounded-lg px-3 py-2 hover:bg-slate-50 transition cursor-pointer"
                >
                  Ordenar por talla/color {sortIcon('variant')}
                </button>
              </div>
              {stockFilter !== 'all' && (
                <div className="flex items-center gap-2 shrink-0 lg:ml-auto">
                  <span className={`inline-flex items-center gap-2 text-sm font-medium px-3 py-1.5 rounded-lg border ${stockFilter === 'out' ? 'text-red-700 bg-red-50 border-red-200' : 'text-amber-700 bg-amber-50 border-amber-200'}`}>
                    {filterChipLabel}
                    <button onClick={() => setStockFilter('all')} className="hover:opacity-70 cursor-pointer" title="Quitar filtro">✕</button>
                  </span>
                  <button onClick={() => setStockFilter('all')} className="text-sm font-medium text-slate-600 bg-white border border-slate-300 rounded-lg px-3 py-1.5 hover:bg-slate-50 transition cursor-pointer whitespace-nowrap">
                    Quitar filtro
                  </button>
                </div>
              )}
            </div>

            {/* MÓVIL/TABLET: lista de tarjetas (la tabla de 7 columnas no cabe). */}
            <div className="lg:hidden p-3 space-y-3 bg-slate-50/50">
              {loading ? (
                <p className="p-6 text-center text-sm text-slate-500">Sincronizando inventario con {effectiveStore?.name ?? currentStore.name}...</p>
              ) : displayRows.length === 0 ? (
                <p className="p-6 text-center text-sm text-slate-500">{searchTerm || stockFilter !== 'all' || categoryFilter !== 'all' ? 'No hay productos que coincidan con el filtro.' : 'No hay productos en esta tienda.'}</p>
              ) : (
                paginatedRows.map((row) => row.type === 'standalone' ? renderMobileCard(row.product) : renderMobileGroup(row))
              )}
            </div>

            {/* PC: tabla completa */}
            <div className="hidden lg:block flex-1 overflow-auto px-6">
              <table className="w-full text-left border-collapse min-w-[600px]">
                <thead className="sticky top-0 z-10">
                  <tr className="bg-slate-700 text-white text-sm">
                    <th className="p-3 rounded-tl-lg">
                      <div className="flex items-center gap-1.5">
                        <span>Código</span>
                        {allGroupIds.length > 0 && (
                          <button
                            type="button"
                            onClick={toggleAllGroupsExpanded}
                            className="text-slate-300 hover:text-white transition cursor-pointer"
                            title={allGroupsExpanded ? 'Colapsar todos los productos padre' : 'Expandir todos los productos padre'}
                          >
                            {allGroupsExpanded ? <ChevronsUp className="w-4 h-4" /> : <ChevronsDown className="w-4 h-4" />}
                          </button>
                        )}
                      </div>
                    </th>
                    <th className="p-3">Nombre</th>
                    <th className="p-3 cursor-pointer select-none hover:bg-slate-600 transition" onClick={() => toggleSort('variant')}>
                      <span className="inline-flex items-center gap-1">Talla/Color {sortIcon('variant')}</span>
                    </th>
                    <th className="p-3">Categoría</th>
                    <th className="p-3 text-right">Precio</th>
                    <th className="p-3 text-right cursor-pointer select-none hover:bg-slate-600 transition" onClick={() => toggleSort('stock')}>
                      <span className="inline-flex items-center gap-1 justify-end">Stock Local {sortIcon('stock')}</span>
                    </th>
                    <th className="p-3 text-center rounded-tr-lg">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={7} className="p-8 text-center text-slate-500">Sincronizando inventario con {effectiveStore?.name ?? currentStore.name}...</td></tr>
                  ) : displayRows.length === 0 ? (
                    <tr><td colSpan={7} className="p-8 text-center text-slate-500">{searchTerm || stockFilter !== 'all' || categoryFilter !== 'all' ? 'No hay productos que coincidan con el filtro.' : 'No hay productos en esta tienda.'}</td></tr>
                  ) : (
                    paginatedRows.flatMap((row) => row.type === 'standalone' ? [renderDesktopRow(row.product)] : renderDesktopGroup(row))
                  )}
                </tbody>
              </table>
            </div>

            {/* Pie: conteo + paginación (los controles aparecen con más de 50 filas) */}
            {!loading && displayRows.length > 0 && (
              <div className="px-4 md:px-6 py-3 border-t border-slate-100 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs md:text-sm text-slate-500">
                <span>Mostrando {paginatedRows.length} de {displayRows.length} productos</span>
                {totalPages > 1 && (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setPage(currentPage - 1)}
                      disabled={currentPage === 1}
                      className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                    >
                      ‹ Anterior
                    </button>
                    <span className="font-medium text-slate-600">Página {currentPage} de {totalPages}</span>
                    <button
                      onClick={() => setPage(currentPage + 1)}
                      disabled={currentPage === totalPages}
                      className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                    >
                      Siguiente ›
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Panel Descuento Rápido */}
          <div className="w-full lg:w-80 shrink-0 bg-white rounded-xl shadow-sm border border-slate-200 p-4 md:p-6">
            <div className="flex items-center gap-2 mb-4 md:mb-6">
              <span className="bg-blue-100 p-2 rounded-full">🏷️</span>
              <h3 className="font-bold text-slate-800">Descuento Rápido</h3>
            </div>

            {!selectedProduct ? (
              <div className="text-center text-slate-500 text-sm py-8 border-2 border-dashed border-slate-200 rounded-lg">
                Selecciona un producto de la lista para generar su etiqueta.
              </div>
            ) : (
              <div className="space-y-4 animate-in fade-in">
                <div className="mb-4">
                  <p className="text-base font-bold text-slate-800 leading-tight">{selectedProduct.name}</p>
                  {formatVariant(selectedProduct.talla, selectedProduct.color) && (
                    <p className="text-sm text-slate-500">{formatVariant(selectedProduct.talla, selectedProduct.color)}</p>
                  )}
                  <p className="text-sm text-slate-500 font-mono">{selectedProduct.sku_barcode}</p>
                  <p className="text-[11px] uppercase font-bold text-teal-600 mt-1 bg-teal-50 inline-block px-2 py-0.5 rounded">Stock Actual: {selectedProduct.stock}</p>
                </div>
                {/* Con precio / Sin precio. La propuesta quita el precio de la
                    etiqueta SOLO en la tienda de ropa: así un cambio de precio
                    no obliga a reimprimir. La juguetería lo mantiene. */}
                <div>
                  <label className="text-sm font-semibold text-slate-500">Formato</label>
                  <div className="bg-slate-100 p-1 rounded-lg flex mt-1">
                    {(['auto', 'sin_precio', 'con_precio'] as const).map(mode => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setLabelPriceMode(mode)}
                        className={`flex-1 px-2 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${
                          labelPriceMode === mode ? 'bg-white shadow-sm text-teal-800' : 'text-slate-500 hover:text-slate-700'
                        }`}
                      >
                        {mode === 'auto' ? 'Automático' : mode === 'sin_precio' ? 'Sin precio' : 'Con precio'}
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-slate-400 mt-1">
                    {labelPriceMode === 'auto'
                      ? `Automático: ${isClothingStore(productStoreName) ? 'sin precio (Tienda de Ropa)' : 'con precio'}.`
                      : labelPriceMode === 'sin_precio'
                      ? 'Forzado sin precio, aunque el producto no sea de ropa.'
                      : 'Forzado con precio (ferias, ventas fuera de la tienda).'}
                  </p>
                </div>

                <div>
                  <label className="text-sm font-semibold text-slate-500">Nombre de Promoción</label>
                  <input
                    type="text"
                    value={promoName}
                    onChange={(e) => setPromoName(e.target.value)}
                    className="w-full p-2 border border-slate-300 bg-white text-slate-800 rounded-md mt-1 focus:outline-none focus:ring-2 focus:ring-teal-600 transition"
                  />
                </div>
                <div className="flex gap-4">
                  <div className="flex-1">
                    <label className="text-sm font-semibold text-slate-500 whitespace-nowrap">Precio Original</label>
                    <input
                      type="text"
                      disabled
                      value={`$ ${originalPrice.toFixed(2)}`}
                      className="w-full p-2 border border-slate-200 bg-slate-50 text-slate-500 rounded-md mt-1"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="text-sm font-semibold text-slate-500 whitespace-nowrap">% Descuento</label>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={discountPercent}
                      onChange={(e) => setDiscountPercent(Number(e.target.value))}
                      className="w-full p-2 border border-slate-300 bg-white text-slate-800 rounded-md mt-1 focus:outline-none focus:ring-2 focus:ring-teal-600 transition"
                    />
                  </div>
                </div>
                <p className="text-xs text-slate-400 -mt-2">
                  {labelWithoutPrice
                    ? 'Esta etiqueta va sin precio: el descuento no se imprime. Las ofertas se cargan en /ofertas y el teléfono las muestra.'
                    : 'El descuento es opcional. Con 0% se imprime el precio normal.'}
                </p>
                {/* Mismo aviso que en /labels: este % solo se dibuja en el
                    papel, no toca products.price. La caja sigue cobrando el
                    precio completo. */}
                {discountPercent > 0 && !labelWithoutPrice && (
                  <div className="bg-red-50 border border-red-300 text-red-800 text-[11px] rounded-lg px-3 py-2.5 leading-relaxed">
                    <p className="font-bold mb-1">⚠️ Este descuento solo se imprime en el papel</p>
                    <p>
                      <strong>No cambia el precio del producto.</strong> La caja va a seguir cobrando
                      ${originalPrice.toFixed(2)}, aunque la etiqueta diga ${finalPrice.toFixed(2)}.
                    </p>
                    <p className="mt-1">
                      Para que la caja cobre el descuento sola, el dueño tiene que cargarlo como{' '}
                      <strong>oferta</strong> en el módulo <strong>Ofertas</strong>.
                    </p>
                  </div>
                )}

                <div className="bg-blue-50 p-4 rounded-lg mt-4 flex justify-between items-center border border-blue-100">
                  <span className="text-sm font-medium text-blue-900">Precio Final</span>
                  <span className="text-2xl font-bold text-[#0f5c5c]">${finalPrice.toFixed(2)}</span>
                </div>
                <button
                  onClick={handlePrint}
                  className="w-full mt-6 bg-[#0f5c5c] text-white py-3 rounded-lg font-medium hover:bg-[#0a4545] transition flex justify-center items-center gap-2 cursor-pointer"
                >
                  🖨️ Imprimir Etiqueta
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* MODAL: AÑADIR / EDITAR PRODUCTO */}
      <div className="print:hidden">
        <Modal
          isOpen={isModalOpen}
          onClose={closeModal}
          title={editStockOnly ? "Reponer Stock" : (editingProduct ? "Editar Producto" : "Registrar Nuevo Producto")}
        >
          <form onSubmit={handleSubmit(onSubmitProduct)} className="space-y-4">

            <div className="bg-teal-50 text-teal-800 text-xs font-semibold px-3 py-2 rounded-lg border border-teal-200 mb-4">
              {editingProduct
                ? <>{editStockOnly ? 'Reponiendo' : 'Gestionando'} stock en: {effectiveStore?.name ?? currentStore.name}</>
                : <>El producto pertenecerá a: {formStore?.name ?? currentStore.name}</>}
              {editingProduct && isCashier && (
                <span className="block font-normal text-teal-700/80 mt-0.5">Como cajero solo puedes aumentar el stock, no reducirlo.</span>
              )}
            </div>

            {formError && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm font-medium animate-in fade-in">
                {formError}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                {editingProduct ? 'Código de Barras' : 'Código de Barras (Escanea o deja vacío)'}
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  autoFocus={!editingProduct}
                  readOnly={!!editingProduct}
                  {...register('sku_barcode')}
                  placeholder="Escanea el código aquí..."
                  className="w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none read-only:bg-slate-100 read-only:text-slate-500 read-only:cursor-not-allowed"
                />
                {!editingProduct && <ScanButton onClick={() => setCameraTarget({ kind: 'form' })} />}
              </div>
              {editingProduct && (
                <div className="mt-2">
                  {canAdd ? (
                    <button
                      type="button"
                      onClick={() => openBarcodeModal(editingProduct)}
                      className="text-sm font-semibold text-teal-700 hover:text-teal-900 underline cursor-pointer"
                    >
                      Cambiar código
                    </button>
                  ) : (
                    <p className="text-xs text-slate-400">
                      No tienes permiso para cambiar el código de este producto.
                    </p>
                  )}
                </div>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Nombre del Producto (Global)</label>
              <input type="text" readOnly={editStockOnly} {...register('name')} placeholder="Ej: Muñeca Articulada Básica" className="w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none read-only:bg-slate-100 read-only:text-slate-400 read-only:cursor-not-allowed" />
              {errors.name && <p className="text-red-500 text-xs mt-1">{errors.name.message}</p>}
            </div>

            {/* Tienda dueña (solo al registrar): define en qué inventario aparece. */}
            {!editingProduct && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Tienda a la que pertenece</label>
                {/* El reponedor LOCAL solo puede crear productos en su tienda asignada:
                    se bloquea con una única opción (sin `disabled`, para no perder el valor en RHF). */}
                {/* Si al cambiar de tienda la categoría elegida deja de estar disponible
                    (p. ej. Útiles Escolares fuera de Juguetes), vuelve a la default de esa tienda. */}
                <select
                  {...register('owner_store_id', {
                    onChange: (e) => {
                      const st = stores.find(s => s.id === e.target.value);
                      if (!categoriesForStore(st?.name).includes(getValues('category'))) {
                        setValue('category', defaultCategoryForStore(st?.name ?? ''), { shouldValidate: true, shouldDirty: true });
                      }
                    },
                  })}
                  className={`w-full p-2.5 border border-slate-300 rounded-lg text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none ${isLocalRestocker ? 'bg-slate-100 text-slate-500 pointer-events-none' : 'bg-white'}`}
                >
                  {(isLocalRestocker ? stores.filter(s => s.id === currentStore.id) : stores).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                {errors.owner_store_id && <p className="text-red-500 text-xs mt-1">{errors.owner_store_id.message}</p>}
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Categoría</label>
                <select tabIndex={editStockOnly ? -1 : undefined} {...register('category')} className={`w-full p-2.5 border border-slate-300 rounded-lg text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none ${editStockOnly ? 'bg-slate-100 text-slate-400 pointer-events-none' : 'bg-white'}`}>
                  {selectableCategories.map(c => <option key={c} value={c}>{categoryLabel(c)}</option>)}
                </select>
                {errors.category && <p className="text-red-500 text-xs mt-1">{errors.category.message}</p>}
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Precio Global ($)</label>
                <input type="number" step="0.01" readOnly={editStockOnly} {...register('price', { valueAsNumber: true })} onFocus={(e) => e.target.select()} placeholder="0.00" className="w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none read-only:bg-slate-100 read-only:text-slate-400 read-only:cursor-not-allowed" />
                {errors.price && <p className="text-red-500 text-xs mt-1">{errors.price.message}</p>}
              </div>
            </div>

            {/* ¿Tiene variantes?: solo al dar de alta (no en edición ni reposición). */}
            {!editingProduct && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">¿Este producto tiene variantes?</label>
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => setHasVariants(false)}
                    className={`flex-1 px-3 py-2 rounded-lg border text-sm font-semibold transition cursor-pointer ${!hasVariants ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'}`}
                  >
                    No
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setHasVariants(true);
                      if (variantRows.length === 0) setVariantRows([newVariantRow(watch('price') || 0)]);
                    }}
                    className={`flex-1 px-3 py-2 rounded-lg border text-sm font-semibold transition cursor-pointer ${hasVariants ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'}`}
                  >
                    Sí
                  </button>
                </div>
              </div>
            )}

            {hasVariants && !editingProduct ? (
              <div className="space-y-3">
                <div className="border border-slate-200 rounded-lg overflow-x-auto">
                  <table className="w-full text-sm min-w-[560px]">
                    <thead>
                      <tr className="bg-slate-100 text-slate-600 text-xs uppercase">
                        <th className="p-2 text-left">Código existente</th>
                        <th className="p-2 text-left">Talla</th>
                        <th className="p-2 text-left">Color</th>
                        <th className="p-2 text-right">Stock</th>
                        <th className="p-2 text-right">Precio</th>
                        <th className="p-2 text-center">Acciones</th>
                      </tr>
                    </thead>
                    <tbody>
                      {variantRows.map((v, idx) => (
                        <tr key={v.key} className="border-t border-slate-100">
                          <td className="p-2">
                            <div className="flex gap-1">
                              <input
                                type="text"
                                value={v.sku_barcode}
                                onChange={(e) => setVariantRows(rows => rows.map((r, i) => i === idx ? { ...r, sku_barcode: e.target.value } : r))}
                                placeholder="Escanea o deja vacío"
                                className="w-full min-w-24 p-1.5 border border-slate-300 rounded bg-white text-slate-800 text-sm focus:ring-2 focus:ring-teal-600 outline-none"
                              />
                              <ScanButton onClick={() => setCameraTarget({ kind: 'variant', key: v.key })} className="lg:hidden px-2 py-1" />
                            </div>
                          </td>
                          <td className="p-2">
                            <input
                              type="text"
                              value={v.talla}
                              onChange={(e) => setVariantRows(rows => rows.map((r, i) => i === idx ? { ...r, talla: e.target.value } : r))}
                              placeholder="S, M, 10..."
                              className="w-20 p-1.5 border border-slate-300 rounded bg-white text-slate-800 text-sm focus:ring-2 focus:ring-teal-600 outline-none"
                            />
                          </td>
                          <td className="p-2">
                            <input
                              type="text"
                              value={v.color}
                              onChange={(e) => setVariantRows(rows => rows.map((r, i) => i === idx ? { ...r, color: e.target.value } : r))}
                              placeholder="Negro..."
                              className="w-24 p-1.5 border border-slate-300 rounded bg-white text-slate-800 text-sm focus:ring-2 focus:ring-teal-600 outline-none"
                            />
                          </td>
                          <td className="p-2">
                            <input
                              type="number"
                              value={v.stock}
                              onChange={(e) => setVariantRows(rows => rows.map((r, i) => i === idx ? { ...r, stock: e.target.value === '' ? '' : Number(e.target.value) } : r))}
                              onFocus={(e) => e.target.select()}
                              className="w-16 p-1.5 border border-slate-300 rounded bg-white text-slate-800 text-sm text-right focus:ring-2 focus:ring-teal-600 outline-none"
                            />
                          </td>
                          <td className="p-2">
                            <input
                              type="number"
                              step="0.01"
                              value={v.price}
                              onChange={(e) => setVariantRows(rows => rows.map((r, i) => i === idx ? { ...r, price: e.target.value === '' ? '' : Number(e.target.value) } : r))}
                              onFocus={(e) => e.target.select()}
                              className="w-20 p-1.5 border border-slate-300 rounded bg-white text-slate-800 text-sm text-right focus:ring-2 focus:ring-teal-600 outline-none"
                            />
                          </td>
                          <td className="p-2 text-center">
                            <button
                              type="button"
                              onClick={() => setVariantRows(rows => rows.filter((_, i) => i !== idx))}
                              className="text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition p-1 cursor-pointer"
                              title="Quitar variante"
                            >
                              🗑️
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <button
                  type="button"
                  onClick={() => setVariantRows(rows => [...rows, newVariantRow(watch('price') || 0)])}
                  className="text-sm font-semibold text-emerald-700 hover:text-emerald-800 cursor-pointer"
                >
                  + Agregar variante
                </button>
                <p className="text-xs text-slate-400 -mt-2">Cada variante arranca con el Precio Global de arriba; puedes cambiarlo por fila.</p>
              </div>
            ) : (
              <>
                {/* Talla y Color: opcionales. Se muestran juntos como "Talla · Color". */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Talla <span className="text-slate-400 font-normal">(opcional)</span></label>
                    <input type="text" readOnly={editStockOnly} {...register('talla')} placeholder="Ej: S, M, 10, 38" className="w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none read-only:bg-slate-100 read-only:text-slate-400 read-only:cursor-not-allowed" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Color <span className="text-slate-400 font-normal">(opcional)</span></label>
                    <input type="text" readOnly={editStockOnly} {...register('color')} placeholder="Ej: Beige, Negro" className="w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none read-only:bg-slate-100 read-only:text-slate-400 read-only:cursor-not-allowed" />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    Stock {editingProduct ? `para ${effectiveStore?.name ?? currentStore.name}` : `inicial (${formStore?.name ?? currentStore.name})`}
                  </label>
                  <input
                    type="number"
                    min={editingProduct && userRole === 'cashier' ? editingProduct.stock : undefined}
                    {...register('stock', { valueAsNumber: true })}
                    onFocus={(e) => e.target.select()}
                    placeholder="0"
                    className="w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none"
                  />
                  {errors.stock && <p className="text-red-500 text-xs mt-1">{errors.stock.message}</p>}
                </div>
              </>
            )}

            <div className="flex justify-end gap-3 pt-4 border-t border-slate-100 mt-4">
              <button type="button" onClick={closeModal} className="px-4 py-2 border border-slate-300 rounded-lg font-medium text-slate-700 hover:bg-slate-50 transition cursor-pointer">Cancelar</button>
              {/* Bloqueado mientras guarda. Sin esto, con internet lento el
                  primer clic salia, la pantalla no cambiaba, y el segundo clic
                  creaba un producto (o un modelo entero) repetido. */}
              <button
                type="submit"
                disabled={isSubmitting}
                className="px-4 py-2 bg-[#0f5c5c] text-white rounded-lg font-medium hover:bg-[#0a4545] transition cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {isSubmitting
                  ? 'Guardando…'
                  : editingProduct ? 'Guardar Cambios' : hasVariants ? 'Guardar producto con variantes' : 'Guardar Producto'}
              </button>
            </div>
          </form>
        </Modal>

        {/* MODAL: AJUSTE MASIVO DE PRECIOS (solo owner) */}
        <Modal
          isOpen={priceModalOpen}
          onClose={() => setPriceModalOpen(false)}
          title={`Ajustar precios · ${effectiveStore?.name ?? ''}`}
        >
          {priceResult ? (
            <div className="space-y-4">
              {priceResult.kind === 'applied' ? (
                <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 px-4 py-3 rounded-lg text-sm font-medium">
                  ✓ Listo: se actualizaron <strong>{priceResult.products}</strong>{' '}
                  {priceResult.products === 1 ? 'producto' : 'productos'} de <strong>{effectiveStore?.name}</strong>.
                </div>
              ) : (
                <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 px-4 py-3 rounded-lg text-sm font-medium">
                  ↩ Ajuste deshecho: <strong>{priceResult.restored}</strong>{' '}
                  {priceResult.restored === 1 ? 'producto volvió' : 'productos volvieron'} a su precio anterior.
                  {priceResult.skipped > 0 && (
                    <span className="block mt-1 font-normal">
                      {priceResult.skipped}{' '}
                      {priceResult.skipped === 1 ? 'producto quedó como estaba porque su precio se cambió' : 'productos quedaron como estaban porque su precio se cambió'}{' '}
                      a mano después del ajuste.
                    </span>
                  )}
                </div>
              )}

              {priceError && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm font-medium">
                  {priceError}
                </div>
              )}

              {/* Deshacer en caliente: el ajuste que se acaba de aplicar. */}
              {priceResult.kind === 'applied' && lastAdjustment && (
                priceRevertConfirming ? (
                  <div className="bg-amber-50 border border-amber-300 rounded-lg p-4 space-y-3">
                    <p className="text-sm text-amber-900 font-medium">
                      Se devolverán los precios exactamente como estaban antes de este ajuste.
                    </p>
                    <div className="flex flex-wrap justify-end gap-3">
                      <button
                        type="button"
                        disabled={priceReverting}
                        onClick={() => setPriceRevertConfirming(false)}
                        className="px-4 py-2 border border-slate-300 rounded-lg font-medium text-slate-700 hover:bg-slate-50 transition cursor-pointer disabled:opacity-50"
                      >
                        Volver
                      </button>
                      <button
                        type="button"
                        disabled={priceReverting}
                        onClick={revertLastAdjustment}
                        className="px-4 py-2 bg-amber-600 text-white rounded-lg font-bold hover:bg-amber-700 transition cursor-pointer disabled:opacity-50"
                      >
                        {priceReverting ? 'Deshaciendo…' : 'Sí, deshacer'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => { setPriceError(null); setPriceRevertConfirming(true); }}
                    className="w-full px-4 py-2 border border-amber-300 text-amber-800 bg-amber-50 rounded-lg font-semibold hover:bg-amber-100 transition cursor-pointer"
                  >
                    ↩ Deshacer este ajuste
                  </button>
                )
              )}

              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setPriceModalOpen(false)}
                  className="px-4 py-2 bg-[#0f5c5c] text-white rounded-lg font-medium hover:bg-[#0a4545] transition cursor-pointer"
                >
                  Cerrar
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              {/* Ajuste anterior todavía reversible */}
              {lastAdjustment && (
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 space-y-3">
                  <p className="text-sm text-slate-700">
                    Último ajuste:{' '}
                    <strong className={lastAdjustment.percent < 0 ? 'text-red-600' : 'text-teal-700'}>
                      {lastAdjustment.percent > 0 ? '+' : ''}{lastAdjustment.percent}%
                    </strong>{' '}
                    el{' '}
                    {new Date(lastAdjustment.created_at).toLocaleString('es-VE', {
                      timeZone: 'America/Caracas',
                      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true,
                    })}
                    {' · '}
                    {lastAdjustment.products_count}{' '}
                    {lastAdjustment.products_count === 1 ? 'producto' : 'productos'}.
                  </p>
                  {priceRevertConfirming ? (
                    <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 space-y-3">
                      <p className="text-sm text-amber-900 font-medium">
                        Se devolverán los precios exactamente como estaban antes de ese ajuste. Los productos
                        cuyo precio se haya cambiado a mano después se dejan como están.
                      </p>
                      <div className="flex flex-wrap justify-end gap-3">
                        <button
                          type="button"
                          disabled={priceReverting}
                          onClick={() => setPriceRevertConfirming(false)}
                          className="px-4 py-2 border border-slate-300 rounded-lg font-medium text-slate-700 hover:bg-white transition cursor-pointer disabled:opacity-50"
                        >
                          Volver
                        </button>
                        <button
                          type="button"
                          disabled={priceReverting}
                          onClick={revertLastAdjustment}
                          className="px-4 py-2 bg-amber-600 text-white rounded-lg font-bold hover:bg-amber-700 transition cursor-pointer disabled:opacity-50"
                        >
                          {priceReverting ? 'Deshaciendo…' : 'Sí, deshacer'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => { setPriceError(null); setPriceRevertConfirming(true); }}
                      className="w-full px-4 py-2 border border-amber-300 text-amber-800 bg-amber-50 rounded-lg font-semibold hover:bg-amber-100 transition cursor-pointer"
                    >
                      ↩ Deshacer ese ajuste
                    </button>
                  )}
                </div>
              )}

              <p className="text-sm text-slate-600">
                Cambia de una sola vez el precio de los <strong>{totalProducts}</strong>{' '}
                {totalProducts === 1 ? 'producto activo' : 'productos activos'} de{' '}
                <strong className="text-teal-700">{effectiveStore?.name}</strong>. No afecta a las otras tiendas
                ni al stock.
              </p>

              {/* Subir / Bajar */}
              <div className="flex gap-2">
                {([['up', '↑ Subir'], ['down', '↓ Bajar']] as const).map(([dir, label]) => (
                  <button
                    key={dir}
                    type="button"
                    onClick={() => { setPriceDirection(dir); setPriceConfirming(false); }}
                    className={`flex-1 px-4 py-2 rounded-lg border font-semibold text-sm transition cursor-pointer ${
                      priceDirection === dir
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Porcentaje</label>
                  <div className="relative">
                    <input
                      type="number"
                      min={0}
                      max={priceDirection === 'down' ? 90 : 300}
                      step="0.5"
                      value={pricePercent}
                      onChange={(e) => {
                        setPriceConfirming(false);
                        setPricePercent(e.target.value === '' ? '' : Number(e.target.value));
                      }}
                      className="w-full pr-8 pl-4 py-2 border border-slate-300 rounded-lg bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-600"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 font-medium">%</span>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Redondeo</label>
                  <select
                    value={priceRoundTo}
                    onChange={(e) => { setPriceConfirming(false); setPriceRoundTo(Number(e.target.value)); }}
                    className="w-full px-4 py-2 border border-slate-300 rounded-lg bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-600 cursor-pointer"
                  >
                    <option value={1}>Sin decimales ($142)</option>
                    <option value={0.5}>Al $0,50 más cercano</option>
                    <option value={0.01}>Exacto, con centavos</option>
                  </select>
                </div>
              </div>

              {/* Vista previa: cómo queda el catálogo ANTES de tocar nada */}
              {priceSignedPercent !== 0 && priceSamples.length > 0 && (
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 space-y-2">
                  <p className="text-xs font-bold uppercase tracking-wider text-slate-500">Vista previa</p>
                  {priceSamples.map(sample => (
                    <div key={sample.id} className="flex items-center justify-between gap-3 text-sm">
                      <span className="text-slate-600 truncate">{sample.name}</span>
                      <span className="shrink-0 font-medium text-slate-500">
                        ${Number(sample.price).toFixed(2)}{' → '}
                        <span className={priceDirection === 'down' ? 'text-red-600 font-bold' : 'text-teal-700 font-bold'}>
                          ${previewPrice(sample.price).toFixed(priceRoundTo >= 1 ? 0 : 2)}
                        </span>
                      </span>
                    </div>
                  ))}
                  <div className="pt-2 border-t border-slate-200 flex items-center justify-between gap-3 text-sm">
                    <span className="text-slate-600 font-medium">Costo del inventario</span>
                    <span className="shrink-0 font-medium text-slate-500">
                      ${totalCost.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{' → '}
                      <span className={priceDirection === 'down' ? 'text-red-600 font-bold' : 'text-teal-700 font-bold'}>
                        ${totalCostAfter.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                    </span>
                  </div>
                </div>
              )}

              {priceError && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm font-medium">
                  {priceError}
                </div>
              )}

              {priceConfirming ? (
                <div className="bg-amber-50 border border-amber-300 rounded-lg p-4 space-y-3">
                  <p className="text-sm text-amber-900 font-medium">
                    Se va a {priceDirection === 'down' ? 'BAJAR' : 'SUBIR'} un{' '}
                    <strong>{Math.abs(priceSignedPercent)}%</strong> el precio de{' '}
                    <strong>{totalProducts}</strong> {totalProducts === 1 ? 'producto' : 'productos'} de{' '}
                    <strong>{effectiveStore?.name}</strong>. Se puede deshacer desde este mismo modal.
                  </p>
                  <div className="flex flex-wrap justify-end gap-3">
                    <button
                      type="button"
                      disabled={priceApplying}
                      onClick={() => setPriceConfirming(false)}
                      className="px-4 py-2 border border-slate-300 rounded-lg font-medium text-slate-700 hover:bg-slate-50 transition cursor-pointer disabled:opacity-50"
                    >
                      Volver
                    </button>
                    <button
                      type="button"
                      disabled={priceApplying}
                      onClick={applyBulkPriceUpdate}
                      className="px-4 py-2 bg-amber-600 text-white rounded-lg font-bold hover:bg-amber-700 transition cursor-pointer disabled:opacity-50"
                    >
                      {priceApplying ? 'Aplicando…' : 'Sí, aplicar a toda la tienda'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex justify-end gap-3 pt-2 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={() => setPriceModalOpen(false)}
                    className="px-4 py-2 border border-slate-300 rounded-lg font-medium text-slate-700 hover:bg-slate-50 transition cursor-pointer"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    disabled={priceSignedPercent === 0 || totalProducts === 0}
                    onClick={() => { setPriceError(null); setPriceConfirming(true); }}
                    className="px-4 py-2 bg-[#0f5c5c] text-white rounded-lg font-medium hover:bg-[#0a4545] transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Revisar y aplicar
                  </button>
                </div>
              )}
            </div>
          )}
        </Modal>

        {/* MODAL: CAMBIAR EL CÓDIGO DE BARRAS */}
        <Modal isOpen={!!barcodeTarget} onClose={closeBarcodeModal} title="Cambiar código de barras">
          {barcodeTarget && (
            <div className="space-y-4">
              <div>
                <p className="font-bold text-slate-800 leading-tight">{barcodeTarget.name}</p>
                {formatVariant(barcodeTarget.talla, barcodeTarget.color) && (
                  <p className="text-sm text-slate-500">{formatVariant(barcodeTarget.talla, barcodeTarget.color)}</p>
                )}
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                <p className="text-[10px] uppercase tracking-widest text-slate-400 font-bold">Código actual</p>
                <p className="font-mono text-slate-700">{barcodeTarget.sku_barcode}</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Código nuevo</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    autoFocus
                    value={barcodeValue}
                    onChange={(e) => setBarcodeValue(e.target.value)}
                    onKeyDown={(e) => {
                      // El escáner manda Enter al final: así se cambia el código
                      // escaneando la etiqueta nueva, sin tocar el teclado.
                      if (e.key === 'Enter') { e.preventDefault(); void submitBarcodeChange(); }
                    }}
                    placeholder="Escribe el código nuevo..."
                    className="w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 font-mono focus:ring-2 focus:ring-teal-600 outline-none"
                  />
                  {/* Con la cámara solo se llena el campo: el cambio se confirma
                      con el botón, porque deja inservibles las etiquetas viejas. */}
                  <ScanButton onClick={() => setCameraTarget({ kind: 'barcode' })} />
                </div>
              </div>

              <div className="bg-amber-50 border border-amber-200 text-amber-800 text-xs rounded-lg px-3 py-2 font-medium leading-relaxed">
                ⚠️ Las etiquetas ya impresas con el código anterior <strong>dejarán de escanear</strong>.
                Hay que volver a etiquetar las unidades de este producto que estén en el piso de venta.
              </div>

              {barcodeError && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm font-medium">
                  {barcodeError}
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={closeBarcodeModal}
                  className="flex-1 py-2.5 rounded-lg border border-slate-300 text-slate-600 font-medium hover:bg-slate-50 transition cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={() => void submitBarcodeChange()}
                  disabled={barcodeSaving || !barcodeValue.trim()}
                  className="flex-1 py-2.5 rounded-lg bg-[#0f5c5c] hover:bg-[#0a4545] text-white font-medium transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  {barcodeSaving ? 'Guardando…' : 'Cambiar código'}
                </button>
              </div>
            </div>
          )}
        </Modal>

        {/* MODAL: VINCULAR A PRODUCTO PADRE */}
        <Modal isOpen={!!linkingProduct} onClose={closeLinkModal} title="Vincular a producto padre">
          {linkingProduct && (
            <div className="space-y-4">
              <div className="bg-teal-50 text-teal-800 text-xs font-semibold px-3 py-2 rounded-lg border border-teal-200">
                {linkingProduct.name} ({linkingProduct.sku_barcode})
              </div>
              {linkError && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm font-medium">{linkError}</div>
              )}
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setLinkMode('new')}
                  className={`flex-1 px-3 py-2 rounded-lg border text-sm font-semibold transition cursor-pointer ${linkMode === 'new' ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'}`}
                >
                  Crear producto padre
                </button>
                <button
                  type="button"
                  onClick={() => setLinkMode('existing')}
                  className={`flex-1 px-3 py-2 rounded-lg border text-sm font-semibold transition cursor-pointer ${linkMode === 'existing' ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'}`}
                >
                  Usar uno existente
                </button>
              </div>

              {linkMode === 'new' ? (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Nombre del producto padre</label>
                  <input
                    type="text"
                    value={linkNewGroupName}
                    onChange={(e) => setLinkNewGroupName(e.target.value)}
                    className="w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none"
                  />
                  <p className="text-xs text-slate-400 mt-1">Categoría y precio se toman de este producto ({categoryLabel(linkingProduct.category)}, ${linkingProduct.price.toFixed(2)}).</p>
                </div>
              ) : (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Buscar producto padre</label>
                  <input
                    type="text"
                    value={linkGroupSearch}
                    onChange={(e) => setLinkGroupSearch(e.target.value)}
                    placeholder="Nombre del producto padre..."
                    className="w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none mb-2"
                  />
                  <div className="max-h-48 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
                    {matchingGroups.length === 0 ? (
                      <p className="p-3 text-sm text-slate-400">Sin productos padre que coincidan.</p>
                    ) : matchingGroups.map(g => (
                      <button
                        key={g.id}
                        type="button"
                        disabled={linkSubmitting}
                        onClick={() => handleLinkExisting(g.id, g.name)}
                        className="w-full text-left p-3 hover:bg-teal-50 transition cursor-pointer disabled:opacity-50"
                      >
                        <p className="font-medium text-slate-800 text-sm">{g.name}</p>
                        <p className="text-xs text-slate-500">{categoryLabel(g.category)} · ${g.default_price.toFixed(2)}</p>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
                <button type="button" onClick={closeLinkModal} className="px-4 py-2 border border-slate-300 rounded-lg font-medium text-slate-700 hover:bg-slate-50 transition cursor-pointer">Cancelar</button>
                {linkMode === 'new' && (
                  <button
                    type="button"
                    disabled={linkSubmitting}
                    onClick={handleLinkCreateNew}
                    className="px-4 py-2 bg-[#0f5c5c] text-white rounded-lg font-medium hover:bg-[#0a4545] transition cursor-pointer disabled:opacity-50"
                  >
                    Crear y vincular
                  </button>
                )}
              </div>
            </div>
          )}
        </Modal>

        {/* MODAL: EDITAR NOMBRE DEL PRODUCTO PADRE */}
        <Modal isOpen={!!editingGroup} onClose={closeEditGroupModal} title="Editar producto padre">
          {editingGroup && (
            <div className="space-y-4">
              <div className="bg-teal-50 text-teal-800 text-xs font-semibold px-3 py-2 rounded-lg border border-teal-200">
                {categoryLabel(editingGroup.category)} · ${editingGroup.default_price.toFixed(2)}
              </div>
              {editGroupError && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm font-medium">{editGroupError}</div>
              )}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Nombre</label>
                <input
                  type="text"
                  autoFocus
                  value={editGroupName}
                  onChange={(e) => setEditGroupName(e.target.value)}
                  onFocus={(e) => e.target.select()}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSaveGroupName(); }}
                  className="w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none"
                />
                <p className="text-xs text-slate-400 mt-1">Solo cambia el nombre del producto padre; el nombre de cada variante (SKU) no se toca.</p>
              </div>
              <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
                <button type="button" onClick={closeEditGroupModal} className="px-4 py-2 border border-slate-300 rounded-lg font-medium text-slate-700 hover:bg-slate-50 transition cursor-pointer">Cancelar</button>
                <button
                  type="button"
                  disabled={editGroupSubmitting}
                  onClick={handleSaveGroupName}
                  className="px-4 py-2 bg-[#0f5c5c] text-white rounded-lg font-medium hover:bg-[#0a4545] transition cursor-pointer disabled:opacity-50"
                >
                  Guardar
                </button>
              </div>
            </div>
          )}
        </Modal>

        {/* MODAL: AGREGAR VARIANTE A UN PRODUCTO PADRE EXISTENTE */}
        <Modal isOpen={!!addingVariantGroup} onClose={closeAddVariantModal} title="Agregar variante">
          {addingVariantGroup && (
            <div className="space-y-4">
              <div className="bg-teal-50 text-teal-800 text-xs font-semibold px-3 py-2 rounded-lg border border-teal-200">
                {addingVariantGroup.name} &middot; {categoryLabel(addingVariantGroup.category)}
              </div>
              {addVariantError && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm font-medium">{addVariantError}</div>
              )}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Código de Barras (Escanea o deja vacío)</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    autoFocus
                    value={addVariantSku}
                    onChange={(e) => setAddVariantSku(e.target.value)}
                    placeholder="Escanea el código aquí..."
                    className="w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none"
                  />
                  <ScanButton onClick={() => setCameraTarget({ kind: 'addVariant' })} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Talla</label>
                  <input
                    type="text"
                    value={addVariantTalla}
                    onChange={(e) => setAddVariantTalla(e.target.value)}
                    placeholder="S, M, 10..."
                    className="w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Color</label>
                  <input
                    type="text"
                    value={addVariantColor}
                    onChange={(e) => setAddVariantColor(e.target.value)}
                    placeholder="Negro, Beige..."
                    className="w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Stock ({effectiveStore?.name ?? currentStore.name})</label>
                  <input
                    type="number"
                    value={addVariantStock}
                    onChange={(e) => setAddVariantStock(e.target.value === '' ? '' : Number(e.target.value))}
                    onFocus={(e) => e.target.select()}
                    className="w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Precio ($)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={addVariantPrice}
                    onChange={(e) => setAddVariantPrice(e.target.value === '' ? '' : Number(e.target.value))}
                    onFocus={(e) => e.target.select()}
                    className="w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
                <button type="button" onClick={closeAddVariantModal} className="px-4 py-2 border border-slate-300 rounded-lg font-medium text-slate-700 hover:bg-slate-50 transition cursor-pointer">Cancelar</button>
                <button
                  type="button"
                  disabled={addVariantSubmitting}
                  onClick={handleAddVariantSubmit}
                  className="px-4 py-2 bg-[#0f5c5c] text-white rounded-lg font-medium hover:bg-[#0a4545] transition cursor-pointer disabled:opacity-50"
                >
                  Agregar variante
                </button>
              </div>
            </div>
          )}
        </Modal>
      </div>

      {/* VISTA DE IMPRESIÓN */}
      {selectedProduct && (
        <div className="hidden print:block">
          <BarcodeLabel
            name={promoName}
            skuBarcode={selectedProduct.sku_barcode}
            talla={selectedProduct.talla}
            color={selectedProduct.color}
            price={finalPrice}
            originalPrice={discountPercent > 0 ? originalPrice : null}
            showPrice={!labelWithoutPrice}
          />
        </div>
      )}

      <CameraScanner
        isOpen={!!cameraTarget}
        onClose={() => setCameraTarget(null)}
        onScan={handleCameraScan}
        title={cameraTarget?.kind === 'search' ? 'Buscar por código' : 'Leer código de barras'}
      />
    </>
  );
}
