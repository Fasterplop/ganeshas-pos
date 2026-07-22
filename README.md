# GaneshaStores POS MVP 🐘

GaneshaStores POS MVP es un sistema integral de Punto de Venta (POS) y control interno de inventario. Está diseñado para operar con máxima velocidad en el mostrador, manejar facturación multimoneda (USD/VES) en tiempo real y proveer analíticas detalladas para la administración, todo bajo una arquitectura web moderna, segura y escalable.

---

## 🛠 Stack Tecnológico

El proyecto está construido sobre un stack robusto para garantizar rendimiento, seguridad y una excelente experiencia de usuario y desarrollador:

* **Framework Core:** Next.js (App Router) v15+
* **Base de Datos & Backend:** Supabase (PostgreSQL + Authentication)
* **Autenticación en Servidor:** `@supabase/ssr`
* **Gestión de Estado Global:** Zustand
* **Visualización de Datos:** Recharts (Gráficos analíticos)
* **Estilos y UI:** Tailwind CSS v4
* **Formularios y Validación:** React Hook Form + Zod
* **Hardware / Impresión:** `react-barcode` (optimizado para etiquetas térmicas 62x29mm)

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

### Layout Responsivo Multidispositivo
Se implementó un Layout maestro adaptable (`flex-col md:flex-row`). Para garantizar una experiencia fluida en cualquier dispositivo en el mostrador, la navegación se divide condicionalmente:
* **Vista Móvil:** Renderiza un `TopBarMenu` superior.
* **Vista de Escritorio:** Renderiza un `Sidebar` lateral tradicional.
El acceso a las rutas y la visibilidad de los elementos del menú están estrictamente condicionados por el rol del usuario (`owner` o `cashier`) en la tabla `profiles`.El acceso a las rutas y la visibilidad de los elementos del menú están estrictamente condicionados por el rol del usuario en la tabla `profiles`.

### Control de Flujo Multi-Tienda (`StoreGuard`)
El sistema envuelve las rutas con protección de entorno:
* **Flujo Cashier:** El sistema lee su `assigned_store_id`, establece la tienda en el estado global y lo deja operar únicamente en su sucursal.
* **Flujo Owner:** Una pantalla de bloqueo obliga al administrador a seleccionar el entorno inicial ("Tienda de Ropa" o "Tienda de Juguetes"). Luego, puede saltar entre sucursales usando un Dropdown dinámico en el Layout.

---

## 🗄 Modelo de Datos y Seguridad (Supabase RLS)

La base de datos relacional en PostgreSQL está protegida por **Row-Level Security (RLS)**. Ninguna operación es permitida si el `store_id` del usuario no coincide con el de la sucursal activa.

