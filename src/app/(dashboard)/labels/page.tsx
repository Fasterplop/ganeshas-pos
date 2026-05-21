'use client';

import { useState } from 'react';
import Barcode from 'react-barcode'; 
import { createClient } from '@/lib/supabase/client';

interface LabelProduct {
  id: string;
  name: string;
  sku_barcode: string;
  price: number;
  copies: number | string;
}

export default function LabelsPage() {
  const supabase = createClient();

  // Estados para el buscador
  const [productSearch, setProductSearch] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);

  // Estado para la lista de productos a imprimir
  const [selectedProducts, setSelectedProducts] = useState<LabelProduct[]>([]);

  // Configuración global del lote (Descuento porcentual)
  const [discountPercent, setDiscountPercent] = useState(0);

  // 1. LÓGICA DE BÚSQUEDA TIPO DROPDOWN
  const handleSearchChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setProductSearch(val);

    if (val.trim().length > 1) {
      const { data } = await supabase
        .from('products')
        .select('*')
        .or(`sku_barcode.ilike.%${val}%,name.ilike.%${val}%`)
        .limit(50);
      
      setSearchResults(data || []);
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
        copies: 1
      }]);
    }
    setProductSearch('');
    setSearchResults([]); 
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

  const handlePrint = () => {
    if (totalLabelsToPrint > 0) {
      window.print();
    }
  };

  return (
    <>
      <div className="print:hidden flex flex-col md:flex-row gap-6 h-full font-sans">
        
        {/* Panel Izquierdo: Buscador y Lista de Productos */}
        <div className="flex-1 bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex flex-col">
          
          {/* BUSCADOR CON DROPDOWN (Estilo POS) */}
          <div className="relative mb-6">
            <input 
              type="text" 
              value={productSearch}
              onChange={handleSearchChange}
              placeholder="🔍 Buscar por nombre o código de barras para añadir a impresión..." 
              className="w-full pl-4 pr-4 py-3 border-2 border-slate-300 rounded-lg bg-white text-slate-800 focus:outline-none focus:border-teal-600 focus:ring-1 focus:ring-teal-600 transition font-medium"
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
                      <p className="text-xs text-slate-500">SKU: {p.sku_barcode}</p>
                    </div>
                    <p className="font-bold text-teal-700">${p.price.toFixed(2)}</p>
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
                  <th className="p-3 text-right">Precio Base</th>
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
                      <td className="p-3 text-right text-slate-600 font-medium">${product.price.toFixed(2)}</td>
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
                <p className="text-[10px] text-slate-400 mt-1">Si dejas 0%, imprimirá el precio base del producto.</p>
              </div>
            </div>

            <div className="border-t border-slate-100 pt-4 mb-4">
              <p className="text-slate-500 text-xs mb-1 text-right">Total a Imprimir</p>
              <p className="text-4xl font-bold text-slate-800 text-right mb-1">{totalLabelsToPrint}</p>
              <p className="text-[10px] text-slate-400 text-right">Formato: Brother DK-1209 (62x29 mm)</p>
            </div>

            <button 
              onClick={handlePrint}
              disabled={totalLabelsToPrint === 0}
              className="w-full bg-[#0f5c5c] hover:bg-[#0a4545] text-white font-medium py-3 px-4 rounded-lg transition flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              🖨️ Imprimir Todo
            </button>
          </div>
        </div>
      </div>

     {/* ================= VISTA DE IMPRESIÓN ================= */}
      <div className="hidden print:block">
        {selectedProducts.flatMap(product => {
          const copiesNum = getSafeCopies(product.copies);
          const originalPrice = product.price;
          const finalPrice = originalPrice - (originalPrice * (discountPercent / 100));

          return Array.from({ length: copiesNum }).map((_, i) => (
            <div 
              key={`${product.id}-${i}`} 
              className="flex flex-row items-center justify-between bg-white print:break-after-page" 
              style={{ width: '62mm', height: '29mm', overflow: 'hidden', margin: 0, padding: '1mm' }}
            >
              {/* Texto Vertical: Nombre de la tienda */}
              <div className="flex items-center justify-center h-full pl-1">
                <p className="text-[9px] font-black text-black tracking-widest uppercase" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
                  Ganesha Store
                </p>
              </div>

             {/* Contenido Principal */}
              <div className="flex flex-col items-center justify-center flex-1 w-full overflow-hidden pr-1">
                {/* Texto superior: Nombre del producto - Tamaño aumentado */}
                <p className="text-[18px] font-black text-black truncate w-full text-center leading-none">
                  {product.name.toUpperCase()}
                </p>
                
                <div className="flex items-baseline gap-2 mt-0.5 mb-0.5">
                  {discountPercent > 0 && (
                    <p className="text-[12px] line-through text-gray-500 leading-none">${originalPrice.toFixed(2)}</p>
                  )}
                  <p className="text-[24px] font-black text-black leading-none">${finalPrice.toFixed(2)}</p>
                </div>

                <Barcode 
                  value={product.sku_barcode} 
                  width={1.3} 
                  height={24} 
                  fontSize={10} 
                  margin={0} 
                  displayValue={true} 
                />
              </div>
            </div>
          ));
        })}
      </div>
    </>
  );
}