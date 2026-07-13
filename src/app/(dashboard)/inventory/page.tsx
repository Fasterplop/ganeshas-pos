'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { createClient } from '@/lib/supabase/client';
import Modal from '@/components/Modal';
import Barcode from 'react-barcode';
import { usePOSStore } from '@/store/usePOSStore';
import ExcelJS from 'exceljs';

const productSchema = z.object({
  sku_barcode: z.string().optional(),
  name: z.string().min(3, { message: 'El nombre es obligatorio' }),
  category: z.enum(['juguetes', 'ropa', 'otros', 'descuento'], {
    message: 'Selecciona una categoría válida',
  }),
  price: z.number({ message: 'Debe ser un número válido' }).min(0.01, { message: 'El precio debe ser mayor a 0' }),
  stock: z.number({ message: 'Debe ser un número válido' }).min(0, { message: 'El stock no puede ser negativo' }),
});

type ProductFormValues = z.infer<typeof productSchema>;

interface Product {
  id: string;
  sku_barcode: string;
  name: string;
  category: string;
  price: number;
  stock: number;
}

export default function InventoryPage() {
  const { currentStore } = usePOSStore();
  const supabase = createClient();

  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [userRole, setUserRole] = useState<string | null>(null);
  
  const [searchTerm, setSearchTerm] = useState('');
  
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  
  const [formError, setFormError] = useState<string | null>(null);
  
  const [promoName, setPromoName] = useState('Liquidación');
  const [discountPercent, setDiscountPercent] = useState(0);

  const { register, handleSubmit, reset, formState: { errors } } = useForm<ProductFormValues>({
    resolver: zodResolver(productSchema),
    defaultValues: { stock: 0, sku_barcode: '' }
  });

  async function fetchData() {
    if (!currentStore) return;
    setLoading(true);

    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
      if (profile) setUserRole(profile.role);
    }

    const { data: globalProducts } = await supabase
      .from('products')
      .select('id, sku_barcode, name, category, price')
      .eq('is_active', true)
      .order('name');

    const { data: storeStock } = await supabase
      .from('store_stock')
      .select('product_id, stock')
      .eq('store_id', currentStore.id);

    if (globalProducts) {
      const stockMap: Record<string, number> = {};
      if (storeStock) {
        storeStock.forEach(s => {
          stockMap[s.product_id] = s.stock;
        });
      }

      const mergedProducts: Product[] = globalProducts.map(p => ({
        ...p,
        stock: stockMap[p.id] || 0
      }));

      setProducts(mergedProducts);
    }
    
    setLoading(false);
  }

  useEffect(() => {
    setIsModalOpen(false);
    setSelectedProduct(null);
    if (currentStore) {
      fetchData();
    } else {
      setProducts([]);
    }
  }, [currentStore?.id]);

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

    // Asignación inteligente de categoría por defecto según el nombre de la tienda activa
    let defaultCategory: 'ropa' | 'juguetes' | 'otros' = 'otros';
    const storeName = currentStore?.name.toLowerCase() || '';
    
    if (storeName.includes('ropa')) {
      defaultCategory = 'ropa';
    } else if (storeName.includes('juguete')) {
      defaultCategory = 'juguetes';
    }

    reset({
      sku_barcode: '',
      name: '',
      category: defaultCategory,
      price: 0,
      stock: 0,
    });
    setIsModalOpen(true);
  };

  const onSubmitProduct = async (data: ProductFormValues) => {
    if (!currentStore) return;
    setFormError(null);

    let finalSku = data.sku_barcode?.trim();
    if (!finalSku) {
      const categoryPrefix = data.category.substring(0, 3).toUpperCase();
      const uniqueNumber = Math.floor(100000 + Math.random() * 900000);
      finalSku = `${categoryPrefix}-${uniqueNumber}`;
    }

    if (editingProduct) {
      const { error: productError } = await supabase
        .from('products')
        .update({
          sku_barcode: finalSku,
          name: data.name,
          category: data.category,
          price: data.price
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
          store_id: currentStore.id,
          stock: data.stock
        }, { onConflict: 'product_id, store_id' });

      if (stockError) {
        setFormError('Error al actualizar el stock local: ' + stockError.message);
        return;
      }

    } else {
      // MODO CREACIÓN: Insertar Producto Globalmente
      const { data: newProduct, error: productError } = await supabase
        .from('products')
        .insert([{
          sku_barcode: finalSku,
          name: data.name,
          category: data.category,
          price: data.price,
          is_active: true
        }])
        .select('id')
        .single();
      
      if (productError || !newProduct) {
        if (productError?.code === '23505') setFormError('⚠️ Ya existe un producto con este código.');
        else setFormError('Error al crear producto: ' + productError?.message);
        return;
      }

      // IMPORTANTE: El trigger de la base de datos ya creó las filas de stock en 0 para todas las tiendas.
      // Si el usuario especificó un stock inicial mayor a 0 para esta tienda, simplemente ejecutamos un update.
      if (data.stock > 0) {
        const { error: stockUpdateError } = await supabase
          .from('store_stock')
          .update({ stock: data.stock })
          .eq('product_id', newProduct.id)
          .eq('store_id', currentStore.id);

        if (stockUpdateError) {
          console.error("Error al actualizar el stock inicial en la sucursal activa:", stockUpdateError);
        }
      }
    }

    closeModal();
    fetchData();
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
      fetchData();
    }
  };

  const handleEdit = (e: React.MouseEvent, product: Product) => {
    e.stopPropagation(); 
    setEditingProduct(product);
    setFormError(null);
    reset({
      sku_barcode: product.sku_barcode,
      name: product.name,
      category: product.category as any,
      price: product.price,
      stock: product.stock,
    });
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setEditingProduct(null);
    setFormError(null);
    reset({ sku_barcode: '', name: '', category: 'otros', price: 0, stock: 0 });
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
    { header: 'Categoría',                    key: 'categoria', width: 16 },
    { header: 'Precio',                       key: 'precio',   width: 14, style: { numFmt: '"$"#,##0.00' } },
    { header: `Stock (${currentStore.name})`, key: 'stock',    width: 18 },
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

  ws.autoFilter = { from: 'A1', to: 'F1' };

  // --- Descarga ---
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `inventario_${currentStore.name.replace(/\s+/g, '_').toLowerCase()}.xlsx`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

  const handlePrint = () => {
    if (!selectedProduct) return alert('Selecciona un producto primero');
    window.print();
  };

  const filteredProducts = products.filter(p =>
    p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    p.sku_barcode.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const originalPrice = selectedProduct?.price || 0;
  const finalPrice = originalPrice - (originalPrice * (discountPercent / 100));

  if (!currentStore) {
    return <div className="h-full flex items-center justify-center text-slate-500">Cargando contexto de la sucursal...</div>;
  }

  return (
    <>
      <div className="print:hidden flex flex-col md:flex-row gap-6 h-full font-sans">
        
        {/* Tabla de Productos */}
        <div className="flex-1 bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex flex-col">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 gap-4">
            
            <div className="flex flex-col w-full md:w-auto">
              <h1 className="text-2xl font-bold text-slate-800">Inventario</h1>
              <p className="text-slate-500 text-sm">Mostrando stock para: <strong className="text-teal-700">{currentStore.name}</strong></p>
            </div>

            <div className="relative w-full md:w-80">
              <input 
                type="text" 
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="🔍 Buscar código o nombre..." 
                className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-600 transition"
              />
            </div>

            <div className="flex gap-2 w-full md:w-auto">
              <button onClick={handleExportCSV} className="flex-1 md:flex-none px-4 py-2 text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200 transition cursor-pointer font-medium">
                Exportar Excel
              </button>
              
              {/* MODIFICADO: Botón habilitado tanto para Owner como para Cashier */}
              {(userRole === 'owner' || userRole === 'cashier') && (
                <button onClick={handleOpenAddModal} className="flex-1 md:flex-none px-4 py-2 text-white bg-[#0f5c5c] rounded-lg hover:bg-[#0a4545] transition whitespace-nowrap shadow-sm cursor-pointer font-medium">
                  + Añadir Producto
                </button>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-auto">
            <table className="w-full text-left border-collapse min-w-[600px]">
              <thead>
                <tr className="bg-slate-700 text-white text-sm">
                  <th className="p-3 rounded-tl-lg">Código</th>
                  <th className="p-3">Nombre</th>
                  <th className="p-3">Categoría</th>
                  <th className="p-3 text-right">Precio</th>
                  <th className="p-3 text-right">Stock Local</th>
                  {userRole === 'owner' && <th className="p-3 text-center rounded-tr-lg">Acciones</th>}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={userRole === 'owner' ? 6 : 5} className="p-8 text-center text-slate-500">Sincronizando inventario con {currentStore.name}...</td></tr>
                ) : filteredProducts.length === 0 ? (
                  <tr><td colSpan={userRole === 'owner' ? 6 : 5} className="p-8 text-center text-slate-500">No hay productos disponibles.</td></tr>
                ) : (
                  filteredProducts.map((product) => (
                    <tr 
                      key={product.id} 
                      onClick={() => setSelectedProduct(product)}
                      className={`border-b border-slate-100 cursor-pointer transition ${selectedProduct?.id === product.id ? 'bg-teal-50' : 'hover:bg-slate-50'}`}
                    >
                      <td className="p-3 text-slate-500 font-mono text-sm">{product.sku_barcode}</td>
                      <td className="p-3 font-medium text-slate-800">{product.name}</td>
                      <td className="p-3">
                        <span className="bg-blue-50 text-blue-700 px-2 py-1 rounded-full text-xs capitalize">{product.category}</span>
                      </td>
                      <td className="p-3 text-right font-medium text-slate-600">${product.price.toFixed(2)}</td>
                      <td className="p-3 text-right font-bold text-emerald-600">
                        {product.stock > 0 ? product.stock : <span className="text-red-500">0</span>}
                      </td>
                      
                      {userRole === 'owner' && (
                        <td className="p-3 text-center">
                          <button 
                            onClick={(e) => handleEdit(e, product)}
                            className="text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded transition p-1.5 cursor-pointer"
                            title="Editar"
                          >
                            ✏️
                          </button>
                          <button 
                            onClick={(e) => handleDelete(e, product.id)}
                            className="text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition p-1.5 ml-2 cursor-pointer"
                            title="Desactivar Globalmente"
                          >
                            🗑️
                          </button>
                        </td>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
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

      {/* MODAL: AÑADIR / EDITAR PRODUCTO */}
      <div className="print:hidden">
        <Modal 
          isOpen={isModalOpen} 
          onClose={closeModal} 
          title={editingProduct ? "Editar Producto" : "Registrar Nuevo Producto"}
        >
          <form onSubmit={handleSubmit(onSubmitProduct)} className="space-y-4">
            
            <div className="bg-teal-50 text-teal-800 text-xs font-semibold px-3 py-2 rounded-lg border border-teal-200 mb-4">
              Gestionando stock en: {currentStore.name}
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
                autoFocus 
                {...register('sku_barcode')} 
                placeholder="Escanea el código aquí..." 
                className="w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none" 
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Nombre del Producto (Global)</label>
              <input type="text" {...register('name')} placeholder="Ej: Muñeca Articulada Básica" className="w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none" />
              {errors.name && <p className="text-red-500 text-xs mt-1">{errors.name.message}</p>}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Categoría</label>
                <select {...register('category')} className="w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none">
                  <option value="juguetes">Juguetes</option>
                  <option value="ropa">Ropa</option>
                  <option value="otros">Otros</option>
                  <option value="descuento">Descuento</option>
                </select>
                {errors.category && <p className="text-red-500 text-xs mt-1">{errors.category.message}</p>}
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Precio Global ($)</label>
                <input type="number" step="0.01" {...register('price', { valueAsNumber: true })} placeholder="0.00" className="w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none" />
                {errors.price && <p className="text-red-500 text-xs mt-1">{errors.price.message}</p>}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Stock para {currentStore.name}</label>
              <input type="number" {...register('stock', { valueAsNumber: true })} placeholder="0" className="w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none" />
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
        <div className="hidden print:flex flex-row items-center justify-between bg-white" style={{ width: '62mm', height: '29mm', overflow: 'hidden', margin: 0, padding: '1mm' }}>
          <div className="flex items-center justify-center h-full pl-1">
            <p className="text-[8px] font-black text-black tracking-wider uppercase" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
              Ganesha Store
            </p>
          </div>

          <div className="flex flex-col items-center justify-center flex-1 w-full overflow-hidden pr-1">
            <p className="text-[18px] font-black text-black truncate w-full text-center leading-none">
              {promoName.toUpperCase()}
            </p>

            <div className="flex items-baseline gap-2 mt-0.5 mb-0.5">
              {discountPercent > 0 && (
                <p className="text-[12px] line-through text-gray-500 leading-none">${originalPrice.toFixed(2)}</p>
              )}
              <p className="text-[24px] font-black text-black leading-none">${finalPrice.toFixed(2)}</p>
            </div>

            <Barcode value={selectedProduct.sku_barcode} width={1.3} height={24} fontSize={10} margin={0} displayValue={true} />
          </div>
        </div>
      )}
    </>
  );
}