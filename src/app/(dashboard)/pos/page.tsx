'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { usePOSStore } from '@/store/usePOSStore';

type PaymentMethod = 'efectivo' | 'zelle' | 'pago_movil';

export default function POSPage() {
  const supabase = createClient();
  const { cart, addToCart, removeFromCart, clearCart, bcvRate } = usePOSStore();
  
  // Estados del Cliente (Directos en el POS)
  const [docType, setDocType] = useState('V-');
  const [docNumber, setDocNumber] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  
  // Estados de la Venta
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('efectivo');
  const [paymentRef, setPaymentRef] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // Estados del Buscador (Dropdown)
  const [productSearch, setProductSearch] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);

  // Cálculos de Total
  const totalUSD = cart.reduce((acc, item) => acc + (item.price * item.quantity), 0);
  const totalVES = totalUSD * bcvRate;
  const totalItems = cart.reduce((acc, item) => acc + item.quantity, 0);

  // --- LÓGICA: Buscador en Tiempo Real ---
  const handleSearchChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setProductSearch(val);

    if (val.trim().length > 1) {
      const { data } = await supabase
        .from('products')
        .select('*')
        .or(`sku_barcode.ilike.%${val}%,name.ilike.%${val}%`)
        .limit(5);
      
      setSearchResults(data || []);
    } else {
      setSearchResults([]);
    }
  };

  const handleAddFromSearch = (product: any) => {
    addToCart({ id: product.id, name: product.name, price: product.price, quantity: 1 });
    setProductSearch('');
    setSearchResults([]); 
  };

  // --- LÓGICA: Disminuir cantidad del carrito ---
  const handleDecreaseQuantity = (item: any) => {
    if (item.quantity > 1) {
      // Mandamos un -1 para que el Store reste la cantidad actual
      addToCart({ ...item, quantity: -1 });
    } else {
      removeFromCart(item.id);
    }
  };

  // --- LÓGICA PRINCIPAL: Finalizar Venta y Gestionar Cliente ---
  const handleCheckout = async () => {
    if (cart.length === 0) return alert('El carrito está vacío');
    setIsLoading(true);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('No hay sesión activa');

      let finalCustomerId = null;
      const cleanDocNumber = docNumber.trim();
      const cleanPhone = customerPhone.trim();
      const cleanName = customerName.trim();
      
      // Armamos la cédula completa (Ej: V-12345678) solo si escribieron números
      const fullDocumentId = cleanDocNumber !== '' ? `${docType}${cleanDocNumber}` : null;

      // 1. GESTIÓN INTELIGENTE DEL CLIENTE (Si hay algún dato ingresado)
      if (fullDocumentId || cleanPhone !== '') {
        let existingCustomer = null;

        // Buscamos si existe por Cédula o por Teléfono
        const { data: searchData } = await supabase
          .from('customers')
          .select('*')
          .or(`${fullDocumentId ? `document_id.eq.${fullDocumentId},` : ''}phone.eq.${cleanPhone}`)
          .limit(1)
          .single();

        if (searchData) {
          existingCustomer = searchData;
          finalCustomerId = existingCustomer.document_id;

          // Si el cliente existe pero escribimos un nuevo nombre o teléfono, lo actualizamos
          const updates: any = {};
          if (cleanName && existingCustomer.full_name !== cleanName) updates.full_name = cleanName;
          if (cleanPhone && existingCustomer.phone !== cleanPhone) updates.phone = cleanPhone;

          if (Object.keys(updates).length > 0) {
            await supabase.from('customers').update(updates).eq('document_id', finalCustomerId);
          }
        } 
        // Si NO existe, pero tenemos cédula y nombre, lo creamos
        else if (fullDocumentId && cleanName) {
          finalCustomerId = fullDocumentId;
          await supabase.from('customers').insert({
            document_id: finalCustomerId,
            full_name: cleanName,
            phone: cleanPhone !== '' ? cleanPhone : null
          });
        } 
        // Si escribieron cédula pero no nombre, pedimos el nombre para poder crearlo
        else if (fullDocumentId && !cleanName) {
          throw new Error('Para registrar un cliente nuevo, debes ingresar su Nombre Completo.');
        }
      }

      // 2. INSERTAR CABECERA DE LA VENTA
      const { data: saleData, error: saleError } = await supabase
        .from('sales')
        .insert({
          cashier_id: user.id,
          customer_id: finalCustomerId, // Será nulo si no se llenó nada
          total_amount: totalUSD,
          bcv_rate: bcvRate,
          payment_method: paymentMethod,
          payment_ref: paymentRef.trim() === '' ? null : paymentRef.trim()
        })
        .select()
        .single();

      if (saleError) throw saleError;

      // 3. INSERTAR DETALLES DE LA VENTA (Productos)
      const itemsToInsert = cart.map(item => ({
        sale_id: saleData.id,
        product_id: item.id,
        quantity: item.quantity,
        unit_price: item.price,
        subtotal: item.price * item.quantity
      }));

      const { error: itemsError } = await supabase.from('sale_items').insert(itemsToInsert);
      if (itemsError) throw itemsError;

      // 4. LIMPIEZA EXITOSA
      alert('¡Venta registrada con éxito!');
      clearCart();
      setDocNumber('');
      setCustomerName('');
      setCustomerPhone('');
      setPaymentRef('');
      setPaymentMethod('efectivo');

    } catch (error: any) {
      alert(error.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col lg:flex-row gap-6 h-[calc(100vh-6rem)] font-sans">
      
      {/* ================= PANEL IZQUIERDO: BUSCADOR Y CARRITO ================= */}
      <div className="flex-1 bg-white rounded-xl shadow-sm border border-slate-200 flex flex-col overflow-hidden">
        
        {/* Cabecera (Registro de Cliente y Buscador de Productos) */}
        <div className="p-4 border-b border-slate-200 space-y-4 bg-slate-50">
          
          {/* Formulario Rápido de Cliente */}
          <div>
            <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Datos del Cliente (Opcional)</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
              
              {/* Cédula con Dropdown */}
              <div className="flex">
                <select 
                  value={docType}
                  onChange={(e) => setDocType(e.target.value)}
                  className="bg-slate-100 border border-slate-300 border-r-0 rounded-l-lg px-2 text-slate-700 outline-none focus:ring-2 focus:ring-teal-600 transition font-medium"
                >
                  <option value="V-">V-</option>
                  <option value="J-">J-</option>
                  <option value="E-">E-</option>
                  <option value="G-">G-</option>
                </select>
                <input 
                  type="text" 
                  value={docNumber}
                  onChange={(e) => setDocNumber(e.target.value)}
                  placeholder="Número de Identificación..." 
                  className="w-full pl-3 pr-4 py-2 border border-slate-300 rounded-r-lg bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-600 transition"
                />
              </div>

              {/* Teléfono */}
              <div>
                <input 
                  type="text" 
                  value={customerPhone}
                  onChange={(e) => setCustomerPhone(e.target.value)}
                  placeholder="📱 Teléfono (Ej: 04141234567)" 
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-600 transition"
                />
              </div>
            </div>

            {/* Nombre Completo */}
            <div>
              <input 
                type="text" 
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="👤 Nombre Completo..." 
                className="w-full px-4 py-2 border border-slate-300 rounded-lg bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-600 transition"
              />
            </div>
          </div>

          <hr className="border-slate-200" />

          {/* Buscador de Productos */}
          <div className="relative">
            <input 
              type="text" 
              value={productSearch}
              onChange={handleSearchChange}
              placeholder="🛒 Busca por nombre o código de barras..." 
              className="w-full pl-4 pr-4 py-3 border-2 border-slate-300 rounded-lg bg-white text-slate-800 focus:outline-none focus:border-teal-600 focus:ring-1 focus:ring-teal-600 transition font-medium"
            />
            {/* Dropdown Visual */}
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
        </div>

        {/* Lista del Carrito */}
        <div className="flex-1 overflow-y-auto">
          <table className="w-full text-left">
            <thead className="bg-slate-600 text-white text-sm sticky top-0 z-0">
              <tr>
                <th className="p-3 pl-4">Producto</th>
                <th className="p-3 text-center">Cant.</th>
                <th className="p-3 text-right">Precio</th>
                <th className="p-3 text-right pr-4">Subtotal</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {cart.length === 0 ? (
                <tr>
                  <td colSpan={4} className="p-10 text-center text-slate-400">
                    <p className="text-4xl mb-2">🛒</p>
                    <p>El carrito está vacío</p>
                  </td>
                </tr>
              ) : (
                cart.map(item => (
                  <tr key={item.id} className="hover:bg-slate-50 transition">
                    <td className="p-3 pl-4">
                      <p className="font-semibold text-slate-800">{item.name}</p>
                    </td>
                    <td className="p-3">
                      <div className="flex items-center justify-center gap-3">
                        {/* Botón Menos (Arreglado) */}
                        <button 
                          onClick={() => handleDecreaseQuantity(item)} 
                          className="w-8 h-8 flex items-center justify-center rounded-full bg-slate-100 text-slate-600 hover:bg-red-100 hover:text-red-600 transition font-bold"
                        >
                          −
                        </button>
                        <span className="w-6 text-center font-bold text-slate-800">{item.quantity}</span>
                        {/* Botón Más */}
                        <button 
                          onClick={() => addToCart({ ...item, quantity: 1 })} 
                          className="w-8 h-8 flex items-center justify-center rounded-full bg-slate-100 text-slate-600 hover:bg-teal-100 hover:text-teal-700 transition font-bold"
                        >
                          +
                        </button>
                      </div>
                    </td>
                    <td className="p-3 text-right text-slate-600">${item.price.toFixed(2)}</td>
                    <td className="p-3 text-right pr-4 font-bold text-slate-800">${(item.price * item.quantity).toFixed(2)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Resumen Inferior */}
        <div className="p-4 bg-slate-50 border-t border-slate-200 flex justify-between items-center">
          <p className="text-slate-600 font-medium">{totalItems} Artículos</p>
          <div className="text-right">
            <p className="text-sm text-slate-500">Total Venta:</p>
            <p className="text-xl font-bold text-slate-800">${totalUSD.toFixed(2)}</p>
          </div>
        </div>
      </div>

      {/* ================= PANEL DERECHO: PAGO Y FINALIZACIÓN ================= */}
      <div className="w-full lg:w-96 flex flex-col gap-6">
        
        {/* Tarjeta de Total */}
        <div className="bg-[#0f5c5c] rounded-xl shadow-sm p-6 text-white flex flex-col justify-center items-end">
          <p className="text-teal-100 text-sm mb-1">Total a Pagar</p>
          <p className="text-5xl font-bold mb-2">${totalUSD.toFixed(2)}</p>
          <p className="text-teal-200 text-sm">Bs. {totalVES.toFixed(2)} (Tasa BCV: {bcvRate.toFixed(2)})</p>
        </div>

        {/* Configuración de Pago */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex-1 flex flex-col">
          <h3 className="font-semibold text-slate-800 mb-4">Método de Pago</h3>
          
          <div className="grid grid-cols-3 gap-3 mb-6">
            <button 
              onClick={() => setPaymentMethod('efectivo')}
              className={`py-3 rounded-lg border flex flex-col items-center gap-2 transition ${paymentMethod === 'efectivo' ? 'bg-[#0f5c5c] text-white border-[#0f5c5c]' : 'bg-white text-slate-600 border-slate-200 hover:border-teal-600'}`}
            >
              <span className="text-xl">💵</span>
              <span className="text-xs font-medium">Efectivo</span>
            </button>
            <button 
              onClick={() => setPaymentMethod('zelle')}
              className={`py-3 rounded-lg border flex flex-col items-center gap-2 transition ${paymentMethod === 'zelle' ? 'bg-[#0f5c5c] text-white border-[#0f5c5c]' : 'bg-white text-slate-600 border-slate-200 hover:border-teal-600'}`}
            >
              <span className="text-xl">🔄</span>
              <span className="text-xs font-medium">Zelle</span>
            </button>
            <button 
              onClick={() => setPaymentMethod('pago_movil')}
              className={`py-3 rounded-lg border flex flex-col items-center gap-2 transition ${paymentMethod === 'pago_movil' ? 'bg-[#0f5c5c] text-white border-[#0f5c5c]' : 'bg-white text-slate-600 border-slate-200 hover:border-teal-600'}`}
            >
              <span className="text-xl">📱</span>
              <span className="text-xs font-medium">Pago Móvil</span>
            </button>
          </div>

          <div className="mb-auto">
            <label className="block text-sm text-slate-500 mb-2">
              Referencia de Transacción (Opcional)
            </label>
            <input 
              type="text" 
              value={paymentRef}
              onChange={(e) => setPaymentRef(e.target.value)}
              placeholder="Ej. 12345678" 
              className="w-full p-3 border border-slate-300 rounded-lg bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-600 transition"
            />
          </div>

          <button 
            onClick={handleCheckout}
            disabled={isLoading || cart.length === 0}
            className="w-full bg-[#0f5c5c] hover:bg-[#0a4545] disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-medium py-4 px-4 rounded-xl transition flex items-center justify-center gap-2 mt-6 text-lg shadow-md"
          >
            {isLoading ? 'Procesando...' : '🧾 Finalizar Venta'}
          </button>
        </div>
      </div>
    </div>
  );
}