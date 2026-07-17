'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import Modal from '@/components/Modal';
import LoyaltySettingsCard from '@/components/LoyaltySettingsCard';
import { usePOSStore } from '@/store/usePOSStore'; // <-- 1. Importamos el contexto
import { deleteSaleAction } from './actions';
import ExcelJS from 'exceljs';
import { formatVariant } from '@/lib/productVariant';

// Nombre legible de un método de pago ('punto_de_venta' -> 'punto de venta')
const prettyMethod = (m?: string | null) => (m ? m.replace(/_/g, ' ') : '');

// Texto del/los método(s) de pago de una venta (usado en el Excel).
// Pago simple: "punto de venta". Pago dividido: "efectivo ($50.00), cashea ($80.00)".
const paymentToText = (sale: any) => {
  const m1 = prettyMethod(sale.payment_method) || 'N/A';
  if (!sale.payment_method_2) return m1;
  const a1 = Number(sale.payment_amount_1) || 0;
  const a2 = Number(sale.payment_amount_2) || 0;
  return `${m1} ($${a1.toFixed(2)}), ${prettyMethod(sale.payment_method_2)} ($${a2.toFixed(2)})`;
};

// Cantidad total de artículos vendidos en una venta.
const saleItemCount = (sale: any) =>
  sale.sale_items?.reduce((acc: number, it: any) => acc + (it.quantity || 0), 0) || 0;

