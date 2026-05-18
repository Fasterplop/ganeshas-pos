'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { usePOSStore } from '@/store/usePOSStore';

type PaymentMethod = 'efectivo' | 'zelle' | 'pago_movil' | 'punto_de_venta';

// Nuevos tipos para el descuento
type DiscountType = 'none' | 'percent' | 'fixed';

type NotificationType = {
  message: string;
  type: 'success' | 'error';
} | null;

export default function POSPage() {
  const supabase = createClient();
  const { cart, addToCart, removeFromCart, clearCart, bcvRate } = usePOSStore();
  
  const [docType, setDocType] = useState('V-');
  const [docNumber, setDocNumber] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  
  // Inicializado en null para forzar la selección
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | null>(null);
  const [paymentRef, setPaymentRef] = useState('');
  
  // Estados para el descuento
  const [discountType, setDiscountType] = useState<DiscountType>('none');
  const [discountValue, setDiscountValue] = useState<string>('');

  const [isLoading, setIsLoading] = useState(false);

  const [productSearch, setProductSearch] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);

  const [notification, setNotification] = useState<NotificationType>(null);

  // Cálculos de totales y descuentos
  const subtotalUSD = cart.reduce((acc, item) => acc + (item.price * item.quantity), 0);
  const totalItems = cart.reduce((acc, item) => acc + item.quantity, 0);

  let discountAmount = 0;
  // AHORA: Aplicamos descuento si el método es EFECTIVO o ZELLE
  if ((paymentMethod === 'efectivo' || paymentMethod === 'zelle') && discountValue !== '' && !isNaN(Number(discountValue))) {
    const val = Number(discountValue);
    if (discountType === 'percent') {
      discountAmount = subtotalUSD * (val / 100);
    } else if (discountType === 'fixed') {
      discountAmount = val;
    }
  }

  // Evitamos que el total sea negativo
  const totalUSD = Math.max(0, subtotalUSD - discountAmount);
  const totalVES = totalUSD * bcvRate;

  const showNotification = (message: string, type: 'success' | 'error') => {
    setNotification({ message, type });
    setTimeout(() => {
      setNotification(null);
    }, 4000);
  };

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
    addToCart({ id: product.id, name: product.name, price: product.price, quantity: 1 });
    setProductSearch('');
    setSearchResults([]); 
  };

  const handleDecreaseQuantity = (item: any) => {
    if (item.quantity > 1) {
      addToCart({ ...item, quantity: -1 });
    } else {
      removeFromCart(item.id);
    }
  };

  const handleCheckout = async () => {
    if (cart.length === 0) {
      return showNotification('El carrito está vacío', 'error');
    }
    
    // Validación de método de pago
    if (!paymentMethod) {
      return showNotification('Debes seleccionar un método de pago', 'error');
    }
    
    setIsLoading(true);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('No hay sesión activa');

      let finalCustomerId = null;
      const cleanDocNumber = docNumber.trim();
      const cleanPhone = customerPhone.trim();
      const cleanName = customerName.trim();
      
      const fullDocumentId = cleanDocNumber !== '' ? `${docType}${cleanDocNumber}` : null;

      if (fullDocumentId || cleanPhone !== '' || cleanName !== '') {
        if (!fullDocumentId) {
           throw new Error('Debes ingresar el número de cédula para poder asociar al cliente.');
        }

        const { data: existingCustomer, error: searchError } = await supabase
          .from('customers')
          .select('*')
          .eq('document_id', fullDocumentId)
          .maybeSingle();

        if (searchError) throw new Error('Error al buscar el cliente.');

        if (existingCustomer) {
          finalCustomerId = existingCustomer.document_id;
          const updates: any = {};
          if (cleanName !== '' && existingCustomer.full_name !== cleanName) updates.full_name = cleanName;
          if (cleanPhone !== '' && existingCustomer.phone !== cleanPhone) updates.phone = cleanPhone;

          if (Object.keys(updates).length > 0) {
            const { error: updateError } = await supabase.from('customers').update(updates).eq('document_id', finalCustomerId);
            if (updateError) {
                if (updateError.code === '23505') throw new Error('Este número de teléfono ya está asociado a otro cliente.');
                throw updateError;
            }
          }
        } 
        else {
          finalCustomerId = fullDocumentId;
          const { error: insertError } = await supabase.from('customers').insert({
            document_id: finalCustomerId,
            full_name: cleanName !== '' ? cleanName : `Cliente ${finalCustomerId}`,
            phone: cleanPhone !== '' ? cleanPhone : null,
            total_spent: 0,
            reward_points: 0
          });

          if (insertError) {
             if (insertError.code === '23505') {
                 throw new Error('Ya existe un cliente con esta cédula o teléfono. Revisa los datos.');
             }
             throw new Error('Error al crear el cliente: ' + insertError.message);
          }
        }
      }

      // El total amount guardado será el que ya tiene el descuento aplicado (totalUSD)
      const { data: saleData, error: saleError } = await supabase
        .from('sales')
        .insert({
          cashier_id: user.id,
          customer_id: finalCustomerId, 
          total_amount: totalUSD,
          bcv_rate: bcvRate,
          payment_method: paymentMethod,
          payment_ref: paymentRef.trim() === '' ? null : paymentRef.trim()
        })
        .select()
        .single();

      if (saleError) throw saleError;

      const itemsToInsert = cart.map(item => ({
        sale_id: saleData.id,
        product_id: item.id,
        quantity: item.quantity,
        unit_price: item.price,
        subtotal: item.price * item.quantity // Subtotal sin descuento a nivel de item
      }));

      const { error: itemsError } = await supabase.from('sale_items').insert(itemsToInsert);
      if (itemsError) throw itemsError;

      for (const item of cart) {
        const { data: productData } = await supabase
          .from('products')
          .select('stock') 
          .eq('id', item.id)
          .single();

        if (productData) {
          await supabase
            .from('products')
            .update({ stock: productData.stock - item.quantity })
            .eq('id', item.id);
        }
      }

      if (finalCustomerId) {
         const pointsEarned = Math.floor(totalUSD / 20);

         const { data: custData } = await supabase
           .from('customers')
           .select('total_spent, reward_points')
           .eq('document_id', finalCustomerId)
           .single();
           
         const previousSpent = custData?.total_spent || 0;
         const previousPoints = custData?.reward_points || 0;

         await supabase
           .from('customers')
           .update({ 
             total_spent: previousSpent + totalUSD,
             reward_points: previousPoints + pointsEarned
           })
           .eq('document_id', finalCustomerId);
      }

      showNotification('¡Venta registrada con éxito!', 'success');
      clearCart();
      setDocNumber('');
      setCustomerName('');
      setCustomerPhone('');
      setPaymentRef('');
      setPaymentMethod(null);
      setDiscountType('none');
      setDiscountValue('');

    } catch (error: any) {
      showNotification(error.message, 'error');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="relative font-sans h-auto lg:h-[calc(100vh-6rem)]">
      
      {notification && (
        <div className="fixed top-6 right-6 z-50 animate-fade-in-down">
          <div className={`flex items-center gap-3 px-6 py-4 rounded-xl shadow-lg border ${
            notification.type === 'success' 
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800' 
              : 'bg-red-50 border-red-200 text-red-800'
          }`}>
            <span className="text-2xl">
              {notification.type === 'success' ? '✅' : '⚠️'}
            </span>
            <p className="font-medium">{notification.message}</p>
          </div>
        </div>
      )}

      <div className="flex flex-col lg:flex-row gap-6 pb-10 lg:pb-0 h-full">
        
        <div className="flex-1 bg-white rounded-xl shadow-sm border border-slate-200 flex flex-col overflow-hidden min-h-[600px] lg:min-h-0">
          <div className="p-4 border-b border-slate-200 space-y-4 bg-slate-50 shrink-0">
            <div>
              <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Datos del Cliente (Opcional)</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
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

            <div className="relative">
              <input 
                type="text" 
                value={productSearch}
                onChange={handleSearchChange}
                placeholder="🛒 Busca por nombre o código de barras..." 
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
          </div>

          <div className="flex-1 overflow-y-auto overflow-x-auto">
            <table className="w-full text-left min-w-[450px]">
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
                          <button 
                            onClick={() => handleDecreaseQuantity(item)} 
                            className="w-8 h-8 flex items-center justify-center rounded-full bg-slate-100 text-slate-600 hover:bg-red-100 hover:text-red-600 transition font-bold shrink-0"
                          >
                            −
                          </button>
                          <span className="w-6 text-center font-bold text-slate-800">{item.quantity}</span>
                          <button 
                            onClick={() => addToCart({ ...item, quantity: 1 })} 
                            className="w-8 h-8 flex items-center justify-center rounded-full bg-slate-100 text-slate-600 hover:bg-teal-100 hover:text-teal-700 transition font-bold shrink-0"
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

          <div className="p-4 bg-slate-50 border-t border-slate-200 flex justify-between items-center shrink-0">
            <p className="text-slate-600 font-medium">{totalItems} Artículos</p>
            <div className="text-right flex flex-col items-end">
              {discountAmount > 0 && (
                <p className="text-sm text-red-500 line-through mb-1">${subtotalUSD.toFixed(2)}</p>
              )}
              <div className="flex gap-2 items-baseline">
                <p className="text-sm text-slate-500">Total:</p>
                <p className="text-xl font-bold text-slate-800">${totalUSD.toFixed(2)}</p>
              </div>
            </div>
          </div>
        </div>

        <div className="w-full lg:w-96 flex flex-col gap-6 shrink-0">
          
          <div className="bg-[#0f5c5c] rounded-xl shadow-sm p-6 text-white flex flex-col justify-center items-end shrink-0">
            <p className="text-teal-100 text-sm mb-1">Total a Pagar</p>
            <p className="text-5xl font-bold mb-2">${totalUSD.toFixed(2)}</p>
            {discountAmount > 0 && (
              <p className="text-teal-200 text-sm mb-1 bg-[#0a4545] px-2 py-1 rounded">
                Ahorro: ${discountAmount.toFixed(2)}
              </p>
            )}
            <p className="text-teal-200 text-sm">Bs. {totalVES.toFixed(2)} (Tasa BCV: {bcvRate.toFixed(2)})</p>
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex-1 flex flex-col">
            <h3 className="font-semibold text-slate-800 mb-4">Método de Pago <span className="text-red-500">*</span></h3>
            
            <div className="grid grid-cols-2 gap-3 mb-6">
              <button 
                onClick={() => setPaymentMethod('efectivo')}
                className={`py-3 rounded-lg border flex flex-col items-center gap-2 transition ${paymentMethod === 'efectivo' ? 'bg-[#0f5c5c] text-white border-[#0f5c5c]' : 'bg-white text-slate-600 border-slate-200 hover:border-teal-600'}`}
              >
                <span className="text-xl">💵</span>
                <span className="text-xs font-medium">Efectivo</span>
              </button>
              
              <button 
                onClick={() => setPaymentMethod('punto_de_venta')}
                className={`py-3 rounded-lg border flex flex-col items-center gap-2 transition ${paymentMethod === 'punto_de_venta' ? 'bg-[#0f5c5c] text-white border-[#0f5c5c]' : 'bg-white text-slate-600 border-slate-200 hover:border-teal-600'}`}
              >
                <span className="text-xl">💳</span>
                <span className="text-xs font-medium text-center">Punto de Venta</span>
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

            {/* SECCIÓN DE DESCUENTO AHORA: Visible si es efectivo O zelle */}
            {(paymentMethod === 'efectivo' || paymentMethod === 'zelle') && (
              <div className="mb-6 p-4 bg-slate-50 border border-slate-200 rounded-lg animate-fade-in-down">
                <h4 className="text-sm font-semibold text-slate-700 mb-3">Aplicar Descuento</h4>
                <div className="flex gap-2">
                  <select 
                    value={discountType} 
                    onChange={(e) => {
                      setDiscountType(e.target.value as DiscountType);
                      if (e.target.value === 'none') setDiscountValue('');
                    }}
                    className="p-2 border border-slate-300 rounded-lg bg-white text-slate-800 text-sm outline-none focus:ring-2 focus:ring-teal-600 transition"
                  >
                    <option value="none">Sin descuento</option>
                    <option value="percent">Porcentaje (%)</option>
                    <option value="fixed">Monto ($)</option>
                  </select>
                  
                  {discountType !== 'none' && (
                    <input 
                      type="number" 
                      min="0"
                      step="0.01"
                      value={discountValue}
                      onChange={(e) => setDiscountValue(e.target.value)}
                      placeholder={discountType === 'percent' ? "Ej. 10" : "Ej. 5.00"}
                      className="w-full p-2 border border-slate-300 rounded-lg bg-white text-slate-800 text-sm outline-none focus:ring-2 focus:ring-teal-600 transition"
                    />
                  )}
                </div>
              </div>
            )}

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
              disabled={isLoading || cart.length === 0 || !paymentMethod}
              className="w-full bg-[#0f5c5c] hover:bg-[#0a4545] disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-medium py-4 px-4 rounded-xl transition flex items-center justify-center gap-2 mt-6 text-lg shadow-md shrink-0"
            >
              {isLoading ? 'Procesando...' : '🧾 Finalizar Venta'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}