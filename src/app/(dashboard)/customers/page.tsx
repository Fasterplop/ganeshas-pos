'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { createClient } from '@/lib/supabase/client';
import Modal from '@/components/Modal';

// 1. Esquema de validación con Zod
const customerSchema = z.object({
  document_id: z.string().min(5, { message: 'La cédula debe tener al menos 5 caracteres' }),
  full_name: z.string().min(3, { message: 'El nombre completo debe tener al menos 3 caracteres' }),
  phone: z.string().min(7, { message: 'El teléfono debe tener al menos 7 dígitos' }),
});

type CustomerFormValues = z.infer<typeof customerSchema>;

interface Customer {
  document_id: string;
  full_name: string;
  phone: string | null;
  total_spent: number;
  reward_points: number;
  created_at: string;
  sales?: { created_at: string }[]; // Relación mapeada para la última compra
}

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  
  // Control de los Modales Reutilizables
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isViewModalOpen, setIsViewModalOpen] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);

  // Estados para el historial detallado del cliente seleccionado (Modal)
  const [customerSales, setCustomerSales] = useState<any[]>([]);
  const [loadingSales, setLoadingSales] = useState(false);

  const supabase = createClient();

  // Configuración del formulario con React Hook Form
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CustomerFormValues>({
    resolver: zodResolver(customerSchema),
  });

  // Cargar lista de clientes e incluir sus ventas de forma relacional
  async function fetchCustomers() {
    setLoading(true);
    const { data } = await supabase
      .from('customers')
      .select(`
        *,
        sales (
          created_at
        )
      `)
      .order('created_at', { ascending: false });
    
    if (data) {
      // Ordenamos las fechas internas por código para asegurar que la primera posición sea la más reciente
      const orderedData = data.map((customer: any) => {
        if (customer.sales && customer.sales.length > 0) {
          customer.sales.sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        }
        return customer;
      });
      setCustomers(orderedData);
    }
    setLoading(false);
  }

  useEffect(() => {
    fetchCustomers();
  }, []);

  // Al hacer clic en un cliente, abrimos el modal y buscamos su historial detallado completo
  const handleRowClick = async (customer: Customer) => {
    setSelectedCustomer(customer);
    setIsViewModalOpen(true);
    setLoadingSales(true);

    const { data, error } = await supabase
      .from('sales')
      .select(`
        id,
        created_at,
        total_amount,
        sale_items (
          quantity,
          products (
            name
          )
        )
      `)
      .eq('customer_id', customer.document_id)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching sales:', error);
      setCustomerSales([]);
    } else if (data) {
      setCustomerSales(data);
    }
    
    setLoadingSales(false);
  };

  // Guardar el cliente
  const onAddCustomerSubmit = async (data: CustomerFormValues) => {
    const { error } = await supabase.from('customers').insert([
      {
        document_id: data.document_id,
        full_name: data.full_name,
        phone: data.phone,
      },
    ]);

    if (error) {
      alert('Error al registrar el cliente: ' + error.message);
    } else {
      setIsAddModalOpen(false);
      reset();
      fetchCustomers();
    }
  };

  // Buscador en tiempo real por nombre, cédula o teléfono
  const filteredCustomers = customers.filter(customer =>
    customer.full_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    customer.document_id.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (customer.phone && customer.phone.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  // Cálculos dinámicos en base al historial real de compras para los KPIs del Modal
  const totalCompras = customerSales.length;
  const totalGastadoReal = customerSales.reduce((acc, sale) => acc + Number(sale.total_amount), 0);
  const promedioCompra = totalCompras > 0 ? (totalGastadoReal / totalCompras) : 0;

  return (
    <div className="h-full flex flex-col font-sans">
      {/* Encabezado */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Gestión de Clientes</h1>
          <p className="text-slate-500 text-sm">Administra la información de tus clientes y revisa sus historiales de compra.</p>
        </div>
        <div className="flex gap-4 w-full md:w-auto">
          <input 
            type="text" 
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="🔍 Buscar por cédula, nombre o teléfono..." 
            className="w-full md:w-[450px] px-4 py-2 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none transition"
          />
          <button 
            onClick={() => setIsAddModalOpen(true)}
            className="bg-[#0f5c5c] text-white px-4 py-2 rounded-lg font-medium hover:bg-[#0a4545] transition whitespace-nowrap"
          >
            + Añadir Cliente
          </button>
        </div>
      </div>

      {/* Tabla Principal */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden flex-1">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-700 text-white text-sm">
                <th className="p-4">Cédula / Documento</th>
                <th className="p-4">Nombre Completo</th>
                <th className="p-4">Teléfono</th>
                <th className="p-4">Última Compra</th>
                <th className="p-4 text-right">Puntos</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={5} className="p-4 text-center text-slate-500">Cargando clientes...</td></tr>
              ) : filteredCustomers.length === 0 ? (
                <tr><td colSpan={5} className="p-4 text-center text-slate-500">No se encontraron clientes.</td></tr>
              ) : (
                filteredCustomers.map((customer) => (
                  <tr 
                    key={customer.document_id} 
                    onClick={() => handleRowClick(customer)}
                    className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer transition"
                  >
                    <td className="p-4 text-slate-600 font-mono text-sm">{customer.document_id}</td>
                    <td className="p-4 font-semibold text-slate-800">{customer.full_name}</td>
                    <td className="p-4 text-slate-500 text-sm">{customer.phone || 'No registrado'}</td>
                    <td className="p-4 text-slate-500 text-sm">
                      {/* Renderizado en tiempo real de la fecha de última compra */}
                      {customer.sales && customer.sales.length > 0
                        ? new Date(customer.sales[0].created_at).toLocaleDateString('es-VE', { 
                            day: '2-digit', month: 'short', year: 'numeric' 
                          })
                        : 'Sin compras'}
                    </td>
                    <td className="p-4 text-right font-bold text-teal-700">{customer.reward_points}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ================= MODAL 1: AÑADIR NUEVO CLIENTE ================= */}
      <Modal 
        isOpen={isAddModalOpen} 
        onClose={() => { setIsAddModalOpen(false); reset(); }}
        title="Registrar Nuevo Cliente"
      >
        <form onSubmit={handleSubmit(onAddCustomerSubmit)} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Cédula o Identificación (V-/J-)</label>
            <input 
              type="text"
              {...register('document_id')}
              placeholder="Ej: V12345678"
              className="w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none"
            />
            {errors.document_id && <p className="text-red-500 text-xs mt-1">{errors.document_id.message}</p>}
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Nombre Completo</label>
            <input 
              type="text"
              {...register('full_name')}
              placeholder="Ej: Carlos Mendoza"
              className="w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none"
            />
            {errors.full_name && <p className="text-red-500 text-xs mt-1">{errors.full_name.message}</p>}
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Número de Teléfono</label>
            <input 
              type="text"
              {...register('phone')}
              placeholder="Ej: 04141234567"
              className="w-full p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none"
            />
            {errors.phone && <p className="text-red-500 text-xs mt-1">{errors.phone.message}</p>}
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
            <button 
              type="button"
              onClick={() => { setIsAddModalOpen(false); reset(); }}
              className="px-4 py-2 border border-slate-300 rounded-lg font-medium text-slate-700 hover:bg-slate-50 transition"
            >
              Cancelar
            </button>
            <button 
              type="submit"
              className="px-4 py-2 bg-[#0f5c5c] text-white rounded-lg font-medium hover:bg-[#0a4545] transition"
            >
              Guardar Cliente
            </button>
          </div>
        </form>
      </Modal>

      {/* ================= MODAL 2: HISTORIAL Y DETALLES ================= */}
      <Modal 
        isOpen={isViewModalOpen} 
        onClose={() => setIsViewModalOpen(false)}
        title="Detalles del Cliente"
      >
        {selectedCustomer && (
          <div className="space-y-6">
            <div className="flex items-center gap-4 border-b border-slate-100 pb-4">
              <div className="w-12 h-12 rounded-full bg-teal-700 text-white flex items-center justify-center font-bold text-xl">
                {selectedCustomer.full_name.substring(0, 2).toUpperCase()}
              </div>
              <div>
                <h3 className="text-xl font-bold text-slate-800">{selectedCustomer.full_name}</h3>
                <p className="text-sm text-slate-500">{selectedCustomer.document_id} • Tel: {selectedCustomer.phone || 'No registrado'}</p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
              <div className="border border-slate-200 p-4 rounded-lg bg-slate-50">
                <p className="text-xs font-bold text-slate-500 tracking-wider mb-1">TOTAL GASTADO</p>
                <p className="text-2xl font-bold text-slate-800">
                  ${totalGastadoReal > 0 ? totalGastadoReal.toFixed(2) : (selectedCustomer.total_spent || 0).toFixed(2)}
                </p>
              </div>

              <div className="border border-slate-200 p-4 rounded-lg bg-slate-50">
                <p className="text-xs font-bold text-slate-500 tracking-wider mb-1">PUNTOS</p>
                <div className="flex items-center gap-2">
                  <p className="text-2xl font-bold text-teal-600">{selectedCustomer.reward_points || 0}</p>
                  <span className="text-teal-600">✪</span>
                </div>
              </div> 

              <div className="border border-slate-200 p-4 rounded-lg bg-slate-50">
                <p className="text-xs font-bold text-slate-500 tracking-wider mb-1">TOTAL COMPRAS</p>
                <p className="text-2xl font-bold text-slate-800">{loadingSales ? '-' : totalCompras}</p> 
              </div>
              <div className="border border-slate-200 p-4 rounded-lg bg-slate-50">
                <p className="text-xs font-bold text-slate-500 tracking-wider mb-1">PROMEDIO COMPRA</p>
                <p className="text-2xl font-bold text-slate-800">${loadingSales ? '-' : promedioCompra.toFixed(2)}</p>
              </div>
            </div>

            <div>
              <div className="flex justify-between items-center mb-4 mt-2">
                <h4 className="text-lg font-bold text-slate-800">Historial de Compras</h4>
              </div>
              <div className="border border-slate-200 rounded-lg overflow-hidden max-h-64 overflow-y-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 text-slate-500 font-bold tracking-wider text-xs sticky top-0">
                    <tr>
                      <th className="p-3">FECHA</th>
                      <th className="p-3">ARTÍCULOS</th>
                      <th className="p-3 text-right">TOTAL</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-slate-600 bg-white">
                    {loadingSales ? (
                      <tr>
                        <td colSpan={3} className="p-6 text-center text-slate-500 bg-slate-50/50">
                          Cargando historial de compras...
                        </td>
                      </tr>
                    ) : customerSales.length === 0 ? (
                      <tr>
                        <td colSpan={3} className="p-6 text-center text-slate-500 bg-slate-50/50">
                          No hay compras registradas para este cliente.
                        </td>
                      </tr>
                    ) : (
                      customerSales.map((sale) => {
                        const itemsString = sale.sale_items?.map((item: any) => 
                          `${item.quantity}x ${item.products?.name || 'Producto Desconocido'}`
                        ).join(', ');

                        return (
                          <tr key={sale.id} className="hover:bg-slate-50 transition">
                            <td className="p-3 whitespace-nowrap">
                              {new Date(sale.created_at).toLocaleDateString('es-VE', { 
                                day: '2-digit', month: 'short', year: 'numeric' 
                              })}
                            </td>
                            <td className="p-3">
                              <div className="truncate max-w-[200px] md:max-w-xs" title={itemsString}>
                                {itemsString}
                              </div>
                            </td>
                            <td className="p-3 text-right font-medium text-slate-800">
                              ${Number(sale.total_amount).toFixed(2)}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}