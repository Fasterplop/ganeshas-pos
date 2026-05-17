'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { createClient } from '@/lib/supabase/client';
import Modal from '@/components/Modal';
import Barcode from 'react-barcode';

// 1. Esquema de validación: Eliminamos 'sku_barcode' porque lo generaremos automáticamente
const productSchema = z.object({
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
  const [searchTerm, setSearchTerm] = useState('');
  
  // Estado para Modal y Selección
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  
  // Estados para el Descuento Rápido
  const [promoName, setPromoName] = useState('Liquidación de Verano');
  const [discountPercent, setDiscountPercent] = useState(20);

  const supabase = createClient();

  const { register, handleSubmit, reset, formState: { errors } } = useForm<ProductFormValues>({
    resolver: zodResolver(productSchema),
    defaultValues: { stock: 0 }
  });

  async function fetchProducts() {
    setLoading(true);
    const { data } = await supabase.from('products').select('*').order('name');
    if (data) setProducts(data);
    setLoading(false);
  }

  useEffect(() => {
    fetchProducts();
  }, []);

  // Función: Añadir Producto con Generación Automática de SKU
  const onAddProductSubmit = async (data: ProductFormValues) => {
    // Generador Inteligente de SKU: 3 Letras de la Categoría + 6 Números Aleatorios
    const categoryPrefix = data.category.substring(0, 3).toUpperCase();
    const uniqueNumber = Math.floor(100000 + Math.random() * 900000);
    const generatedSku = `${categoryPrefix}-${uniqueNumber}`;

    // Insertamos los datos del formulario MÁS el SKU generado automáticamente
    const { error } = await supabase.from('products').insert([
      { ...data, sku_barcode: generatedSku }
    ]);

    if (error) {
      alert('Error al registrar producto: ' + error.message);
    } else {
      setIsAddModalOpen(false);
      reset();
      fetchProducts();
    }
  };

  // Función: Exportar a CSV
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

  // Función: Imprimir Etiqueta
  const handlePrint = () => {
    if (!selectedProduct) return alert('Selecciona un producto primero');
    window.print();
  };

  const filteredProducts = products.filter(p =>
    p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    p.sku_barcode.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // Cálculo del precio final con descuento
  const originalPrice = selectedProduct?.price || 0;
  const finalPrice = originalPrice - (originalPrice * (discountPercent / 100));

  return (
    <>
      <div className="print:hidden flex flex-col md:flex-row gap-6 h-full font-sans">
        {/* Sección Izquierda: Tabla de Productos */}
        <div className="flex-1 bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex flex-col">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 gap-4">
            <div className="relative w-full md:w-64">
              <input 
                type="text" 
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="🔍 Buscar SKU, Nombre..." 
                className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-600 transition"
              />
            </div>
            <div className="flex gap-2 w-full md:w-auto">
              <button onClick={handleExportCSV} className="flex-1 md:flex-none px-4 py-2 text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200 transition">
                Exportar
              </button>
              <button onClick={() => setIsAddModalOpen(true)} className="flex-1 md:flex-none px-4 py-2 text-white bg-[#0f5c5c] rounded-lg hover:bg-[#0a4545] transition whitespace-nowrap">
                + Añadir Producto
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-700 text-white text-sm">
                  <th className="p-3 rounded-tl-lg">SKU</th>
                  <th className="p-3">Nombre</th>
                  <th className="p-3">Categoria</th>
                  <th className="p-3 rounded-tr-lg text-right">Stock</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={4} className="p-4 text-center text-slate-500">Cargando inventario...</td></tr>
                ) : filteredProducts.length === 0 ? (
                  <tr><td colSpan={4} className="p-4 text-center text-slate-500">No se encontraron productos.</td></tr>
                ) : (
                  filteredProducts.map((product) => (
                    <tr 
                      key={product.id} 
                      onClick={() => setSelectedProduct(product)}
                      className={`border-b border-slate-100 cursor-pointer transition ${selectedProduct?.id === product.id ? 'bg-teal-50' : 'hover:bg-slate-50'}`}
                    >
                      <td className="p-3 text-slate-500 font-mono text-sm">{product.sku_barcode}</td>
                      <td className="p-3 font-medium text-slate-800">{product.name}</td>
                      <td className="p-3"><span className="bg-blue-50 text-blue-700 px-2 py-1 rounded-full text-xs capitalize">{product.category}</span></td>
                      <td className="p-3 text-right font-medium text-emerald-600">{product.stock}</td>
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
              Haz clic en un producto de la tabla para generar su etiqueta de descuento.
            </div>
          ) : (
            <div className="space-y-4 animate-in fade-in">
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
                className="w-full mt-6 bg-[#0f5c5c] text-white py-3 rounded-lg font-medium hover:bg-[#0a4545] transition flex justify-center items-center gap-2"
              >
                🖨️ Imprimir Etiqueta
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ================= MODAL: AÑADIR NUEVO PRODUCTO ================= */}
      <div className="print:hidden">
        <Modal isOpen={isAddModalOpen} onClose={() => { setIsAddModalOpen(false); reset(); }} title="Registrar Nuevo Producto">
          <form onSubmit={handleSubmit(onAddProductSubmit)} className="space-y-4">
            
            {/* El campo SKU ha sido eliminado completamente de la interfaz visual */}

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
              <label className="block text-sm font-medium text-slate-700 mb-1">Stock Inicial</label>
              <input type="number" {...register('stock', { valueAsNumber: true })} placeholder="0" className="w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none" />
              {errors.stock && <p className="text-red-500 text-xs mt-1">{errors.stock.message}</p>}
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
              <button type="button" onClick={() => { setIsAddModalOpen(false); reset(); }} className="px-4 py-2 border border-slate-300 rounded-lg font-medium text-slate-700 hover:bg-slate-50 transition">Cancelar</button>
              <button type="submit" className="px-4 py-2 bg-[#0f5c5c] text-white rounded-lg font-medium hover:bg-[#0a4545] transition">Guardar Producto</button>
            </div>
          </form>
        </Modal>
      </div>

      {/* ================= VISTA DE IMPRESIÓN (Etiqueta de Descuento) ================= */}
      {selectedProduct && (
        <div className="hidden print:flex flex-col items-center justify-center" style={{ width: '50mm', height: '25mm', overflow: 'hidden' }}>
          <p className="text-[9px] font-bold text-black truncate w-full text-center leading-none mt-1">{promoName.toUpperCase()}</p>
          <div className="flex items-baseline gap-1">
            <p className="text-[9px] line-through text-gray-500 leading-none">${originalPrice.toFixed(2)}</p>
            <p className="text-[12px] font-bold text-black leading-none">${finalPrice.toFixed(2)}</p>
          </div>
          <Barcode value={selectedProduct.sku_barcode} width={1.2} height={25} fontSize={10} margin={2} displayValue={true} />
        </div>
      )}
    </>
  );
}