### Esquema Relacional Actualizado
* **`stores` (NUEVO):** Define las sucursales disponibles (`id`, `name`, `address`, `is_active`).
* **`profiles`**: Extiende `auth.users`. Almacena el `full_name`, el `role`, la atadura a la sucursal obligatoria (`assigned_store_id`) y el **alcance de reposición** del cajero mediante dos banderas: `can_restock_all` (reponer en **todas** las tiendas) y `can_restock_local` (reponer **solo** en su tienda asignada). El owner elige el alcance en `/users` entre tres opciones: **Sin reposición** (solo lectura, no añade ni repone), **Solo su tienda** (`can_restock_local = true`: añade productos y **sube** stock —nunca lo baja— únicamente en su sucursal asignada) y **Todas** (`can_restock_all = true`: lo mismo pero en cualquier tienda). `can_restock_all` tiene prioridad sobre `can_restock_local`.
* **`customers`:** CRM del negocio. Su Primary Key es compuesta: `(document_id, store_id)`, por lo que cada sucursal mantiene su propia fila e historial de venta del cliente. **Los puntos de fidelidad, en cambio, se manejan como un pool UNIFICADO:** se leen y canjean sumando el saldo del cliente en todas las sucursales (ver `get_global_points` / `redeem_points_global`). Se reemplazó el uso de email por `phone`.
* **`products` (Catálogo Global):** Almacena `sku_barcode`, `name`, `category`, `price` y `owner_store_id`. El producto sigue siendo **vendible en cualquier tienda desde el POS** (catálogo global), pero `owner_store_id` define la **tienda dueña**: el módulo de Inventario muestra **solo** los productos de la tienda activa. Las categorías son `juguetes`, `ropa`, `zapato`, `perfume`, `accesorios`, `lentes`. Guarda además `created_at` (fecha de alta) y `label_printed_at` (primera impresión de etiqueta, sellada por el RPC `mark_label_printed`): el inventario marca con el badge **"Nuevo"** los productos creados hace **menos de 1 día** a los que **aún no se les imprimió la etiqueta**; al pulsar "Imprimir Etiqueta" se registra el clic y el badge desaparece. Los productos anteriores a esa migración tienen `created_at` en NULL y nunca se muestran como nuevos. El `sku_barcode` autogenerado usa el prefijo de la **tienda** dueña (`JUG-`/`ROP-`), no de la categoría; si se escanea un código, se respeta tal cual.
* **`store_stock` (Inventario Local):** Nueva tabla que maneja el stock físico por tienda `(product_id, store_id)`. **Permite stock negativo**: si se vende un producto sin existencias, el stock de esa tienda queda en negativo (p. ej. -1) para reflejar la sobreventa (se removió el `CHECK (stock >= 0)`). El semáforo de "stock bajo" del inventario usa un umbral **por tienda**: en **juguetería es 1 o menos** (rota más lento) y en el resto (ropa) **2 o menos**; los agotados (`<= 0`) van aparte en rojo. **Incluye un Trigger automático** que inicializa el stock en 0 en todas las sucursales cuando nace un nuevo producto. En el módulo de Inventario: el `owner` gestiona (añade/edita/borra) su **tienda activa**; el **cajero reponedor global** añade productos y **sube** stock (nunca lo baja) en **todas** las tiendas, mientras que el **cajero reponedor local** hace lo mismo **solo en su tienda asignada** (en las demás es de solo lectura); el **cajero sin reposición** es de **solo lectura**. La reposición se hace vía el RPC `restock_stock` (`SECURITY DEFINER`), que valida en el servidor el alcance del cajero (global / local / ninguno) y que solo pueda **subir** stock. Los cajeros disponen de un **filtro de vista** para mirar el inventario de cualquier tienda (el owner ve el de su tienda activa).
* **`sales`**: Cabecera de facturación. Vinculada obligatoriamente al cajero (`cashier_id`), cliente (`customer_id`) y sucursal (`store_id`). Guarda el `total_amount`, el `redemption_discount_usd` (descuento por canje aplicado, para auditoría en el historial), método de pago y la tasa BCV exacta. **Pago dividido (NUEVO):** una venta puede cobrarse con hasta **2 métodos de pago** a la vez (`db/split_payment.sql`); en ese caso `payment_method`/`payment_amount_1` y `payment_method_2`/`payment_amount_2` guardan cada método con el monto en USD que cubre (su suma es el `total_amount`). Un pago simple deja las columnas `_2` y los montos en `NULL`. Esto se refleja en el historial y el Excel del Dashboard.
* **`sale_items`**: Detalle de productos adquiridos (`sale_id`, `product_id`, `quantity`, `unit_price`, `subtotal`).
* **`loyalty_settings` (NUEVO):** Configuración del programa de fidelidad (`store_id`, `points_per_block`, `discount_per_block_usd`). Editable únicamente por el `owner`; define el monto a gastar y el descuento en USD equivalente (con la tasa de 1 punto por $1, `points_per_block` = monto en dólares). La regla es **GLOBAL**: aunque la tabla guarda una fila por sucursal, la app la mantiene idéntica en todas.
* **`get_global_points` / `redeem_points_global` (RPC, NUEVO):** Funciones (`SECURITY DEFINER`) que leen y canjean el saldo de puntos como un **pool unificado** entre sucursales. El canje bloquea las filas del cliente (`FOR UPDATE`), **impide saldos negativos y el doble gasto**, resuelve carreras entre cajas y aborta si el saldo GLOBAL no alcanza. (La versión previa `redeem_points`, por sucursal, queda en la base pero ya no se usa.)

---

## 🚀 Módulos Core y Reglas de Negocio Implementadas

### 1. Dashboard Analítico e Historial de Transacciones
Un panel de control exclusivo para administradores (`owner`) que ofrece una visión profunda del negocio:
* **Gráficos Analíticos (Recharts):** Visualización interactiva del rendimiento de ventas filtrable por **rango de fechas**.
* **Historial de Transacciones:** Registro detallado de todas las operaciones de caja en tiempo real.
* **Precisión Multimoneda:** El cálculo de ventas en Bolívares (VES) no usa una tasa global actual, sino que multiplica el total de cada venta por su **propia tasa BCV histórica** al momento de la transacción.
* **Exportación de Datos:** Capacidad de exportar los reportes y transacciones a formato **.CSV** para auditorías o uso en software contable externo.

