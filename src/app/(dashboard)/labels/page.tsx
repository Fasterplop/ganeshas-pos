'use client';

import { useState } from 'react';
import Barcode from 'react-barcode'; 

const demoProduct = {
  name: "Muñeca Articulada Básica",
  sku_barcode: "TOY-1049",
  price: 15.00
};

export default function LabelsPage() {
  // 1. Cambiamos el estado para que acepte tanto números como texto vacío ('')
  const [copies, setCopies] = useState<number | string>(1);

  // 2. Creamos una variable segura que siempre sea un número válido para los cálculos matemáticos
  const safeCopies = typeof copies === 'number' ? copies : (parseInt(copies) || 0);

  const handlePrint = () => {
    if (safeCopies > 0) {
      window.print();
    }
  };

  // 3. Manejador inteligente para el input
  const handleCopiesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    
    // Si el usuario borra todo, dejamos el campo vacío para que no se tranque el "0"
    if (val === '') {
      setCopies('');
      return;
    }

    const num = parseInt(val, 10);
    
    // Protegemos contra crasheos limitando a 100 etiquetas máximo
    if (!isNaN(num)) {
      if (num > 100) {
        setCopies(100);
      } else {
        setCopies(num); // Aquí parseInt ya elimina los ceros a la izquierda automáticamente
      }
    }
  };

  const handleIncrement = () => {
    if (safeCopies < 100) setCopies(safeCopies + 1);
  };

  const handleDecrement = () => {
    if (safeCopies > 1) setCopies(safeCopies - 1);
  };

  return (
    <>
      <div className="print:hidden flex flex-col md:flex-row gap-6 h-full">
        {/* Panel Izquierdo: Buscador y Lista */}
        <div className="flex-1 bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <div className="mb-6">
            <input 
              type="text" 
              placeholder="🔍 Buscar Producto para Etiqueta..." 
              className="w-full p-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-teal-600 outline-none"
            />
          </div>
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-700 text-white text-sm">
                <th className="p-3 rounded-tl-lg">Producto</th>
                <th className="p-3">Etiquetas</th>
                <th className="p-3">Tamaño</th>
                <th className="p-3 rounded-tr-lg text-right">Formato</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-slate-100">
                <td className="p-3">
                  <p className="font-medium text-slate-800">{demoProduct.name}</p>
                  <p className="text-sm text-slate-500">SKU: {demoProduct.sku_barcode}</p>
                </td>
                <td className="p-3">
                  <div className="flex items-center gap-3">
                    <button onClick={handleDecrement} className="text-slate-400 hover:text-slate-700 font-bold text-lg">−</button>
                    <span className="w-6 text-center font-medium">{safeCopies}</span>
                    <button onClick={handleIncrement} className="text-slate-400 hover:text-slate-700 font-bold text-lg">+</button>
                  </div>
                </td>
                <td className="p-3 text-slate-600">50x25 mm</td>
                <td className="p-3 text-right font-medium text-slate-800">Térmico</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Panel Derecho: Configuración e Impresión */}
        <div className="w-full md:w-80 space-y-6">
          <div className="bg-[#0f5c5c] text-white p-6 rounded-xl shadow-sm">
            <p className="text-teal-100 text-sm mb-1 text-right">Total Etiquetas</p>
            <p className="text-4xl font-bold text-right mb-4">{safeCopies.toString().padStart(2, '0')}</p>
            <p className="text-xs text-teal-200 text-right">Papel: Térmico Adhesivo</p>
          </div>

          <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
            <h3 className="font-medium text-slate-800 mb-4">Configuración de Impresión</h3>
            <div className="mb-6">
              <label className="text-sm text-slate-600 mb-2 block">Cantidad de Copias (Máx 100)</label>
              <input 
                type="number" 
                value={copies} 
                onChange={handleCopiesChange}
                className="w-full p-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>
            <button 
              onClick={handlePrint}
              disabled={safeCopies === 0}
              className="w-full bg-[#0f5c5c] hover:bg-[#0a4545] text-white font-medium py-3 px-4 rounded-lg transition flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              🖨️ Imprimir Etiquetas
            </button>
          </div>
        </div>
      </div>

      <div className="hidden print:block">
        {Array.from({ length: safeCopies }).map((_, i) => (
          <div key={i} className="flex flex-col items-center justify-center print:break-after-page" style={{ width: '50mm', height: '25mm', overflow: 'hidden' }}>
            <p className="text-[10px] font-bold text-black truncate w-full text-center leading-none mt-1">{demoProduct.name}</p>
            <p className="text-[12px] font-bold text-black leading-none">${demoProduct.price.toFixed(2)}</p>
            
            <Barcode 
              value={demoProduct.sku_barcode} 
              width={1.2} 
              height={30} 
              fontSize={10}
              margin={2}
              displayValue={true}
            />
          </div>
        ))}
      </div>
    </>
  );
}