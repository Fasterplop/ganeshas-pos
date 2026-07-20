'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { createClient } from '@/lib/supabase/client';
import Modal from '@/components/Modal';
import Barcode from 'react-barcode';
import { usePOSStore, Store } from '@/store/usePOSStore';
import ExcelJS from 'exceljs';
import { variantLabel, formatVariant, labelFontPx } from '@/lib/productVariant';

const productSchema = z.object({
  sku_barcode: z.string().optional(),
  name: z.string().min(3, { message: 'El nombre es obligatorio' }),
  category: z.enum(['juguetes', 'ropa', 'zapato', 'perfume', 'accesorios', 'lentes'], {
    message: 'Selecciona una categoría válida',
  }),
  price: z.number({ message: 'Debe ser un número válido' }).min(0.01, { message: 'El precio debe ser mayor a 0' }),
  stock: z.number({ message: 'Debe ser un número válido' }),
  owner_store_id: z.string().min(1, { message: 'Selecciona una tienda' }),
  talla: z.string().optional(),
  color: z.string().optional(),
});

type ProductFormValues = z.infer<typeof productSchema>;

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
}

// Prefijo de SKU según la TIENDA dueña (juguetes -> JUG, ropa -> ROP).
function storePrefix(storeName: string): string {
  const n = storeName.toLowerCase();
  if (n.includes('juguet')) return 'JUG';
  if (n.includes('ropa')) return 'ROP';
  return storeName.trim().substring(0, 3).toUpperCase() || 'GEN';
}

// Categoría por defecto sugerida según la tienda.
function defaultCategoryForStore(storeName: string): 'juguetes' | 'ropa' | 'zapato' | 'perfume' {
  const n = storeName.toLowerCase();
  if (n.includes('ropa')) return 'ropa';
  if (n.includes('juguet')) return 'juguetes';
  return 'juguetes';
}

// --- Semáforo de stock ---------------------------------------------------
// "Stock bajo" = 2 o menos (pero con existencias): el color ámbar y el filtro
// usan el mismo umbral (1..2). Los agotados (=< 0) tienen su propio color rojo
// y su propio filtro. Verde para stock normal (> 2).
const LOW_STOCK_MAX = 2;
type StockTier = 'out' | 'low' | 'ok';
function stockTier(stock: number): StockTier {
  if (stock <= 0) return 'out';             // rojo  → agotado / negativo
  if (stock <= LOW_STOCK_MAX) return 'low'; // ámbar → bajo (1..2)
  return 'ok';                              // verde → normal (> 2)
}
const isOut = (stock: number) => stock <= 0;                           // Agotados
const isLow = (stock: number) => stock > 0 && stock <= LOW_STOCK_MAX;  // Stock bajo (1..2)

const TIER_BADGE: Record<StockTier, string> = {
  out: 'bg-red-50 text-red-600',
  low: 'bg-amber-50 text-amber-600',
  ok: 'bg-emerald-50 text-emerald-600',
};

