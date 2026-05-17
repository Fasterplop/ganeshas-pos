'use client';

import { useState } from 'react';
import { usePOSStore } from '@/store/usePOSStore';

export default function BcvModal() {
  const { bcvRate, setBcvRate } = usePOSStore();
  const [inputValue, setInputValue] = useState('');

  // Si la tasa ya es mayor a 0, no mostramos el modal (se desbloquea la app)
  if (bcvRate > 0) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const rate = parseFloat(inputValue);
    if (rate > 0) {
      setBcvRate(rate);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/80 backdrop-blur-sm">
      <div className="bg-white p-8 rounded-xl shadow-2xl max-w-sm w-full">
        <h2 className="text-2xl font-bold text-teal-900 mb-2">Configurar Tasa BCV</h2>
        <p className="text-slate-600 mb-6 text-sm">
          Por favor, ingresa la tasa del día para desbloquear el sistema.
        </p>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Tasa del día (Bs.)
            </label>
            <input
              type="number"
              step="0.01"
              required
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder="Ej. 36.41"
              className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-teal-600 outline-none"
            />
          </div>
          <button
            type="submit"
            className="w-full bg-[#0f5c5c] hover:bg-[#0a4545] text-white font-medium py-2 px-4 rounded-lg transition"
          >
            Guardar y Desbloquear
          </button>
        </form>
      </div>
    </div>
  );
}