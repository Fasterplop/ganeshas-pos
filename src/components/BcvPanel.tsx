'use client';

import { useState } from 'react';
import { usePOSStore } from '@/store/usePOSStore';

export default function BcvPanel() {
  const { bcvRate, setBcvRate } = usePOSStore();
  const [isEditing, setIsEditing] = useState(false);
  const [tempRate, setTempRate] = useState(bcvRate.toString());

  const handleSave = () => {
    const rate = parseFloat(tempRate);
    if (rate > 0) {
      setBcvRate(rate);
      setIsEditing(false);
    }
  };

  return (
    <div className="bg-teal-50 border border-teal-100 rounded-lg p-4 flex items-center justify-between mb-6 shadow-sm">
      <div>
        <h3 className="text-sm font-semibold text-teal-900">Tasa BCV Actual</h3>
        {!isEditing ? (
          <p className="text-2xl font-bold text-teal-700">Bs. {bcvRate.toFixed(2)}</p>
        ) : (
          <input
            type="number"
            step="0.01"
            autoFocus
            value={tempRate}
            onChange={(e) => setTempRate(e.target.value)}
            className="text-xl font-bold text-teal-900 bg-white border border-teal-300 rounded px-2 w-32 mt-1 focus:outline-none focus:ring-2 focus:ring-teal-500"
          />
        )}
      </div>

      <div>
        {!isEditing ? (
          <button
            onClick={() => {
              setTempRate(bcvRate.toString());
              setIsEditing(true);
            }}
            className="text-sm bg-white border border-teal-600 text-teal-700 px-3 py-1.5 rounded-md hover:bg-teal-600 hover:text-white transition"
          >
            Editar Tasa
          </button>
        ) : (
          <button
            onClick={handleSave}
            className="text-sm bg-teal-700 text-white px-3 py-1.5 rounded-md hover:bg-teal-800 transition"
          >
            Guardar
          </button>
        )}
      </div>
    </div>
  );
}