// Única columna ordenable de la tabla (Stock Local).
type SortKey = 'stock';

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
  const className = `relative text-left bg-white rounded-xl border p-4 flex items-center gap-3 transition
    ${active ? activeRing : 'border-slate-200'}
    ${clickable ? 'hover:border-slate-300 hover:shadow-sm cursor-pointer' : 'cursor-default'}`;
  const inner = (
    <>
      <span className={`shrink-0 w-11 h-11 rounded-full flex items-center justify-center text-lg ${iconWrap}`}>{icon}</span>
      <span className="min-w-0">
        <span className="block text-xs font-medium text-slate-500 truncate">{label}</span>
        <span className={`block text-2xl font-bold leading-tight ${valueColor}`}>{value}</span>
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

  // Orden de columnas, filtro por semáforo de stock y paginación.
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [stockFilter, setStockFilter] = useState<'all' | 'low' | 'out'>('all');
  const [page, setPage] = useState(1);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);

  const [formError, setFormError] = useState<string | null>(null);

  const [promoName, setPromoName] = useState('Liquidación');
  const [discountPercent, setDiscountPercent] = useState(0);

  // Tiendas activas + tienda que se está VIENDO (filtro local, solo para vista).
  const [stores, setStores] = useState<Store[]>([]);
  const [viewStoreId, setViewStoreId] = useState<string>('');

  const { register, handleSubmit, reset, watch, formState: { errors } } = useForm<ProductFormValues>({
    resolver: zodResolver(productSchema),
    defaultValues: { stock: 0, sku_barcode: '' }
  });

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
  async function fetchProducts(storeId: string) {
    setLoading(true);

    const { data: globalProducts } = await supabase
      .from('products')
      .select('id, sku_barcode, name, category, price, owner_store_id, talla, color')
      .eq('is_active', true)
      .eq('owner_store_id', storeId)
      .order('name');

    const { data: storeStock } = await supabase
      .from('store_stock')
      .select('product_id, stock')
      .eq('store_id', storeId);

    if (globalProducts) {
      const stockMap: Record<string, number> = {};
      if (storeStock) storeStock.forEach(s => { stockMap[s.product_id] = s.stock; });
      const mergedProducts: Product[] = globalProducts.map(p => ({ ...p, stock: stockMap[p.id] ?? 0 }));
      setProducts(mergedProducts);
    } else {
      setProducts([]);
    }

    setLoading(false);
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
    if (viewStoreId) fetchProducts(viewStoreId);
  }, [viewStoreId]);

  // Cualquier cambio de búsqueda/filtro/orden/tienda vuelve a la primera página.
  useEffect(() => {
    setPage(1);
  }, [searchTerm, stockFilter, sortKey, sortDir, viewStoreId]);

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
      fetchProducts(viewStoreId);
      return;
    }

    // En edición (owner / cajero normal), el producto pertenece a la tienda que se
    // ve (== su tienda de operación). En creación, la tienda dueña la elige el usuario.
    const targetStoreId = editingProduct ? viewStoreId : data.owner_store_id;
    const targetStore = stores.find(s => s.id === targetStoreId) ?? currentStore;

    let finalSku = data.sku_barcode?.trim();
    if (!finalSku) {
      // SKU autogenerado con prefijo de la TIENDA dueña (JUG/ROP), no de la categoría.
      const prefix = storePrefix(targetStore.name);
      const uniqueNumber = Math.floor(100000 + Math.random() * 900000);
      finalSku = `${prefix}-${uniqueNumber}`;
    }

    if (editingProduct) {
      const { error: productError } = await supabase
        .from('products')
        .update({
          sku_barcode: finalSku,
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

    } else {
      // MODO CREACIÓN: Insertar Producto Globalmente, atado a su tienda dueña.
      const { data: newProduct, error: productError } = await supabase
        .from('products')
        .insert([{
          sku_barcode: finalSku,
          name: data.name,
          category: data.category,
          price: data.price,
          is_active: true,
          owner_store_id: targetStoreId,
          talla: data.talla?.trim() ? data.talla.trim() : null,
          color: data.color?.trim() ? data.color.trim() : null
        }])
        .select('id')
        .single();

      if (productError || !newProduct) {
        if (productError?.code === '23505') setFormError('⚠️ Ya existe un producto con este código.');
        else setFormError('Error al crear producto: ' + productError?.message);
        return;
      }

      // El trigger de la BD ya creó las filas de stock en 0 para todas las tiendas.
      // Cargamos el stock inicial en la tienda dueña. El cajero reponedor carga
      // su stock inicial vía el RPC (que valida su alcance: global o local).
      if (data.stock > 0) {
        if (isRestocker) {
          const { error } = await supabase.rpc('restock_stock', {
            p_product_id: newProduct.id,
            p_store_id: targetStoreId,
            p_new_stock: data.stock,
          });
          if (error) console.error("Error al cargar el stock inicial (reponedor):", error);
        } else {
          const { error: stockUpdateError } = await supabase
            .from('store_stock')
            .update({ stock: data.stock })
            .eq('product_id', newProduct.id)
            .eq('store_id', targetStoreId);
          if (stockUpdateError) {
            console.error("Error al actualizar el stock inicial en la tienda dueña:", stockUpdateError);
          }
        }
      }
    }

    closeModal();
    fetchProducts(viewStoreId);
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
      fetchProducts(viewStoreId);
    }
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
    setIsModalOpen(false);
    setEditingProduct(null);
    setFormError(null);
    reset({ sku_barcode: '', name: '', category: 'juguetes', price: 0, stock: 0, owner_store_id: currentStore?.id ?? '', talla: '', color: '' });
  };

  const LOW_STOCK_THRESHOLD = 5; // ajústalo a tu realidad