export default function DashboardPage() {
  const supabase = createClient();
  const { currentStore } = usePOSStore(); // <-- 2. Obtenemos la tienda activa
  
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<string>('');

  // Estados para métricas principales
  const [todayUSD, setTodayUSD] = useState(0);
  const [todayVES, setTodayVES] = useState(0);
  
  const [thisWeekUSD, setThisWeekUSD] = useState(0);
  const [weekGrowth, setWeekGrowth] = useState(0);
  
  const [thisMonthUSD, setThisMonthUSD] = useState(0);
  const [monthGrowth, setMonthGrowth] = useState(0);

  // Estados para listas de Top 50
  const [topCustomers, setTopCustomers] = useState<any[]>([]);
  const [topProducts, setTopProducts] = useState<any[]>([]);
  
  // Estados para Modales de "Ver más"
  const [isProductsModalOpen, setIsProductsModalOpen] = useState(false);
  const [isCustomersModalOpen, setIsCustomersModalOpen] = useState(false);

  // Rango de fechas para el GRÁFICO
  const defaultEnd = new Date();
  const defaultStart = new Date();
  defaultStart.setDate(defaultEnd.getDate() - 7);
  
  const [dateRange, setDateRange] = useState({
    start: defaultStart.toISOString().split('T')[0],
    end: defaultEnd.toISOString().split('T')[0],
  });
  
  const [chartData, setChartData] = useState<any[]>([]);
  const chartTotalSales = chartData.reduce((acc, curr) => acc + curr.Ventas, 0);

  // Estados para el HISTORIAL DE TRANSACCIONES
  const [salesHistory, setSalesHistory] = useState<any[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [historyDateRange, setHistoryDateRange] = useState({
    start: defaultStart.toISOString().split('T')[0],
    end: defaultEnd.toISOString().split('T')[0],
  });

  const parseSupabaseDate = (dateStr: string) => {
    if (!dateStr) return new Date();
    let formatted = dateStr;
    if (formatted.includes(' ') && !formatted.includes('T')) {
      formatted = formatted.replace(' ', 'T');
    }
    if (!formatted.endsWith('Z') && !formatted.includes('+') && !formatted.match(/-\d{2}:\d{2}$/)) {
      formatted = formatted + 'Z';
    }
    return new Date(formatted);
  };

  // =======================================================
  // 1. MÉTRICAS PRINCIPALES Y TOP 50
  // =======================================================
  useEffect(() => {
    async function fetchDashboardData() {
      if (!currentStore) return; // Bloqueo de seguridad si no hay tienda
      
      setLoading(true);
      
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('role')
          .eq('id', user.id)
          .single();
        if (profile) setRole(profile.role);
      }

      const now = new Date();

      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const dayOfWeek = now.getDay() === 0 ? 6 : now.getDay() - 1; 
      const startOfThisWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek);
      const startOfLastWeek = new Date(startOfThisWeek.getFullYear(), startOfThisWeek.getMonth(), startOfThisWeek.getDate() - 7);
      const endOfLastWeek = new Date(startOfThisWeek.getFullYear(), startOfThisWeek.getMonth(), startOfThisWeek.getDate() - 1, 23, 59, 59);
      
      const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

      // A. Obtener todas las ventas desde el mes pasado AISLADAS POR TIENDA
      const { data: recentSales } = await supabase
        .from('sales')
        .select('total_amount, bcv_rate, created_at')
        .eq('store_id', currentStore.id) // <-- FILTRO MULTI-TIENDA
        .gte('created_at', startOfLastMonth.toISOString());

      if (recentSales) {
        let tUSD = 0, tVES = 0, tWeek = 0, lWeek = 0, tMonth = 0, lMonth = 0;

        recentSales.forEach(sale => {
          const saleDate = parseSupabaseDate(sale.created_at);
          const amount = Number(sale.total_amount);

          if (saleDate >= startOfToday) {
            tUSD += amount;
            tVES += amount * Number(sale.bcv_rate);
          }
          if (saleDate >= startOfThisWeek) tWeek += amount;
          if (saleDate >= startOfLastWeek && saleDate <= endOfLastWeek) lWeek += amount;
          if (saleDate >= startOfThisMonth) tMonth += amount;
          if (saleDate >= startOfLastMonth && saleDate <= endOfLastMonth) lMonth += amount;
        });

        setTodayUSD(tUSD);
        setTodayVES(tVES);
        setThisWeekUSD(tWeek);
        setThisMonthUSD(tMonth);
        setWeekGrowth(lWeek ? ((tWeek - lWeek) / lWeek) * 100 : 0);
        setMonthGrowth(lMonth ? ((tMonth - lMonth) / lMonth) * 100 : 0);
      } else {
        // Reset a cero si no hay ventas en la nueva tienda
        setTodayUSD(0); setTodayVES(0); setThisWeekUSD(0); setThisMonthUSD(0); setWeekGrowth(0); setMonthGrowth(0);
      }

      // B. Mejores Clientes AISLADOS POR TIENDA
      const { data: customers } = await supabase
        .from('customers')
        .select('full_name, total_spent')
        .eq('store_id', currentStore.id) // <-- FILTRO MULTI-TIENDA
        .order('total_spent', { ascending: false })
        .limit(50);
      
      setTopCustomers(customers || []);

      // C. Top Productos usando un Inner Join con Sales para AISLAR POR TIENDA
      // ⚡ CORRECCIÓN: Solicitamos custom_name y unit_price para los productos rápidos
      const { data: saleItems } = await supabase
        .from('sale_items')
        .select('product_id, quantity, custom_name, unit_price, products(name, price, talla, color), sales!inner(store_id)')
        .eq('sales.store_id', currentStore.id);

      if (saleItems) {
        const productCounts: Record<string, { id: string, name: string, variant: string, price: number, qty: number }> = {};

        saleItems.forEach((item: any) => {
          // Si no hay product_id, usamos el custom_name como ID temporal
          const pId = item.product_id || `quick-${item.custom_name}`;

          const productName = item.custom_name || item.products?.name || 'Desconocido';
          const price = item.unit_price ?? item.products?.price ?? 0;
          const variant = formatVariant(item.products?.talla, item.products?.color);

          if (!productCounts[pId]) {
            productCounts[pId] = { id: pId, name: productName, variant, price: price, qty: 0 };
          }
          productCounts[pId].qty += item.quantity;
        });
        
        const sortedProducts = Object.values(productCounts)
          .sort((a, b) => b.qty - a.qty)
          .slice(0, 50); 
        setTopProducts(sortedProducts);
      } else {
        setTopProducts([]);
      }

      setLoading(false);
    }
    fetchDashboardData();
  }, [supabase, currentStore?.id]); // <-- Se vuelve a ejecutar si cambia la tienda

  // =======================================================
  // 2. GRÁFICO DE RECHARTS
  // =======================================================
  useEffect(() => {
    async function fetchChartData() {
      if (!currentStore) return;
      
      const { data: chartSales } = await supabase
        .from('sales')
        .select('created_at, total_amount')
        .eq('store_id', currentStore.id) // <-- FILTRO MULTI-TIENDA
        .gte('created_at', `${dateRange.start}T00:00:00.000-04:00`)
        .lte('created_at', `${dateRange.end}T23:59:59.999-04:00`);

      if (chartSales) {
        const grouped: Record<string, number> = {};
        chartSales.forEach(sale => {
          const dateStr = parseSupabaseDate(sale.created_at)
            .toLocaleDateString('es-VE', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit' })
            .split('/')
            .reverse()
            .join('-');
          grouped[dateStr] = (grouped[dateStr] || 0) + Number(sale.total_amount);
        });

        const formattedData = Object.keys(grouped).sort().map(date => ({
          fecha: date,
          Ventas: Number(grouped[date].toFixed(2))
        }));

        setChartData(formattedData);
      } else {
        setChartData([]);
      }
    }
    fetchChartData();
  }, [dateRange, supabase, currentStore?.id]); // <-- Se vuelve a ejecutar si cambia la tienda

  // =======================================================
  // 3. HISTORIAL DE TRANSACCIONES
  // =======================================================
  useEffect(() => {
    async function fetchHistory() {
      if (!currentStore) return;
      
      setLoadingHistory(true);
      const { data } = await supabase
        .from('sales')
        .select(`
          id,
          created_at,
          total_amount,
          redemption_discount_usd,
          bcv_rate,
          payment_method,
          payment_ref,
          payment_method_2,
          payment_amount_1,
          payment_amount_2,
          customers (full_name),
          profiles (full_name),
          sale_items (
            quantity,
            unit_price,
            custom_name,
            products (name, talla, color)
          )
        `)
        .eq('store_id', currentStore.id) 
        .gte('created_at', `${historyDateRange.start}T00:00:00.000-04:00`)
        .lte('created_at', `${historyDateRange.end}T23:59:59.999-04:00`)
        .order('created_at', { ascending: false })
        .limit(100);

      if (data) {
        setSalesHistory(data);
      } else {
        setSalesHistory([]);
      }
      setLoadingHistory(false);
    }
    fetchHistory();
  }, [historyDateRange, supabase, currentStore?.id]); // <-- Se vuelve a ejecutar si cambia la tienda

  const handleExportCSV = async () => {
    if (!currentStore || exporting) return;
    setExporting(true);

    try {
      // Límites anclados a Caracas (UTC-4 fijo). Funciona porque created_at ya es timestamptz.
      const fromISO = `${historyDateRange.start}T00:00:00.000-04:00`;
      const toISO   = `${historyDateRange.end}T23:59:59.999-04:00`;

      // Query PROPIA del export: SIN .limit() → trae TODO el rango (la tabla sí está capada a 50).
      const { data: rows, error } = await supabase
        .from('sales')
        .select(`
          id,
          created_at,
          total_amount,
          redemption_discount_usd,
          bcv_rate,
          payment_method,
          payment_ref,
          payment_method_2,
          payment_amount_1,
          payment_amount_2,
          customers (full_name),
          profiles (full_name),
          sale_items (
            quantity,
            unit_price,
            custom_name,
            products (name, talla, color)
          )
        `)
        .eq('store_id', currentStore.id)
        .gte('created_at', fromISO)
        .lte('created_at', toISO)
        .order('created_at', { ascending: false });

      if (error) throw error;
      if (!rows || rows.length === 0) {
        alert('No hay transacciones en el rango seleccionado.');
        return;
      }

      const workbook = new ExcelJS.Workbook();
      const ws = workbook.addWorksheet('Historial de Ventas', {
        views: [{ state: 'frozen', ySplit: 1 }],
      });

      ws.columns = [
        { header: 'Fecha',                 key: 'fecha',      width: 20 },
        { header: 'Cliente',               key: 'cliente',    width: 22 },
        { header: 'Cajero',                key: 'cajero',     width: 20 },
        { header: 'Productos comprados',   key: 'productos',  width: 42 },
        { header: 'Método de Pago',        key: 'metodo',     width: 26 },
        { header: 'Cantidad de artículos', key: 'cantidad',   width: 13, style: { numFmt: '#,##0' } },
        { header: 'Referencia',            key: 'referencia', width: 16 },
        { header: 'Descuento USD',         key: 'descuento',  width: 14, style: { numFmt: '"$"#,##0.00' } },
        { header: 'Total USD',             key: 'usd',        width: 14, style: { numFmt: '"$"#,##0.00' } },
        { header: 'Total Bs',              key: 'bs',         width: 16, style: { numFmt: '#,##0.00 "Bs"' } },
      ];

      // Las columnas de texto largo se ajustan (wrap) y se alinean arriba.
      ws.getColumn('productos').alignment = { wrapText: true, vertical: 'top' };
      ws.getColumn('metodo').alignment = { wrapText: true, vertical: 'top' };
      ws.getColumn('cantidad').alignment = { horizontal: 'center', vertical: 'top' };

      const headerRow = ws.getRow(1);
      headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      headerRow.height = 30;
      headerRow.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
        cell.border = { bottom: { style: 'thin', color: { argb: 'FF334155' } } };
      });

      let totalSumaUSD = 0;
      let totalSumaVES = 0;
      let totalDescuento = 0;
      let totalCantidad = 0;

      rows.forEach((sale: any) => {
        const fecha = parseSupabaseDate(sale.created_at).toLocaleString('es-VE', {
          timeZone: 'America/Caracas',
          day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit', hour12: true,
        }).replace(/,/g, '');

        // Celda "Productos comprados": una línea por artículo con formato "Nx nombre".
        const itemCount = saleItemCount(sale);
        const productos = sale.sale_items?.map((item: any) => {
          const nm = item.custom_name || item.products?.name || 'Desconocido';
          const variant = formatVariant(item.products?.talla, item.products?.color);
          return `${item.quantity}x ${nm}${variant ? ` (${variant})` : ''}`;
        }).join('\n') || '';

        const amountUSD = Number(sale.total_amount) || 0;
        const amountVES = amountUSD * (Number(sale.bcv_rate) || 0);
        const descuentoUSD = Number(sale.redemption_discount_usd) || 0;
        totalSumaUSD += amountUSD;
        totalSumaVES += amountVES;
        totalDescuento += descuentoUSD;
        totalCantidad += itemCount;

        ws.addRow({
          fecha,
          cliente: sale.customers?.full_name || 'Anónimo',
          cajero: sale.profiles?.full_name || 'Desconocido',
          productos,
          metodo: paymentToText(sale),
          referencia: sale.payment_ref || 'N/A',
          cantidad: itemCount,
          descuento: descuentoUSD,
          usd: amountUSD,
          bs: amountVES,
        });
      });

      // Fila de totales generales (etiqueta combinada A:E, verde claro).
      // Cantidad de artículos (F) lleva su total; Referencia (G) queda vacía.
      const totalRow = ws.addRow({
        fecha: 'TOTALES GENERALES',
        cantidad: totalCantidad,
        descuento: totalDescuento,
        usd: totalSumaUSD,
        bs: totalSumaVES,
      });
      ws.mergeCells(`A${totalRow.number}:E${totalRow.number}`);
      totalRow.font = { bold: true, color: { argb: 'FF274E13' } };
      totalRow.height = 20;
      totalRow.getCell('fecha').alignment = { horizontal: 'center', vertical: 'middle' };
      for (let c = 1; c <= 10; c++) {
        totalRow.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9EAD3' } };
      }

      ws.autoFilter = { from: 'A1', to: 'J1' };

      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const storeName = currentStore.name?.replace(/\s+/g, '_').toLowerCase() || 'tienda';
      link.download = `historial_ventas_${storeName}_${historyDateRange.start}_al_${historyDateRange.end}.xlsx`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Export error:', err);
      alert(err instanceof Error ? err.message : 'Error al exportar el reporte.');
    } finally {
      setExporting(false);
    }
  };
  // Bloqueo de seguridad visual mientras carga el contexto de la tienda
  if (!currentStore) {
    return <div className="h-full flex items-center justify-center text-slate-500 font-sans">Sincronizando reportes de sucursal...</div>;
  }

  if (loading) {
    return <div className="flex h-full items-center justify-center text-slate-500">Cargando analíticas...</div>;
  }

  const dateOptions: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };
  const formattedDate = new Date().toLocaleDateString('es-ES', dateOptions);

  return (
    <div className="h-full font-sans max-w-[88rem] mx-auto flex flex-col gap-6 w-full pb-10">
      
      {/* --- CABECERA --- */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-slate-800">
            {role === 'cashier' ? 'Panel de Cajero' : 'Analíticas de la Sucursal'}
          </h1>
          <p className="text-slate-500">
            Mostrando datos de: <strong className="text-teal-700">{currentStore.name}</strong>
          </p>
        </div>
        <div className="bg-slate-200 text-slate-700 px-4 py-2 rounded-lg text-sm font-medium flex items-center capitalize">
          📅 {formattedDate}
        </div>
      </div>

      {/* =========================================================
          VISTA DEL CAJERO (CASHIER)
          ========================================================= */}
      {role === 'cashier' && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 w-full shrink-0">
          <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200 flex flex-col justify-center h-[140px]">
            <p className="text-slate-500 font-medium mb-1">Tus Ventas de Hoy</p>
            <h2 className="text-3xl font-bold text-slate-800">${todayUSD.toFixed(2)}</h2>
            <p className="text-sm font-bold text-teal-700 mt-1 truncate">
              Bs. {todayVES.toFixed(2)} <span className="text-slate-400 font-normal">Equivalente</span>
            </p>
          </div>
        </div>
      )}

      {/* =========================================================
          VISTA DEL DUEÑO (OWNER / ADMIN)
          ========================================================= */}
      {role !== 'cashier' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 w-full shrink-0">
          
          {/* COLUMNA IZQUIERDA */}
          <div className="lg:col-span-2 space-y-6 flex flex-col w-full h-full">
            
            {/* Métricas */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 w-full">
              <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200 flex flex-col justify-center h-[140px]">
                <p className="text-slate-500 font-medium mb-1">Ventas de Hoy</p>
                <h2 className="text-3xl font-bold text-slate-800">${todayUSD.toFixed(2)}</h2>
                <p className="text-sm font-bold text-teal-700 mt-1 truncate">
                  Bs. {todayVES.toFixed(2)} <span className="text-slate-400 font-normal">Equivalente</span>
                </p>
              </div>
              <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200 flex flex-col justify-center h-[140px]">
                <p className="text-slate-500 font-medium mb-1">Esta Semana</p>
                <h2 className="text-3xl font-bold text-slate-800">${thisWeekUSD.toFixed(2)}</h2>
                <p className={`text-sm font-medium mt-1 truncate ${weekGrowth >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                  {weekGrowth >= 0 ? '↗' : '↘'} {Math.abs(weekGrowth).toFixed(1)}% <span className="text-slate-400 font-normal">vs sem pasada</span>
                </p>
              </div>
              <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200 flex flex-col justify-center h-[140px]">
                <p className="text-slate-500 font-medium mb-1">Este Mes</p>
                <h2 className="text-3xl font-bold text-slate-800">${thisMonthUSD.toFixed(2)}</h2>
                <p className={`text-sm font-medium mt-1 truncate ${monthGrowth >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                  {monthGrowth >= 0 ? '↗' : '↘'} {Math.abs(monthGrowth).toFixed(1)}% <span className="text-slate-400 font-normal">vs mes pasado</span>
                </p>
              </div>
            </div>

            {/* GRÁFICO */}
            <div className="hidden md:flex bg-white p-6 rounded-xl shadow-sm border border-slate-200 flex-col flex-1 min-h-[350px]">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4 w-full">
                <div>
                  <h3 className="text-lg font-bold text-slate-800">Ventas por Rango de Fecha</h3>
                  <p className="text-2xl font-bold text-teal-700 mt-1">${chartTotalSales.toFixed(2)}</p>
                </div>
                <div className="flex items-center justify-between gap-1 sm:gap-2 text-sm bg-slate-50 p-1.5 rounded-lg border border-slate-200 w-full sm:w-auto">
                  <input 
                    type="date" 
                    value={dateRange.start} 
                    onChange={(e) => setDateRange(prev => ({ ...prev, start: e.target.value }))}
                    className="bg-transparent border-none outline-none text-slate-700 cursor-pointer flex-1 min-w-0 text-center sm:text-left"
                  />
                  <span className="text-slate-400 font-medium">-</span>
                  <input 
                    type="date" 
                    value={dateRange.end} 
                    onChange={(e) => setDateRange(prev => ({ ...prev, end: e.target.value }))}
                    className="bg-transparent border-none outline-none text-slate-700 cursor-pointer flex-1 min-w-0 text-center sm:text-left"
                  />
                </div>
              </div>
              
              <div className="flex-1 w-full min-h-[250px] pr-2" style={{ minWidth: 0, minHeight: 0 }}>
                {chartData.length === 0 ? (
                  <div className="h-full flex items-center justify-center border-2 border-dashed border-slate-100 rounded-lg text-slate-400">
                    No hay ventas registradas en este rango.
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={350}>
                    <AreaChart data={chartData} margin={{ top: 10, right: 50, left: 0, bottom: 0 }}>
                      <defs>
                        <linearGradient id="colorVentas" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#0f766e" stopOpacity={0.3}/>
                          <stop offset="95%" stopColor="#0f766e" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                      <XAxis dataKey="fecha" tick={{ fontSize: 12, fill: '#64748b' }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 12, fill: '#64748b' }} axisLine={false} tickLine={false} tickFormatter={(val) => `$${val}`} />
                      <Tooltip 
                        contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                        formatter={(value: any) => [`$${Number(value).toFixed(2)}`, 'Ventas Totales']}
                        labelFormatter={(label: any) => `Fecha: ${label}`}
                        labelStyle={{ color: '#64748b', marginBottom: '4px' }}
                      />
                      <Area type="monotone" dataKey="Ventas" stroke="#0f766e" strokeWidth={3} fillOpacity={1} fill="url(#colorVentas)" />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>
          </div>

          {/* COLUMNA DERECHA */}
          <div className="space-y-6 flex flex-col w-full">

            {/* Top Productos */}
            <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200 flex flex-col min-h-[200px]">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-lg font-bold text-slate-800">Mejores Productos</h3>
                {topProducts.length > 0 && (
                  <button onClick={() => setIsProductsModalOpen(true)} className="text-xs font-semibold text-teal-600 hover:text-teal-800 transition">
                    Ver todos
                  </button>
                )}
              </div>
              <div className="space-y-3 flex-1 flex flex-col justify-start">
                {topProducts.length === 0 ? (
                  <p className="text-slate-500 text-sm m-auto">No hay ventas registradas.</p>
                ) : (
                  topProducts.slice(0, 3).map((product) => (
                    <div key={product.id} className="flex items-center gap-4 bg-slate-50 p-3 rounded-lg border border-slate-100">
                      <div className="w-10 h-10 bg-white shadow-sm border border-slate-100 rounded-lg flex items-center justify-center text-lg shrink-0">📦</div>
                      <div className="flex-1 min-w-0">
                        <p className="font-bold text-slate-800 text-sm truncate">{product.name}</p>
                        <p className="text-xs text-slate-500">{product.qty} unidades{product.variant ? ` · ${product.variant}` : ''}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="font-bold text-teal-700 text-sm">${product.price.toFixed(2)}</p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Mejores Clientes */}
            <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200 flex flex-col min-h-[200px]">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-lg font-bold text-slate-800">Mejores Clientes</h3>
                {topCustomers.length > 0 && (
                  <button onClick={() => setIsCustomersModalOpen(true)} className="text-xs font-semibold text-teal-600 hover:text-teal-800 transition">
                    Ver todos
                  </button>
                )}
              </div>
              <div className="space-y-3 flex-1 flex flex-col justify-start">
                {topCustomers.length === 0 ? (
                  <p className="text-slate-500 text-sm m-auto">No hay clientes registrados.</p>
                ) : (
                  topCustomers.slice(0, 3).map((customer, index) => (
                    <div key={index} className="flex items-center gap-4 bg-slate-50 p-3 rounded-lg border border-slate-100">
                      <div className="w-10 h-10 bg-teal-100 text-teal-700 rounded-full flex items-center justify-center font-bold shrink-0">
                        {customer.full_name.charAt(0).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-bold text-slate-800 text-sm truncate">{customer.full_name}</p>
                        <p className="text-xs text-slate-500">Cliente Frecuente</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="font-bold text-teal-700 text-sm">${customer.total_spent.toFixed(2)}</p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Configuración de Descuento por Puntos (owner) */}
            <LoyaltySettingsCard />

          </div>
        </div>
      )}


      {/* --- SECCIÓN INFERIOR: HISTORIAL DE TRANSACCIONES --- */}
      <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200 flex flex-col w-full min-h-[400px]">
        <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center mb-6 gap-4 w-full">
          <h3 className="text-lg font-bold text-slate-800 shrink-0">Historial de Transacciones</h3>
          
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full lg:w-auto">
            <button 
              onClick={handleExportCSV}
              disabled={exporting}
              className="text-sm bg-[#0f5c5c] text-white px-4 py-2 rounded-lg font-medium hover:bg-[#0a4545] transition flex items-center justify-center gap-2 disabled:bg-slate-300 disabled:cursor-not-allowed w-full sm:w-auto shrink-0"
            >
              {exporting ? '⏳ Exportando...' : '📥 Exportar a .xlsx'}
            </button>

            <div className="flex items-center justify-between gap-1 sm:gap-2 text-sm bg-slate-50 p-1.5 rounded-lg border border-slate-200 w-full sm:w-auto">
              <input 
                type="date" 
                value={historyDateRange.start} 
                onChange={(e) => setHistoryDateRange(prev => ({ ...prev, start: e.target.value }))}
                className="bg-transparent border-none outline-none text-slate-700 cursor-pointer flex-1 min-w-0 text-center sm:text-left"
              />
              <span className="text-slate-400 font-medium">-</span>
              <input 
                type="date" 
                value={historyDateRange.end} 
                onChange={(e) => setHistoryDateRange(prev => ({ ...prev, end: e.target.value }))}
                className="bg-transparent border-none outline-none text-slate-700 cursor-pointer flex-1 min-w-0 text-center sm:text-left"
              />
            </div>
          </div>
        </div>
        
        {loadingHistory ? (
          <div className="flex-1 flex justify-center items-center py-10">
            <p className="text-slate-500">Cargando transacciones...</p>
          </div>
        ) : (
          <div className="overflow-x-auto w-full">
            {salesHistory.length === 0 ? (
              <div className="py-10 text-center flex flex-col items-center">
                <span className="text-4xl mb-2 opacity-50">📂</span>
                <p className="text-slate-500 font-medium">No hay transacciones registradas en {currentStore.name}.</p>
              </div>
            ) : (
              <table className="w-full text-left text-sm border-collapse min-w-[900px]">
                <thead className="bg-slate-100 text-slate-600">
                  <tr>
                    <th className="p-3 font-semibold rounded-tl-lg">Fecha</th>
                    <th className="p-3 font-semibold">Cliente</th>
                    <th className="p-3 font-semibold">Cajero</th>
                    <th className="p-3 font-semibold">Productos</th>
                    <th className="p-3 font-semibold">Pago</th>
                    <th className="p-3 font-semibold text-center">Cantidad</th>
                    <th className="p-3 font-semibold text-right rounded-tr-lg">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {salesHistory.map((sale) => (
                    <tr key={sale.id} className="hover:bg-slate-50 transition-colors">
                      <td className="p-3 text-slate-600 whitespace-nowrap">
                        {parseSupabaseDate(sale.created_at).toLocaleString('es-VE', { 
                          timeZone: 'America/Caracas',
                          day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true
                        })}
                      </td>
                      <td className="p-3 text-slate-800 font-medium max-w-[150px] truncate">
                        {sale.customers?.full_name || 'Anónimo'}
                      </td>
                      <td className="p-3 text-slate-600 max-w-[150px] truncate">
                        {sale.profiles?.full_name || 'Desconocido'}
                      </td>
                      <td className="p-3 align-top">
                        <ul className="list-disc list-inside text-slate-600 text-xs space-y-1 max-h-32 overflow-y-auto pr-1 custom-scrollbar">
                          {sale.sale_items?.map((item: any, idx: number) => (
                            <li key={idx} className="truncate max-w-[200px]">
                              <span className="font-medium text-slate-700">{item.quantity}x</span> {item.custom_name || item.products?.name || 'Desconocido'}
                              {formatVariant(item.products?.talla, item.products?.color) && (
                                <span className="text-slate-400 ml-1">· {formatVariant(item.products?.talla, item.products?.color)}</span>
                              )}
                              <span className="text-slate-400 ml-1">(${item.unit_price})</span>
                            </li>
                          ))}
                        </ul>
                      </td>
                      <td className="p-3">
                        {sale.payment_method_2 ? (
                          <div className="flex flex-col gap-1 items-start">
                            <span className="capitalize text-slate-800 font-medium text-xs bg-slate-100 inline-block px-2 py-1 rounded">
                              {prettyMethod(sale.payment_method)} <span className="text-teal-700 font-semibold">(${Number(sale.payment_amount_1).toFixed(2)})</span>
                            </span>
                            <span className="capitalize text-slate-800 font-medium text-xs bg-slate-100 inline-block px-2 py-1 rounded">
                              {prettyMethod(sale.payment_method_2)} <span className="text-teal-700 font-semibold">(${Number(sale.payment_amount_2).toFixed(2)})</span>
                            </span>
                          </div>
                        ) : (
                          <div className="capitalize text-slate-800 font-medium text-xs bg-slate-100 inline-block px-2 py-1 rounded">
                            {prettyMethod(sale.payment_method)}
                          </div>
                        )}
                        {sale.payment_ref && (
                          <span className="block text-[11px] text-slate-400 mt-1 truncate max-w-[100px]">Ref: {sale.payment_ref}</span>
                        )}
                      </td>
                      <td className="p-3 text-center text-slate-700 font-semibold whitespace-nowrap">
                        {saleItemCount(sale)}
                      </td>
                      <td className="p-3 text-right">
  <p className="font-bold text-slate-800">${Number(sale.total_amount).toFixed(2)}</p>
  <p className="text-[11px] text-slate-500 font-medium mt-0.5">
    Bs. {(Number(sale.total_amount) * Number(sale.bcv_rate)).toFixed(2)}
  </p>
  {Number(sale.redemption_discount_usd) > 0 && (
    <p className="text-[11px] text-teal-600 font-semibold mt-0.5">
      ✪ Canje: −${Number(sale.redemption_discount_usd).toFixed(2)}
    </p>
  )}

  {/* NUEVO: Botón de anular venta */}
  {role === 'owner' && (
  <button 
    onClick={async () => {
      if (confirm('¿Estás seguro de anular esta venta? El stock y los puntos del cliente serán revertidos inmediatamente.')) {
        try {
           await deleteSaleAction(sale.id);
           
           // Actualiza el estado local para que desaparezca al instante
           setSalesHistory(prev => prev.filter(s => s.id !== sale.id));
           alert('Venta anulada con éxito');
           
        } catch (error) {
           // CORRECCIÓN TYPESCRIPT: Verificamos si es una instancia de Error
           if (error instanceof Error) {
             alert(error.message);
           } else {
             alert('Ocurrió un error inesperado al intentar anular la venta.');
           }
        }
      }
    }}
    className="text-xs text-red-500 hover:text-red-700 mt-2 font-semibold"
  >
    Anular Venta
  </button>
)}
</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* --- MODALES "VER MÁS" --- */}
      {role !== 'cashier' && (
        <>
          <Modal isOpen={isProductsModalOpen} onClose={() => setIsProductsModalOpen(false)} title="Mejores 50 Productos">
            <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-2 custom-scrollbar">
              {topProducts.map((product, idx) => (
                 <div key={product.id} className="flex items-center gap-4 bg-slate-50 p-3 rounded-lg border border-slate-100">
                   <div className="w-8 h-8 flex items-center justify-center font-bold text-slate-400 text-sm">#{idx + 1}</div>
                   <div className="w-10 h-10 bg-white shadow-sm border border-slate-100 rounded-lg flex items-center justify-center text-lg shrink-0">📦</div>
                   <div className="flex-1 min-w-0">
                     <p className="font-bold text-slate-800 text-sm truncate">{product.name}</p>
                     <p className="text-xs text-slate-500">{product.qty} unidades vendidas{product.variant ? ` · ${product.variant}` : ''}</p>
                   </div>
                   <div className="text-right shrink-0">
                     <p className="font-bold text-teal-700 text-sm">${product.price.toFixed(2)}</p>
                   </div>
                 </div>
              ))}
            </div>
          </Modal>

          <Modal isOpen={isCustomersModalOpen} onClose={() => setIsCustomersModalOpen(false)} title="Mejores 50 Clientes">
            <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-2 custom-scrollbar">
              {topCustomers.map((customer, idx) => (
                <div key={idx} className="flex items-center gap-4 bg-slate-50 p-3 rounded-lg border border-slate-100">
                  <div className="w-8 h-8 flex items-center justify-center font-bold text-slate-400 text-sm">#{idx + 1}</div>
                  <div className="w-10 h-10 bg-teal-100 text-teal-700 rounded-full flex items-center justify-center font-bold shrink-0">
                    {customer.full_name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-slate-800 text-sm truncate">{customer.full_name}</p>
                    <p className="text-xs text-slate-500">Cliente Frecuente</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-bold text-teal-700 text-sm">${customer.total_spent.toFixed(2)}</p>
                  </div>
                </div>
              ))}
            </div>
          </Modal>
        </>
      )}
    </div>
  );
}