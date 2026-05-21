'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { createClient } from '@/lib/supabase/client';
import Modal from '@/components/Modal';
import Barcode from 'react-barcode';

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
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [userRole, setUserRole] = useState<string | null>(null);
  
  const [searchTerm, setSearchTerm] = useState('');
  
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  
  // NUEVO: Estado para manejar el error del formulario visualmente
  const [formError, setFormError] = useState<string | null>(null);
  
  const [promoName, setPromoName] = useState('Liquidación');
  const [discountPercent, setDiscountPercent] = useState(0);

  const supabase = createClient();

  const { register, handleSubmit, reset, formState: { errors } } = useForm<ProductFormValues>({
    resolver: zodResolver(productSchema),
    defaultValues: { stock: 0, sku_barcode: '' }
  });

  async function fetchData() {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
      if (profile) setUserRole(profile.role);
    }

    const { data } = await supabase.from('products').select('*').eq('is_active', true).order('name');
    if (data) setProducts(data);
    setLoading(false);
  }

  useEffect(() => {
    fetchData();
  }, []);

  const onSubmitProduct = async (data: ProductFormValues) => {
    setFormError(null); // Limpiamos cualquier error previo al intentar guardar

    let finalSku = data.sku_barcode?.trim();
    if (!finalSku) {
      const categoryPrefix = data.category.substring(0, 3).toUpperCase();
      const uniqueNumber = Math.floor(100000 + Math.random() * 900000);
      finalSku = `${categoryPrefix}-${uniqueNumber}`;
    }

    if (editingProduct) {
      const { error } = await supabase.from('products').update({ ...data, sku_barcode: finalSku }).eq('id', editingProduct.id);
      
      if (error) {
        // 23505 es el código de Supabase/PostgreSQL para "Violación de restricción única"
        if (error.code === '23505') {
          setFormError('⚠️ Ya existe un producto registrado con este código de barras.');
        } else {
          setFormError('Error al actualizar: ' + error.message);
        }
        return; // Detenemos la ejecución para que el modal no se cierre
      }
    } else {
      const { error } = await supabase.from('products').insert([{ ...data, sku_barcode: finalSku }]);
      
      if (error) {
        if (error.code === '23505') {
          setFormError('⚠️ Ya existe un producto registrado con este código de barras.');
        } else {
          setFormError('Error al registrar: ' + error.message);
        }
        return; // Detenemos la ejecución para que el modal no se cierre
      }
    }

    closeModal();
    fetchData();
  };

 const handleDelete = async (e: React.MouseEvent, id: string) => {
  e.stopPropagation(); 
  
  if (window.confirm('¿Estás seguro de que deseas eliminar este producto del inventario?')) {
    // En lugar de .delete(), usamos .update() para cambiar is_active a false
    const { error } = await supabase
      .from('products')
      .update({ is_active: false })
      .eq('id', id);

    if (error) {
      alert('Error al eliminar (ocultar) el producto: ' + error.message);
      return;
    }

    // Si se ocultó correctamente, limpiamos la selección y recargamos
    if (selectedProduct?.id === id) setSelectedProduct(null);
    fetchData();
  }
};

  const handleEdit = (e: React.MouseEvent, product: Product) => {
    e.stopPropagation(); 
    setEditingProduct(product);
    setFormError(null); // Limpiamos errores al abrir edición
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
    setFormError(null); // Limpiamos errores al cerrar
    reset({ sku_barcode: '', name: '', category: 'juguetes', price: 0, stock: 0 });
  };

  const handleExportCSV = () => {
    if (products.length === 0) return;
    const headers = ['SKU', 'Nombre', 'Categoria', 'Precio', 'Stock'];
    const csvContent = [
      headers.join(','),
      ...products.map(p => `"${p.sku_barcode}","${p.name}","${p.category}",${p.price},${p.stock}`)
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'inventario_ganeshas.csv';
    link.click();
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

  return (
    <>
      <div className="print:hidden flex flex-col md:flex-row gap-6 h-full font-sans">
        
        {/* Sección Izquierda: Tabla de Productos */}
        <div className="flex-1 bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex flex-col">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 gap-4">
            
            <div className="relative w-full md:w-96">
              <input 
                type="text" 
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="🔍 Buscar código o nombre..." 
                className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-600 transition"
              />
            </div>

            <div className="flex gap-2 w-full md:w-auto">
              <button onClick={handleExportCSV} className="flex-1 md:flex-none px-4 py-2 text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200 transition cursor-pointer">
                Exportar
              </button>
              {userRole === 'owner' && (
                <button onClick={() => setIsModalOpen(true)} className="flex-1 md:flex-none px-4 py-2 text-white bg-[#0f5c5c] rounded-lg hover:bg-[#0a4545] transition whitespace-nowrap shadow-sm cursor-pointer">
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
                  <th className="p-3">Categoria</th>
                  <th className="p-3 text-right">Precio</th>
                  <th className="p-3 text-right">Stock</th>
                  {userRole === 'owner' && <th className="p-3 text-center rounded-tr-lg">Acciones</th>}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={userRole === 'owner' ? 6 : 5} className="p-8 text-center text-slate-500">Cargando inventario...</td></tr>
                ) : filteredProducts.length === 0 ? (
                  <tr><td colSpan={userRole === 'owner' ? 6 : 5} className="p-8 text-center text-slate-500">No se encontraron productos.</td></tr>
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
                      <td className="p-3 text-right font-bold text-emerald-600">{product.stock}</td>
                      
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
                            title="Eliminar"
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

        {/* Sección Derecha: Panel Descuento Rápido */}
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
                <p className="text-sm font-bold text-slate-800 leading-tight">{selectedProduct.name}</p>
                <p className="text-xs text-slate-500 font-mono">{selectedProduct.sku_barcode}</p>
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-500">Nombre de Promoción</label>
                <input 
                  type="text" 
                  value={promoName}
                  onChange={(e) => setPromoName(e.target.value)}
                  className="w-full p-2 border border-slate-300 bg-white text-slate-800 rounded-md mt-1 focus:outline-none focus:ring-2 focus:ring-teal-600 transition" 
                />
              </div>
              <div className="flex gap-4">
                <div className="flex-1">
                  <label className="text-xs font-semibold text-slate-500">Precio Original</label>
                  <input 
                    type="text" 
                    disabled 
                    value={`$ ${originalPrice.toFixed(2)}`}
                    className="w-full p-2 border border-slate-200 bg-slate-50 text-slate-500 rounded-md mt-1" 
                  />
                </div>
                <div className="flex-1">
                  <label className="text-xs font-semibold text-slate-500">% Descuento</label>
                  <input 
                    type="number" 
                    value={discountPercent}
                    onChange={(e) => setDiscountPercent(Number(e.target.value))}
                    className="w-full p-2 border border-slate-300 bg-white text-slate-800 rounded-md mt-1 focus:outline-none focus:ring-2 focus:ring-teal-600 transition" 
                  />
                </div>
              </div>
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

      {/* ================= MODAL: AÑADIR / EDITAR PRODUCTO ================= */}
      <div className="print:hidden">
        <Modal 
          isOpen={isModalOpen} 
          onClose={closeModal} 
          title={editingProduct ? "Editar Producto" : "Registrar Nuevo Producto"}
        >
          <form onSubmit={handleSubmit(onSubmitProduct)} className="space-y-4">
            
            {/* Alerta Visual de Error Frontend */}
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
              <label className="block text-sm font-medium text-slate-700 mb-1">Nombre del Producto</label>
              <input type="text" {...register('name')} placeholder="Ej: Muñeca Articulada Básica" className="w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none" />
              {errors.name && <p className="text-red-500 text-xs mt-1">{errors.name.message}</p>}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Categoria</label>
                <select {...register('category')} className="w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none">
                  <option value="juguetes">Juguetes</option>
                  <option value="ropa">Ropa</option>
                  <option value="otros">Otros</option>
                  <option value="descuento">Descuento</option>
                </select>
                {errors.category && <p className="text-red-500 text-xs mt-1">{errors.category.message}</p>}
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Precio ($)</label>
                <input type="number" step="0.01" {...register('price', { valueAsNumber: true })} placeholder="0.00" className="w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none" />
                {errors.price && <p className="text-red-500 text-xs mt-1">{errors.price.message}</p>}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Stock</label>
              <input type="number" {...register('stock', { valueAsNumber: true })} placeholder="0" className="w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none" />
              {errors.stock && <p className="text-red-500 text-xs mt-1">{errors.stock.message}</p>}
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
              <button type="button" onClick={closeModal} className="px-4 py-2 border border-slate-300 rounded-lg font-medium text-slate-700 hover:bg-slate-50 transition cursor-pointer">Cancelar</button>
              <button type="submit" className="px-4 py-2 bg-[#0f5c5c] text-white rounded-lg font-medium hover:bg-[#0a4545] transition cursor-pointer">
                {editingProduct ? "Guardar Cambios" : "Guardar Producto"}
              </button>
            </div>
          </form>
        </Modal>
      </div>

      {/* ================= VISTA DE IMPRESIÓN (Optimizada para Brother DK-1209: 62mm x 29mm) ================= */}
      {/* ================= VISTA DE IMPRESIÓN (Optimizada para Brother DK-1209: 62mm x 29mm) ================= */}
      {selectedProduct && (
        <div className="hidden print:flex flex-row items-center justify-between bg-white" style={{ width: '62mm', height: '29mm', overflow: 'hidden', margin: 0, padding: '1mm' }}>
          
          {/* Texto Vertical: Nombre de la tienda */}
          <div className="flex items-center justify-center h-full pl-1">
            <p className="text-[9px] font-black text-black tracking-widest uppercase" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
              Ganesha Store
            </p>
          </div>

          {/* Contenido Principal */}
          <div className="flex flex-col items-center justify-center flex-1 w-full overflow-hidden pr-1">
            <p className="text-[15px] font-black text-black truncate w-full text-center leading-none">
              {promoName.toUpperCase()}
            </p>

            <div className="flex items-baseline gap-2 mt-0.5 mb-0.5">
              <p className="text-[12px] line-through text-gray-500 leading-none">${originalPrice.toFixed(2)}</p>
              <p className="text-[26px] font-black text-black leading-none">${finalPrice.toFixed(2)}</p>
            </div>

            <Barcode 
              value={selectedProduct.sku_barcode} 
              width={1.3} 
              height={24} 
              fontSize={10} 
              margin={0} 
              displayValue={true} 
            />
          </div>
        </div>
      )}
    </>
  );
}