const handleExportCSV = async () => {
  if (products.length === 0 || !currentStore) return;

  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet('Inventario', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  ws.columns = [
    { header: 'SKU',                          key: 'sku',      width: 18 },
    { header: 'Nombre',                       key: 'nombre',   width: 36 },
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
      variante: variantLabel(p.talla, p.color),
      categoria: p.category,
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

  ws.autoFilter = { from: 'A1', to: 'G1' };

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

  const handlePrint = () => {
    if (!selectedProduct) return alert('Selecciona un producto primero');
    window.print();
  };

  // --- Resumen (sobre TODO el inventario de la tienda, ignora búsqueda/filtro) ---
  const totalProducts = products.length;
  const totalUnits = products.reduce((sum, p) => sum + (p.stock || 0), 0);
  const totalCost = products.reduce((sum, p) => sum + (p.price || 0) * (p.stock || 0), 0);
  const lowCount = products.filter(p => isLow(p.stock)).length;
  const outCount = products.filter(p => isOut(p.stock)).length;

  // Pipeline de la tabla: búsqueda → filtro de semáforo → orden → paginación.
  const searched = products.filter(p =>
    p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    p.sku_barcode.toLowerCase().includes(searchTerm.toLowerCase())
  );
  const statusFiltered = searched.filter(p => {
    if (stockFilter === 'low') return isLow(p.stock);
    if (stockFilter === 'out') return isOut(p.stock);
    return true;
  });
  // Orden solo por Stock Local (única columna ordenable).
  const sortedProducts = sortKey === 'stock'
    ? [...statusFiltered].sort((a, b) => (sortDir === 'asc' ? a.stock - b.stock : b.stock - a.stock))
    : statusFiltered;

  const totalPages = Math.max(1, Math.ceil(sortedProducts.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paginatedProducts = sortedProducts.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

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
  const filterChipLabel = stockFilter === 'low' ? 'Stock: 2 o menos' : 'Agotados';

  const originalPrice = selectedProduct?.price || 0;
  const finalPrice = originalPrice - (originalPrice * (discountPercent / 100));
  // Etiqueta: variante y tamaño de fuente dinámico (nombre editable = promoName).
  const labelVariant = formatVariant(selectedProduct?.talla, selectedProduct?.color);
  const labelFs = labelFontPx(`${promoName}${labelVariant ? ` · ${labelVariant}` : ''}`);

  if (!currentStore) {
    return <div className="h-full flex items-center justify-center text-slate-500">Cargando contexto de la sucursal...</div>;
  }

  return (
    <>
      <div className="print:hidden flex flex-col gap-6 h-full font-sans">

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

            {/* Añadir: owner y cajero normal, solo en su propia tienda (no en vista de otra). */}
            {canAdd && (
              <button onClick={handleOpenAddModal} className="flex-1 md:flex-none px-4 py-2 text-white bg-[#0f5c5c] rounded-lg hover:bg-[#0a4545] transition whitespace-nowrap shadow-sm cursor-pointer font-medium">
                + Añadir Producto
              </button>
            )}
          </div>
        </div>

        {/* Tarjetas de resumen + filtros clickeables */}
        <div className={`grid gap-4 grid-cols-2 sm:grid-cols-3 ${isOwner ? 'lg:grid-cols-5' : 'lg:grid-cols-4'}`}>
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
          {/* Stock bajo: 2 o menos con existencias (1 o 2 unidades). Filtro clickeable. */}
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

        {/* Contenido: tabla + descuento rápido */}
        <div className="flex flex-col md:flex-row gap-6 flex-1 min-h-0">

          {/* Tabla de Productos */}
          <div className="flex-1 bg-white rounded-xl shadow-sm border border-slate-200 flex flex-col overflow-hidden">

            {/* Barra: título del panel + búsqueda (izquierda) + chip de filtro (derecha) */}
            <div className="p-6 pb-4 flex flex-col lg:flex-row lg:items-center gap-4 border-b border-slate-100">
              <div className="min-w-0">
                <h2 className="text-lg font-bold text-slate-800">{panelTitle}</h2>
                <p className="text-sm text-slate-500">{panelSubtitle}</p>
              </div>
              <div className="relative w-full lg:w-72">
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="🔍 Buscar código o nombre..."
                  className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-600 transition"
                />
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

            <div className="flex-1 overflow-auto px-6">
              <table className="w-full text-left border-collapse min-w-[600px]">
                <thead className="sticky top-0 z-10">
                  <tr className="bg-slate-700 text-white text-sm">
                    <th className="p-3 rounded-tl-lg">Código</th>
                    <th className="p-3">Nombre</th>
                    <th className="p-3">Talla/Color</th>
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
                  ) : sortedProducts.length === 0 ? (
                    <tr><td colSpan={7} className="p-8 text-center text-slate-500">{searchTerm || stockFilter !== 'all' ? 'No hay productos que coincidan con el filtro.' : 'No hay productos en esta tienda.'}</td></tr>
                  ) : (
                    paginatedProducts.map((product) => {
                      const tier = stockTier(product.stock);
                      return (
                        <tr
                          key={product.id}
                          onClick={() => setSelectedProduct(product)}
                          className={`border-b border-slate-100 cursor-pointer transition ${selectedProduct?.id === product.id ? 'bg-teal-50' : 'hover:bg-slate-50'}`}
                        >
                          <td className="p-3 text-slate-500 font-mono text-sm">{product.sku_barcode}</td>
                          <td className="p-3 font-medium text-slate-800">{product.name}</td>
                          <td className="p-3 text-sm text-slate-600">{variantLabel(product.talla, product.color)}</td>
                          <td className="p-3">
                            <span className="bg-blue-50 text-blue-700 px-2 py-1 rounded-full text-xs capitalize">{product.category}</span>
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
                                {/* Editar / Reponer stock. El cajero reponedor solo repone stock. */}
                                <button
                                  onClick={(e) => handleEdit(e, product)}
                                  className="text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded transition p-1.5 cursor-pointer"
                                  title={isRestocker ? 'Reponer stock' : 'Editar'}
                                >
                                  {isRestocker ? '📦' : '✏️'}
                                </button>
                                {/* Eliminar: solo owner en su tienda. */}
                                {canDelete && (
                                  <button
                                    onClick={(e) => handleDelete(e, product.id)}
                                    className="text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition p-1.5 ml-2 cursor-pointer"
                                    title="Desactivar Globalmente"
                                  >
                                    🗑️
                                  </button>
                                )}
                              </>
                            ) : (
                              <span className="text-slate-300">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Pie: conteo + paginación (los controles aparecen con más de 50 productos) */}
            {!loading && sortedProducts.length > 0 && (
              <div className="px-6 py-3 border-t border-slate-100 flex flex-col sm:flex-row items-center justify-between gap-3 text-sm text-slate-500">
                <span>Mostrando {paginatedProducts.length} de {sortedProducts.length} productos</span>
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
          <div className="w-full md:w-80 bg-white rounded-xl shadow-sm border border-slate-200 p-6">
            <div className="flex items-center gap-2 mb-6">
              <span className="bg-blue-100 p-2 rounded-full">🏷️</span>
              <h3 className="font-bold text-slate-800">Descuento Rápido</h3>
            </div>

            {!selectedProduct ? (
              <div className="text-center text-slate-500 text-sm py-8 border-2 border-dashed border-slate-200 rounded-lg">
                Selecciona un producto de la tabla para generar su etiqueta.
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
                <p className="text-xs text-slate-400 -mt-2">El descuento es opcional. Con 0% se imprime el precio normal.</p>
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
                Código de Barras (Escanea o deja vacío)
              </label>
              <input
                type="text"
                autoFocus={!editStockOnly}
                readOnly={editStockOnly}
                {...register('sku_barcode')}
                placeholder="Escanea el código aquí..."
                className="w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none read-only:bg-slate-100 read-only:text-slate-400 read-only:cursor-not-allowed"
              />
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
                <select {...register('owner_store_id')} className={`w-full p-2.5 border border-slate-300 rounded-lg text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none ${isLocalRestocker ? 'bg-slate-100 text-slate-500 pointer-events-none' : 'bg-white'}`}>
                  {(isLocalRestocker ? stores.filter(s => s.id === currentStore.id) : stores).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                {errors.owner_store_id && <p className="text-red-500 text-xs mt-1">{errors.owner_store_id.message}</p>}
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Categoría</label>
                <select tabIndex={editStockOnly ? -1 : undefined} {...register('category')} className={`w-full p-2.5 border border-slate-300 rounded-lg text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none ${editStockOnly ? 'bg-slate-100 text-slate-400 pointer-events-none' : 'bg-white'}`}>
                  <option value="juguetes">Juguetes</option>
                  <option value="ropa">Ropa</option>
                  <option value="zapato">Zapato</option>
                  <option value="perfume">Perfume</option>
                  <option value="accesorios">Accesorios</option>
                  <option value="lentes">Lentes</option>
                </select>
                {errors.category && <p className="text-red-500 text-xs mt-1">{errors.category.message}</p>}
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Precio Global ($)</label>
                <input type="number" step="0.01" readOnly={editStockOnly} {...register('price', { valueAsNumber: true })} placeholder="0.00" className="w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none read-only:bg-slate-100 read-only:text-slate-400 read-only:cursor-not-allowed" />
                {errors.price && <p className="text-red-500 text-xs mt-1">{errors.price.message}</p>}
              </div>
            </div>

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
                placeholder="0"
                className="w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none"
              />
              {errors.stock && <p className="text-red-500 text-xs mt-1">{errors.stock.message}</p>}
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t border-slate-100 mt-4">
              <button type="button" onClick={closeModal} className="px-4 py-2 border border-slate-300 rounded-lg font-medium text-slate-700 hover:bg-slate-50 transition cursor-pointer">Cancelar</button>
              <button type="submit" className="px-4 py-2 bg-[#0f5c5c] text-white rounded-lg font-medium hover:bg-[#0a4545] transition cursor-pointer">
                {editingProduct ? "Guardar Cambios" : "Guardar Producto"}
              </button>
            </div>
          </form>
        </Modal>
      </div>

      {/* VISTA DE IMPRESIÓN */}
      {selectedProduct && (
        <div className="hidden print:flex flex-row items-center justify-between bg-white" style={{ width: '62mm', height: '29mm', overflow: 'hidden', margin: 0, padding: '1.2mm 1.5mm 2.2mm 1.5mm' }}>
          <div className="flex items-center justify-center h-full pl-1">
            <p className="text-[8px] font-black text-black tracking-wider uppercase" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
              Ganesha Store
            </p>
          </div>

          <div className="flex flex-col items-center justify-center flex-1 w-full overflow-hidden pr-1">
            <p className="font-black text-black w-full text-center leading-tight break-words" style={{ fontSize: `${labelFs.name}px` }}>
              {promoName.toUpperCase()}
              {labelVariant && (
                <span style={{ fontSize: `${labelFs.variant}px` }}> · {labelVariant}</span>
              )}
            </p>

            <div className="flex items-baseline gap-2 mt-0.5 mb-0.5">
              {discountPercent > 0 && (
                <p className="text-[12px] line-through text-gray-500 leading-none">${originalPrice.toFixed(2)}</p>
              )}
              <p className="text-[24px] font-black text-black leading-none">${finalPrice.toFixed(2)}</p>
            </div>

            <Barcode value={selectedProduct.sku_barcode} width={1.3} height={20} fontSize={10} margin={0} displayValue={true} />
          </div>
        </div>
      )}
    </>
  );
}
