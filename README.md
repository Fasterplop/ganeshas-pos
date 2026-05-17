# GaneshaStores POS MVP 🐘

GaneshaStores POS MVP es un sistema integral de Punto de Venta (POS) y control interno de inventario. Está diseñado para operar con máxima velocidad en el mostrador, manejar facturación multimoneda (USD/VES) en tiempo real y proveer analíticas detalladas para la administración, todo bajo una arquitectura web moderna, segura y escalable.

---

## 🛠 Stack Tecnológico

El proyecto está construido sobre un stack robusto para garantizar rendimiento, seguridad y una excelente experiencia de usuario y desarrollador:

* **Framework Core:** Next.js (App Router) v15+
* **Base de Datos & Backend:** Supabase (PostgreSQL + Authentication)
* **Gestión de Estado Global:** Zustand
* **Estilos y UI:** Tailwind CSS v4
* **Formularios y Validación:** React Hook Form + Zod
* **Hardware / Impresión:** `react-barcode` (optimizado para etiquetas térmicas 50x25mm)

---

## 🌍 Estrategia de Despliegue y Arquitectura de Rutas

Este repositorio es completamente independiente del e-commerce principal de la marca y está diseñado para ser desplegado en un **subdominio dedicado** (ej. `pos.ganeshastores.com`).

### Aislamiento de Entorno (Middleware)
Utilizando `@supabase/ssr` en nuestro `middleware.ts`, las cookies de sesión (`sb-access-token`, `sb-refresh-token`) están estrictamente limitadas a este subdominio. Esto garantiza que las sesiones de los empleados en el POS no interfieran ni compartan contexto con las sesiones de los clientes en la tienda online.

### Controlador de Tráfico Raíz (`/app/page.tsx`)
La ruta principal (`/`) carece de interfaz gráfica. Funciona como un **Server Component** que evalúa la sesión en el backend y redirige instantáneamente:
* **No Autenticado:** Redirección a `/login`.
* **Rol `owner`:** Redirección a `/dashboard` (Analíticas).
* **Rol `cashier`:** Redirección a `/pos` (Caja registradora).

### Layout Único Unificado
Se implementó un Layout maestro basado en un **Sidebar Lateral**. El acceso a las rutas y la visibilidad de los elementos del menú están estrictamente condicionados por el rol del usuario en la tabla `profiles`.

---

## 🗄 Modelo de Datos y Seguridad (Supabase)

La base de datos relacional en PostgreSQL está protegida por **Row-Level Security (RLS)**. Ninguna operación de lectura, inserción o actualización es permitida sin las políticas adecuadas para usuarios autenticados.

### Esquema Relacional
* **`profiles`**: Extiende `auth.users`. Almacena el `full_name` y el `role` (`owner`, `cashier`).
* **`customers`**: CRM del negocio. Primary Key: `document_id` (Cédula V-/J-). Se reemplazó el uso de email por `phone`.
* **`products`**: Inventario. Almacena `sku_barcode`, `name`, `category`, `price` y `stock`.
* **`sales`**: Cabecera de facturación vinculada al cajero (`cashier_id`) y al cliente (`customer_id`). Guarda el `total_amount`, método de pago y la **tasa BCV exacta** de la transacción.
* **`sale_items`**: Detalle de productos adquiridos (`sale_id`, `product_id`, `quantity`, `unit_price`, `subtotal`).

---

## 🚀 Módulos Core y Reglas de Negocio Implementadas

### 1. Gestión de Tasa BCV (Bloqueo Global)
La Tasa de Cambio (BCV) es el motor multimoneda. Si la tasa no está configurada al iniciar la sesión (es 0 en Zustand), un **Modal Persistente** bloquea el sistema. Al establecerse, alimenta en tiempo real todos los cálculos y se adjunta de forma inmutable a cada nueva venta en la tabla `sales`.

### 2. Flujo POS Simplificado e Inteligente
* **Cero Impuestos y Sin Vuelto:** Optimizado para control interno. No hay cálculo de IVA ni gestión de cambio/vuelto. El subtotal es el total a pagar.
* **Smart Checkout (Cliente Opcional):** Se eliminaron los modales en la vista de caja. El cajero ingresa la cédula/teléfono directamente. Al "Finalizar Venta", el sistema busca en la BD:
  * Si el cliente existe, actualiza sus datos (si cambiaron) y le asigna la venta.
  * Si es nuevo, lo crea automáticamente y le asigna la venta en la misma transacción.
  * Si se deja vacío, se procesa como "Consumidor Final" (`customer_id: null`).
* **Búsqueda Dinámica:** Dropdown de búsqueda de productos en tiempo real por nombre o escaneo de código de barras.

### 3. Inventario y Etiquetas Térmicas (Hardware)
* **Auto-Generación de SKUs:** Al registrar un producto, el sistema genera automáticamente un SKU único (Ej. `JUG-482915`) evitando errores humanos.
* **Impresión Directa:** Uso de utilidades CSS (`print:block`, `print:hidden`) y `react-barcode` para imprimir etiquetas de productos y "Descuentos Rápidos" directamente desde el navegador a impresoras de rollo térmico sin márgenes.

### 4. Dashboard Analítico Multimoneda
Cumpliendo la Sección D del DDT, el cálculo de las "Ventas de Hoy" en Bolívares (VES) **no utiliza una tasa global**. El sistema consulta la base de datos y multiplica el `total_amount` de cada venta por su propio `bcv_rate` histórico, garantizando precisión contable absoluta. Incluye consultas relacionales para extraer los *Top Products* y *Top Customers*.

### 5. Gestión de Usuarios (Cajeros)
Módulo exclusivo para el `owner`. Utiliza **Next.js Server Actions** combinadas con la `SUPABASE_SERVICE_ROLE_KEY` (Admin API).
* **Beneficio:** Permite crear credenciales en `auth.users` e insertar su perfil en `profiles` con el rol `cashier` desde el frontend, **sin cerrar la sesión actual** del administrador.

---

## ⏭️ Fase 2 (Próximos Pasos)
* **Reward Points:** La interfaz visual de Puntos de Recompensa en el perfil del cliente (Sección C del DDT) ya se encuentra maquetada a nivel de UI, lista para que su lógica de acumulación sea activada en la siguiente fase de desarrollo.

---
*GaneshaStores POS - Desarrollado para optimización de flujo en mostrador y alta fidelidad contable.*