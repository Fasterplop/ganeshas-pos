'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { createClient } from '@/lib/supabase/client';
import Modal from '@/components/Modal';

// 1. Esquema de validación con Zod (Cambiamos 'email' por 'phone')
const customerSchema = z.object({
  document_id: z.string().min(5, { message: 'La cédula debe tener al menos 5 caracteres' }),
  full_name: z.string().min(3, { message: 'El nombre completo debe tener al menos 3 caracteres' }),
  phone: z.string().min(7, { message: 'El teléfono debe tener al menos 7 dígitos' }),
});

type CustomerFormValues = z.infer<typeof customerSchema>;

interface Customer {
  document_id: string;
  full_name: string;
  phone: string | null; // Cambiado de email a phone
  total_spent: number;
  reward_points: number;
  created_at: string;
}

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  
  // Control de los Modales Reutilizables
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isViewModalOpen, setIsViewModalOpen] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);

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

  // Cargar lista de clientes desde Supabase
  async function fetchCustomers() {
    setLoading(true);
    const { data } = await supabase
      .from('customers')
      .select('*')
      .order('created_at', { ascending: false });
    
    if (data) setCustomers(data);
    setLoading(false);
  }

  useEffect(() => {
    fetchCustomers();
  }, []);

  const handleRowClick = (customer: Customer) => {
    setSelectedCustomer(customer);
    setIsViewModalOpen(true);
  };

  // Guardar el cliente con el número de teléfono en la base de datos
  const onAddCustomerSubmit = async (data: CustomerFormValues) => {
    const { error } = await supabase.from('customers').insert([
      {
        document_id: data.document_id,
        full_name: data.full_name,
        phone: data.phone, // Enviamos el teléfono a la nueva columna
      },
    ]);

    if (error) {
      alert('Error al registrar el cliente: ' + error.message);
    } else {
      setIsAddModalOpen(false);
      reset();
      fetchCustomers(); // Recargamos la tabla automáticamente
    }
  };

  // Buscador en tiempo real
  const filteredCustomers = customers.filter(customer =>
    customer.full_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    customer.document_id.toLowerCase().includes(searchTerm.toLowerCase())
  );

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
            placeholder="🔍 Buscar por cédula o nombre..." 
            className="w-full md:w-64 px-4 py-2 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-teal-600 outline-none transition"
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
                    <td className="p-4 text-slate-500 text-sm">15 Sep, 2023</td>
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

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="border border-slate-200 p-4 rounded-lg bg-slate-50">
                <p className="text-xs font-bold text-slate-500 tracking-wider mb-1">TOTAL GASTADO</p>
                <p className="text-2xl font-bold text-slate-800">${selectedCustomer.total_spent.toFixed(2)}</p>
              </div>

              {/* ===== REGLA ESTRICTA (FASE 2): PUNTOS COMENTADOS ====== */}
              {/* <div className="border border-slate-200 p-4 rounded-lg bg-slate-50">
                <p className="text-xs font-bold text-slate-500 tracking-wider mb-1">PUNTOS DE RECOMPENSA</p>
                <div className="flex items-center gap-2">
                  <p className="text-2xl font-bold text-teal-600">{selectedCustomer.reward_points}</p>
                  <span className="text-teal-600">✪</span>
                </div>
              </div> 
              */}
              {/* ======================================================= */}

              <div className="border border-slate-200 p-4 rounded-lg bg-slate-50">
                <p className="text-xs font-bold text-slate-500 tracking-wider mb-1">TOTAL COMPRAS</p>
                <p className="text-2xl font-bold text-slate-800">14</p>
              </div>
              <div className="border border-slate-200 p-4 rounded-lg bg-slate-50">
                <p className="text-xs font-bold text-slate-500 tracking-wider mb-1">PROMEDIO DE COMPRA</p>
                <p className="text-2xl font-bold text-slate-800">$88.96</p>
              </div>
            </div>

            <div>
              <div className="flex justify-between items-center mb-4 mt-2">
                <h4 className="text-lg font-bold text-slate-800">Historial de Compras</h4>
                <button className="text-sm text-teal-700 font-medium hover:underline">Ver todos los estados</button>
              </div>
              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 text-slate-500 font-bold tracking-wider text-xs">
                    <tr>
                      <th className="p-3">FECHA</th>
                      <th className="p-3">ID ORDEN</th>
                      <th className="p-3">ARTÍCULOS</th>
                      <th className="p-3 text-right">TOTAL</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-slate-600 bg-white">
                    <tr>
                      <td className="p-3">15 Sep, 2023</td>
                      <td className="p-3 text-teal-600 font-medium">#ORD-9021</td>
                      <td className="p-3">2x Set de Figuras de Acción, 1x Camiseta Básica (M)...</td>
                      <td className="p-3 text-right font-medium text-slate-800">$145.00</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
              <button className="px-4 py-2 border border-slate-300 rounded-lg font-medium text-slate-700 hover:bg-slate-50 transition">
                Editar Perfil
              </button>
              <button className="px-4 py-2 bg-[#0f5c5c] text-white rounded-lg font-medium hover:bg-[#0a4545] transition flex items-center gap-2">
                🛒 Iniciar Venta para Cliente
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}