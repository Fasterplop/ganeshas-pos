'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

export default function DashboardPage() {
  const supabase = createClient();
  const [loading, setLoading] = useState(true);

  // Estados para nuestros datos analíticos
  const [todayUSD, setTodayUSD] = useState(0);
  const [todayVES, setTodayVES] = useState(0);
  const [topCustomers, setTopCustomers] = useState<any[]>([]);
  const [topProducts, setTopProducts] = useState<any[]>([]);

  useEffect(() => {
    async function fetchDashboardData() {
      setLoading(true);

      // 1. Calcular el inicio del día para filtrar las ventas de "Hoy"
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const startOfDayIso = startOfDay.toISOString();

      // --- QUERY 1: VENTAS DE HOY (Cumpliendo Regla Estricta Sección D) ---
      const { data: salesToday } = await supabase
        .from('sales')
        .select('total_amount, bcv_rate')
        .gte('created_at', startOfDayIso); // gte = Mayor o igual al inicio del día

      if (salesToday) {
        let sumUSD = 0;
        let sumVES = 0;
        
        salesToday.forEach(sale => {
          sumUSD += Number(sale.total_amount);
          // REGLA D.2: El equivalente en Bs se calcula usando la tasa exacta de ESA venta
          sumVES += Number(sale.total_amount) * Number(sale.bcv_rate);
        });

        setTodayUSD(sumUSD);
        setTodayVES(sumVES);
      }

      // --- QUERY 2: TOP CUSTOMERS ---
      const { data: customers } = await supabase
        .from('customers')
        .select('full_name, total_spent')
        .order('total_spent', { ascending: false }) // Los que más han gastado
        .limit(3); // Solo los 3 primeros
      
      if (customers) setTopCustomers(customers);

      // --- QUERY 3: TOP PRODUCTS ---
      // Traemos todos los detalles de venta vinculando la tabla de productos
      const { data: saleItems } = await supabase
        .from('sale_items')
        .select('quantity, products(name, price)');

      if (saleItems) {
        // Agrupamos en JavaScript para sumar las cantidades de un mismo producto
        const productCounts: Record<string, { name: string, price: number, qty: number }> = {};
        
        saleItems.forEach((item: any) => {
          const productName = item.products?.name || 'Desconocido';
          if (!productCounts[productName]) {
            productCounts[productName] = { name: productName, price: item.products?.price || 0, qty: 0 };
          }
          productCounts[productName].qty += item.quantity;
        });

        // Convertimos el objeto a un arreglo, lo ordenamos por cantidad vendida y tomamos los 3 primeros
        const sortedProducts = Object.values(productCounts)
          .sort((a, b) => b.qty - a.qty)
          .slice(0, 3);
          
        setTopProducts(sortedProducts);
      }

      setLoading(false);
    }

    fetchDashboardData();
  }, []);

  if (loading) {
    return <div className="flex h-full items-center justify-center text-slate-500">Cargando analíticas...</div>;
  }

  return (
    <div className="h-full font-sans max-w-7xl mx-auto">
      {/* Cabecera */}
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold text-slate-800">Dashboard</h1>
          <p className="text-slate-500">Resumen del rendimiento de hoy</p>
        </div>
        <div className="bg-slate-200 text-slate-700 px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2">
          📅 Hoy, {new Date().toLocaleDateString('es-ES', { month: 'short', day: 'numeric' })}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* COLUMNA IZQUIERDA (Gráficas y Métricas Principales) */}
        <div className="lg:col-span-2 space-y-6">
          
          {/* Tarjetas de Resumen */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Tarjeta: Ventas de Hoy (Multimoneda) */}
            <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200 relative overflow-hidden">
              <div className="absolute top-4 right-4 bg-teal-100 p-2 rounded-full text-teal-700 text-xl">🧾</div>
              <p className="text-slate-500 font-medium mb-2">Ventas de Hoy</p>
              <h2 className="text-3xl font-bold text-slate-800">${todayUSD.toFixed(2)}</h2>
              <p className="text-sm font-bold text-teal-700 mt-2">
                Bs. {todayVES.toFixed(2)} <span className="text-slate-400 font-normal">Equivalente Real</span>
              </p>
            </div>

            {/* Tarjeta: Esta Semana (Mock visual basado en la imagen) */}
            <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200 relative overflow-hidden">
              <div className="absolute top-4 right-4 bg-blue-100 p-2 rounded-full text-blue-700 text-xl">📊</div>
              <p className="text-slate-500 font-medium mb-2">Esta Semana</p>
              <h2 className="text-3xl font-bold text-slate-800">$8,430.50</h2>
              <p className="text-sm font-medium text-emerald-600 mt-2">
                ↗ +5% <span className="text-slate-400 font-normal">vs semana pasada</span>
              </p>
            </div>

            {/* Tarjeta: Este Mes (Mock visual basado en la imagen) */}
            <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200 relative overflow-hidden">
              <div className="absolute top-4 right-4 bg-orange-100 p-2 rounded-full text-orange-700 text-xl">📅</div>
              <p className="text-slate-500 font-medium mb-2">Este Mes</p>
              <h2 className="text-3xl font-bold text-slate-800">$32,150.00</h2>
              <p className="text-sm font-medium text-red-500 mt-2">
                ↘ -2% <span className="text-slate-400 font-normal">vs mes pasado</span>
              </p>
            </div>
          </div>

          {/* Gráfico de Métodos de Pago (Mock basado en la imagen) */}
          <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200 min-h-[300px] flex flex-col">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-lg font-bold text-slate-800">Métodos de Pago</h3>
              <button className="text-teal-700 text-sm font-medium hover:underline">Ver Detalles</button>
            </div>
            {/* Espacio reservado para librería de gráficos como Recharts en el futuro */}
            <div className="flex-1 border-2 border-dashed border-slate-100 rounded-lg flex items-end justify-center pb-8 gap-12 relative">
               <div className="text-center">
                  <div className="w-16 bg-teal-100 h-24 rounded-t-sm mx-auto mb-2"></div>
                  <p className="text-xs text-slate-500">Efectivo</p>
               </div>
               <div className="text-center">
                  <div className="w-16 bg-teal-600 h-48 rounded-t-sm mx-auto mb-2"></div>
                  <p className="text-xs text-slate-500">Zelle</p>
               </div>
               <div className="text-center">
                  <div className="w-16 bg-teal-300 h-32 rounded-t-sm mx-auto mb-2"></div>
                  <p className="text-xs text-slate-500">Pago Móvil</p>
               </div>
            </div>
          </div>
        </div>

        {/* COLUMNA DERECHA (Top Products y Top Customers) */}
        <div className="space-y-6">
          
          {/* Top Products */}
          <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
            <h3 className="text-lg font-bold text-slate-800 mb-6">Top Productos</h3>
            <div className="space-y-5">
              {topProducts.length === 0 ? (
                <p className="text-slate-500 text-sm">No hay ventas registradas aún.</p>
              ) : (
                topProducts.map((product, index) => (
                  <div key={index} className="flex items-center gap-4">
                    <div className="w-12 h-12 bg-slate-100 rounded-lg flex items-center justify-center text-xl">
                      📦
                    </div>
                    <div className="flex-1">
                      <p className="font-bold text-slate-800 text-sm truncate">{product.name}</p>
                      <p className="text-xs text-slate-500">{product.qty} unidades vendidas</p>
                    </div>
                    <div className="text-right">
                      <p className="font-bold text-teal-700 text-sm">${product.price.toFixed(2)}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Top Customers */}
          <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
            <h3 className="text-lg font-bold text-slate-800 mb-6">Mejores Clientes</h3>
            <div className="space-y-5">
              {topCustomers.length === 0 ? (
                <p className="text-slate-500 text-sm">No hay clientes registrados aún.</p>
              ) : (
                topCustomers.map((customer, index) => (
                  <div key={index} className="flex items-center gap-4">
                    <div className="w-10 h-10 bg-slate-100 rounded-full flex items-center justify-center text-slate-500 font-bold">
                      {customer.full_name.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1">
                      <p className="font-bold text-slate-800 text-sm truncate">{customer.full_name}</p>
                      <p className="text-xs text-slate-500">Cliente Recurrente</p>
                    </div>
                    <div className="text-right">
                      <p className="font-bold text-teal-700 text-sm">${customer.total_spent.toFixed(2)}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}