### 2. Flujo POS Simplificado e Inteligente
* **Gestión de Tasa BCV:** Bloqueo global del sistema mediante Zustand si la tasa del día no ha sido configurada.
* **Cero Impuestos y Sin Vuelto:** Optimizado para control interno. No hay cálculo de IVA ni gestión de cambio/vuelto. El subtotal es el total a pagar.
* **Smart Checkout (Cliente Opcional):** Se eliminaron los modales en la vista de caja. 
El cajero ingresa la cédula/nombre/teléfono directamente. Al "Finalizar Venta", el sistema busca en la BD:
  * Si el cliente existe, actualiza sus datos (si cambiaron) y le asigna la venta.
  * Si es nuevo, lo crea automáticamente y le asigna la venta en la misma transacción.
  * Si se deja vacío, se procesa como "Consumidor Final" (`customer_id: null`).
* **Sistema de Reward Points:** El sistema calcula y guarda de forma automatizada los puntos de fidelidad del cliente, aplicando la regla de **1 punto por cada $1 gastado** (los centavos no acumulan).
* **Canje de Puntos (Descuento por Lealtad):** Al ingresar la cédula, el POS lee el saldo **unificado** del cliente (suma de todas las sucursales, vía `get_global_points`) y **precarga automáticamente el descuento máximo disponible**, acotado por el saldo y por el total de la venta. El cajero u owner puede subir, bajar o quitar el canje libremente. El descuento se apila con el descuento manual (efectivo/zelle), nunca deja el total negativo, y la acumulación se recalcula sobre el **neto** pagado. Al finalizar, los puntos se descuentan del pool global con `redeem_points_global` **antes** de crear la venta: si el saldo global es insuficiente o hay carrera, se aborta el cobro sin registrar la venta. El monto descontado queda guardado en la venta y visible en el **Historial de Transacciones** (y en el export a Excel).
* **Búsqueda Dinámica:** Dropdown de búsqueda de productos en tiempo real por nombre o escaneo de código de barras.

### 3. Gestión de Clientes (CRM)
Módulo dedicado (`/customers`) para administrar la base de datos de compradores:
* Control detallado de datos personales. 
* El sistema utiliza el Documento de Identidad (Cédula V-/J-) como Primary Key.
* **Smart Checkout:** Desde el POS, ingresar una cédula asigna la venta a un cliente existente, o lo crea y registra automáticamente si es la primera vez que compra.

### 4. Inventario y Etiquetas Térmicas (Hardware)
* **Auto-Generación de SKUs:** Al registrar un producto, el sistema genera automáticamente un SKU único (Ej. `JUG-482915`) evitando errores humanos.
* **Impresión Directa:** Uso de utilidades CSS (`print:block`, `print:hidden`) y `react-barcode` para imprimir etiquetas de productos y "Descuentos Rápidos" directamente desde el navegador a impresoras de rollo térmico sin márgenes.
* **Registro Optimizador:** Al crear un nuevo producto, el sistema permite ingresar o escanear un código de barras existente de fábrica, o generar un SKU interno único de forma automática.
* Control estricto de categorías, precios y niveles de stock.


### 5. Dashboard Analítico Multimoneda
Cumpliendo la Sección D del DDT, el cálculo de las "Ventas de Hoy" en Bolívares (VES) **no utiliza una tasa global**. El sistema consulta la base de datos y multiplica el `total_amount` de cada venta por su propio `bcv_rate` histórico, garantizando precisión contable absoluta. Incluye consultas relacionales para extraer los *Top Products* y *Top Customers*.

### 6. Gestión de Usuarios (Cajeros)
Módulo exclusivo para el `owner`. Utiliza **Next.js Server Actions** combinadas con la `SUPABASE_SERVICE_ROLE_KEY` (Admin API).
* **Beneficio:** Permite crear credenciales en `auth.users` e insertar su perfil en `profiles` con el rol `cashier` desde el frontend, **sin cerrar la sesión actual** del administrador.

### 7. Impresión Térmica Multi-productos (`/labels`)
Sistema de impresión masiva integrado directamente en el navegador:
* Generación de códigos de barras mediante `react-barcode`.
* Interfaz para seleccionar **múltiples productos y cantidades** e imprimirlos en lote.
* CSS optimizado (`print:block`, `print:hidden`, `print:p-0`) para impresoras de rollo térmico sin márgenes, garantizando que las etiquetas salgan perfectas sin configuraciones extra en el OS.

---

## 📲 Notificación WhatsApp post-venta (Cloud API de Meta + n8n)

Al finalizar una venta con cliente asociado que tenga teléfono **y consentimiento registrado**, el POS envía automáticamente un WhatsApp con los puntos ganados y el acumulado global (plantilla `confirmacion_compra_puntos2`, idioma `es`).

**Arquitectura — regla de oro: solo n8n habla con Meta.** El POS nunca tiene el token de WhatsApp ni llama a `graph.facebook.com`:
1. `handleCheckout` (POS) llama al Server Action `notifySaleWhatsApp` (`src/app/(dashboard)/pos/actions.ts`) **sin await** (fire-and-forget: la venta jamás falla ni se demora por la mensajería).
2. El action (service role, para saltar la RLS por tienda) valida el opt-in, resuelve el primer teléfono no nulo del cliente entre sucursales y la suma global de `reward_points`, y hace POST al webhook local de n8n (`N8N_SALE_WEBHOOK_URL`, header `x-pos-secret` = `N8N_WEBHOOK_SECRET`). Si esas env no están definidas, es un no-op.
3. n8n (Docker, mismo VPS) normaliza el teléfono venezolano a `58XXXXXXXXXX` y envía la plantilla vía Graph API con el token del **Usuario del Sistema** de Meta (guardado únicamente como credencial de n8n).

### ⚠️ Categoría MARKETING → consentimiento obligatorio
La plantilla incluye botón de Instagram y quick reply "Cancelar promociones", por lo que Meta la clasifica como **marketing** (no utility). Consecuencia: **solo se le puede escribir a quien dio opt-in explícito**. Por eso:
* `customers.wa_marketing_opt_in` / `wa_opt_out_at` (`db/whatsapp_marketing_optin.sql`): el consentimiento es de la **persona**, no de la sucursal — se evalúa sobre todas las filas del mismo `document_id`. Default `false`: los clientes preexistentes no reciben nada hasta aceptar en caja.
* **Checkbox en el checkout** del POS. El cajero solo puede **otorgar** el consentimiento; una baja pedida por el cliente nunca se revierte desde la caja (la UI muestra "🔕 Este cliente pidió no recibir promociones").
* **Baja funcional**: el workflow `meta-eventos` de n8n recibe el evento de Meta cuando el cliente toca "Cancelar promociones" (o responde BAJA/STOP) y ejecuta el RPC `wa_opt_out_by_phone`, que cruza el teléfono por sus últimos 10 dígitos (`customers.phone` es texto libre y Meta envía `584141234567`). Un botón de baja que no funciona degrada el *quality rating* y Meta termina pausando la plantilla.
* `get_global_points` se extendió de forma aditiva para devolver también `wa_opt_in` / `wa_opt_out`, y así la caja muestra el estado real del cliente sin una consulta extra.

Runbook completo de despliegue (VPS, nginx, Meta, workflows, troubleshooting): `deploy/whatsapp/README.md`. Diseño de la sección de campañas de marketing (no construida): `docs/whatsapp-fase2-marketing.md`.

---

## ⏭️ Fase 2 (Próximos Pasos)
* **Customer App (Ecosistema Multiplataforma):** Expansión del sistema mediante el desarrollo de una aplicación dedicada para clientes, disponible tanto en versión **Web App** como en formato nativo para **App Store (iOS)** y **Google Play (Android)**.

* **Redención de Puntos (POS — ✅ Implementado):** El cajero ya puede canjear los `reward_points` del cliente como descuento directo en caja. Los **puntos son un pool unificado** entre sucursales y la **regla de descuento es global** (configurable por el `owner` en `loyalty_settings`), con deducción atómica sobre el saldo global (`redeem_points_global`). **Pendiente:** exponer el balance y el canje también desde la Customer App.

> **Deuda técnica aceptada (Fase 2):** por alcance, el canje y la creación de venta no comparten una única transacción (se prioriza no dar descuento "gratis" al negocio); la anulación de una venta con canje no reintegra los puntos automáticamente; y no se guarda un ledger de canjes (solo el `redemption_discount_usd` en la venta y el saldo reducido del cliente).

---
*GaneshaStores POS - Desarrollado para optimización de flujo en mostrador y alta fidelidad contable.*