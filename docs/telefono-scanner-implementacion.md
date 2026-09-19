# Teléfono escáner: consulta de precios, etiqueta sin precio y ofertas

Implementación de `docs/propuesta-telefono-scanner.pdf` (16-sep-2026, preparada para Gerardo).
Este documento explica **qué se construyó, cómo funciona y cómo se pone en marcha**.

La propuesta vendía tres cosas; se construyeron las tres, más un pedido posterior del cliente:

| | Qué | Dónde vive |
|---|---|---|
| **A** | Pantalla «Consultar precio» para el teléfono escáner | `/consultar-precio` |
| **B** | Etiqueta de 62×29 mm **sin precio** | `/labels` y `/inventory` |
| **C** | **Ofertas** guardadas en el sistema, aplicadas solas en caja | `/ofertas`, `/pos`, `ExchangeModal` |
| **D** | Los cajeros con permiso de añadir productos pueden **cambiar el código de barras** | `/inventory` |

---

## 1. Orden de aplicación del SQL

Los cuatro archivos son **aditivos** y se aplican **a mano**, en este orden, en el SQL Editor de
Supabase. Cada uno termina con un `SELECT` de verificación: el editor solo muestra el último
`SELECT`, así que se copia la celda entera y se lee de corrido.

| Orden | Archivo | Qué crea |
|---|---|---|
| 1 | `db/scanner_01_bcv_rates.sql` | Tabla `bcv_rates` + RPC `get_bcv_rate` / `set_bcv_rate` |
| 2 | `db/scanner_02_set_product_barcode.sql` | RPC `set_product_barcode` |
| 3 | `db/scanner_03_offers.sql` | Tabla `product_offers`, vista `v_products_priced`, función `effective_product_price` |
| 4 | `db/scanner_04_exchange_offers.sql` | `register_exchange` cobrando el precio efectivo |

**El front degrada si el SQL no está aplicado.** `/ofertas` avisa qué archivo falta correr, el POS
y `/labels` leen de `products` como siempre, y `/consultar-precio` pide la tasa en memoria igual
que la caja. No hay pantallas rotas en el medio del despliegue.

> ⚠️ Las dos tablas nuevas traen sus **políticas RLS en el mismo archivo**, antes del `ENABLE`.
> El proyecto tiene un event trigger `ensure_rls` que activa RLS sola en cada `CREATE TABLE`, y
> una tabla con RLS y cero políticas no queda abierta: queda **muda** (PostgREST devuelve lista
> vacía **sin error**). Después de aplicar, correr `db/rls_00_diagnostico.sql` y comprobar que
> `bcv_rates` y `product_offers` tienen `rls_activa = true` **y** políticas > 0.

**Para volver atrás:** desactivar todas las ofertas (`update product_offers set is_active = false`)
devuelve el sistema al comportamiento anterior sin tocar código. Para revertir del todo, volver a
correr `db/exchange_02_schema_and_rpc.sql` (restaura `register_exchange`) y borrar la vista y las
tablas nuevas; nada del POS tiene FK hacia ellas.

---

## 2. A — Pantalla «Consultar precio»

`src/app/(dashboard)/consultar-precio/page.tsx`. Visible para `owner` y `cashier`.

### El teléfono

Cualquier Android con escáner integrado y Chrome. El equipo del cliente es un **SVANTTO Android 13
(MT8781V/CA)**. No se instala ninguna app: se abre el POS como página web y se agrega a la pantalla
de inicio (hay `public/manifest.webmanifest`, así que entra con el logo de la tienda y a pantalla
completa).

**Configuración del escáner — se deja hecha el día de la instalación:**
- Modo **teclado** (HID / *keyboard wedge*).
- **Sufijo Enter** al final de cada lectura. Si el equipo solo permite Tab, también funciona: la
  pantalla resuelve con `Enter` **y** con `Tab`.
- Sin prefijo, y sin que el escáner agregue espacios.

### Cómo se usa

El empleado entra con su propio usuario y la sesión queda abierta. La casilla de escaneo está
siempre enfocada: **no hay que tocar la pantalla entre lectura y lectura**, y el teclado virtual no
aparece (`inputMode="none"`). Hay un botón **Teclado** para escribir a mano cuando la etiqueta está
rayada.

### Qué muestra

- Nombre, talla · color y código.
- **Precio en $ en letra grande.** Con oferta vigente: precio anterior tachado, precio con
  descuento y el chip **OFERTA −X%** con su fecha de fin.
- **Precio en Bs** con la tasa del día.
- **Unidades disponibles en su tienda** (0 o menos → «Agotado en esta tienda», en rojo).
- **Todas las tallas y colores del modelo**, con el stock y el precio de cada una y la escaneada
  resaltada. Si el producto no pertenece a un grupo de variantes dice «Sin variantes registradas»
  — en la juguetería es lo normal.
- **Últimos 10 escaneos**, guardados en ese teléfono. Al tocar uno se **vuelve a consultar**: nunca
  se muestra un precio guardado.

### Mensajes claros

| Caso | Qué dice |
|---|---|
| El código no existe | «Código no encontrado», con el código leído y la opción de buscar por nombre |
| El producto fue eliminado (`is_active = false`) | **«No disponible — este producto fue eliminado del inventario»**, sin precio |
| Varias coincidencias por nombre | Lista corta para tocar la correcta |

### Seguridad

- **Solo lee.** Desde esa pantalla no se puede vender ni editar nada.
- El cajero ve **solo su tienda asignada** (`StoreGuard` la fija desde `assigned_store_id`); el
  dueño cambia de tienda con el selector de siempre.
- No hay costo ni margen en el modelo de datos, así que no hay nada que ocultar.

### La tasa BCV

El mecanismo de la caja **no cambia**: sigue el modal bloqueante de siempre. Lo que se agregó es
que la tasa ahora se puede **guardar en la base**:

1. Al entrar, la pantalla pide la tasa del día con `get_bcv_rate()`.
2. Si nadie la cargó hoy, la pide **una sola vez** y la guarda con `set_bcv_rate()`.
3. Queda disponible para **todos los dispositivos** ese día.
4. Si la tasa sube otra vez el mismo día, el botón **Actualizar tasa** la corrige.

La fecha del día la calcula el **servidor** en `America/Caracas`, nunca el reloj del teléfono:
la base corre en UTC y `current_date` cambiaría de día a las 8 de la noche hora local, con la
tienda abierta.

`/consultar-precio` es la única ruta exenta del `BcvModal` bloqueante, porque pide la tasa por su
cuenta y pedirla dos veces sería absurdo.

### Por qué no hay búsqueda mientras se escribe

El POS lanza una consulta **por cada carácter** que se teclea. Un escáner teclea 12 caracteres de
golpe: 12 consultas por lectura. Esta pantalla resuelve **solo con Enter**. Cuando el código exacto
no existe reintenta ignorando mayúsculas y, si tampoco, busca por nombre o por parte del código.

---

## 3. B — Etiqueta sin precio

Componente único: `src/components/labels/BarcodeLabel.tsx`. Antes el markup de la etiqueta 62×29
estaba **copiado** en `/labels` y en `/inventory`; ahora los dos usan el mismo, que es lo que evita
que las dos versiones se separen con el tiempo.

**Qué cambia en la versión sin precio:**
- Se quita el bloque del precio y ese espacio va al resto.
- El **nombre** va más grande y hace *wrap*: ya no se corta con «…».
- La **talla y el color** van en **su propia línea y en negrita**, para que el cliente vea su talla
  sin preguntar.
- El **código de barras es más alto y más ancho** (de 20 a 34 px de alto): el teléfono lo lee más
  rápido y desde más lejos.
- **El código de barras es el mismo de siempre.** Las etiquetas viejas ya pegadas se siguen
  escaneando: no hace falta reetiquetar la tienda.

**Solo aplica a la Tienda de Ropa.** En la juguetería el precio se mantiene impreso, por decisión
del negocio. Como el buscador de `/labels` no filtra por tienda, un mismo lote puede mezclar las
dos: por eso la decisión se toma **producto por producto**, según su `owner_store_id`, y la tabla
muestra en la columna **Cómo sale** qué va a salir en cada fila. Si el lote está mezclado, se avisa
antes de imprimir. Un producto sin tienda dueña sale **con** precio (la opción segura).

En `/inventory` el panel *Descuento Rápido* tiene el mismo interruptor con tres posiciones:
**Automático** (la regla de arriba), **Sin precio** y **Con precio** — estas dos para casos sueltos,
como una feria.

**El % del lote y las ofertas.** Si un producto tiene una **oferta vigente** en el sistema, la
etiqueta con precio imprime **la oferta** (con el precio anterior tachado) e **ignora el % del
lote**: la caja va a cobrar la oferta, y una etiqueta que diga otra cosa es una discusión en el
mostrador. El % del lote sigue aplicando a los productos sin oferta.

Las etiquetas de regalo, las de doble logo y las tarjetas de agradecimiento **no se tocaron**.

Además, imprimir en lote ahora sí registra la primera impresión (`mark_label_printed`): hasta hoy
solo lo hacía `/inventory`, así que un producto etiquetado desde `/labels` seguía marcado como
«Nuevo».

---

## 4. C — Ofertas

`src/app/(dashboard)/ofertas/page.tsx`, **solo el dueño** — igual que el ajuste masivo de precios,
porque una oferta cambia lo que cobra la caja. Los cajeros **sí las leen** (la caja las tiene que
cobrar y el teléfono mostrarlas): lo que no pueden es crearlas ni apagarlas.

### Modelo

`product_offers`: alcance (`product` / `group` / `category`), objetivo, `percent`, `starts_at`,
`ends_at` (opcional, **inclusive**), `store_id` (solo acota las de categoría), `is_active`.

**Precedencia:** producto **>** modelo **>** categoría. A igual nivel gana el **porcentaje más
alto**; si también empata, la más reciente.

**Vigencia:** `hoy BETWEEN starts_at AND COALESCE(ends_at, infinito)`, con `hoy` calculado en
`America/Caracas`. Cuando llega la fecha de fin la oferta **se apaga sola** y no hay que reimprimir
nada.

### Una sola fuente de verdad para el precio

El precio con oferta **lo calcula siempre el SQL**, nunca el navegador:

- `v_products_priced` — vista con `security_invoker = on` que agrega `effective_price`, `offer_id`,
  `offer_percent` y `offer_ends_at` a todas las columnas de `products`. Las pantallas que muestran
  o cobran un precio leen de acá.
- `effective_product_price(uuid)` — la misma cuenta para un solo producto, que usa
  `register_exchange` del lado del servidor.

Esto no es un detalle de estilo: `register_exchange` es `SECURITY DEFINER` y **recalcula** el total
en el servidor para no confiar en un monto que viaja desde el navegador. Si el modal mostrara el
precio con oferta y el RPC leyera el precio de lista, el cambio se rechazaría con `TOTAL_MISMATCH`
y el cajero no podría trabajar. Las dos expresiones son idénticas a propósito: **si se cambia una,
hay que cambiar la otra.**

### Dónde se aplica

| Pantalla | Qué hace |
|---|---|
| `/consultar-precio` | Precio anterior tachado + chip OFERTA + fecha de fin |
| `/pos` (buscador y escaneo) | El producto entra al carrito con el precio de oferta; la línea muestra «antes $X» |
| `/pos` (cambiar talla/color) | La hermana entra con **su** oferta |
| `ExchangeModal` | El total del cambio se calcula con el precio de oferta, igual que el RPC |
| `/labels` | La etiqueta con precio imprime la oferta |

### Lo que NO se ve afectado

- `bulk_update_prices` sigue operando sobre `products.price`. Como la oferta es un **porcentaje**,
  se recalcula sola sobre el precio nuevo.
- `revert_price_adjustment` compara `products.price`: no cambia.
- `sale_items.unit_price` sigue guardando **lo que se cobró**, así que el historial, el Excel y los
  reportes no cambian de forma.
- Los puntos siguen siendo `FLOOR(total)` sobre el neto pagado.

---

## 5. D — Cambiar el código de barras

Pedido del cliente, fuera del PDF. En `/inventory`, dentro del formulario de edición, aparece el
botón **Cambiar código** para **los mismos usuarios que ya pueden añadir productos**: el dueño en su
tienda, el cajero reponedor global en cualquiera y el reponedor local en la suya.

- Abre un diálogo con el código actual y un campo enfocado: **se escanea la etiqueta nueva** y
  listo, sin tocar el teclado.
- Advierte de forma explícita que **las etiquetas ya impresas con el código anterior dejarán de
  escanear** (decisión del cliente: cambio directo, sin historial de códigos viejos).
- Guarda con el RPC `set_product_barcode`, que revalida **en el servidor** rol, alcance y tienda
  dueña, rechaza productos eliminados y traduce la colisión de códigos a un mensaje legible.

Al editar, el campo del código quedó de **solo lectura para todos los roles**, incluido el dueño:
hay **un solo camino** para cambiarlo, y ese camino está validado del lado del servidor. El `UPDATE`
directo del formulario ya no manda `sku_barcode`.

---

## 6. Cómo probar

**Antes de tocar nada nuevo — que no se rompió lo de siempre:**
1. Venta normal sin ofertas: total y `unit_price` idénticos a hoy.
2. Venta con descuento manual + canje de puntos.
3. Cambio de producto desde el historial, sin ofertas.
4. Ajuste masivo de precios y su **deshacer**.
5. Lote de etiquetas «con precio»: igual que siempre.

**Lo nuevo:**
6. Crear una oferta de producto, una de modelo y una de categoría sobre el mismo producto:
   debe ganar la de producto.
7. Escanear ese producto en `/pos` → entra con el precio de oferta; cerrar la venta y revisar
   `sale_items.unit_price`.
8. Cambio de producto llevándose un producto en oferta: el total del modal es el que acepta el RPC.
9. Poner `ends_at` de ayer → la oferta desaparece sola de la caja y del teléfono.
10. En el teléfono: escanear tres productos seguidos sin tocar la pantalla; el foco no se pierde y
    el teclado virtual no aparece.
11. Escanear una variante de un modelo con varias tallas → salen **todas** las hermanas con su stock.
12. Escanear un código inventado, y un producto eliminado.
13. Entrar sin tasa del día → la pide una vez; recargar → ya no la pide; «Actualizar tasa» la cambia.
14. Con sesión de cajero: solo su tienda. Con el dueño: el selector cambia el stock mostrado.
15. Lote con un producto de ropa y uno de juguetes en «Sin precio» → una sale sin precio y la otra
    con precio. Medir con regla que las dos caen en 62×29 mm y leer el código nuevo desde ~20 cm.
16. Con un cajero `can_restock_local`: cambiar el código de un producto de **su** tienda (funciona)
    y de la otra (lo rechaza el RPC, no solo la UI). Repetir con un código ya usado.
17. Escanear el código nuevo en `/pos` y en `/consultar-precio`; el viejo ya no responde.

---

## 7. Lo que sigue siendo responsabilidad del cliente

De la sección «Puntos a tener en cuenta» de la propuesta:

- **Normativa de precios.** En Venezuela la SUNDDE exige que los precios estén marcados.
  **Gerardo debe confirmar con su contador o asesor** que quitar el precio de la etiqueta no trae
  problemas en una inspección. Si hace falta, la versión «Con precio» sigue disponible y se
  activa con un clic.
- **Clientes sin precio a la vista.** Conviene tener siempre un empleado con el teléfono en el piso
  de venta, y un aviso visible: «Consulta el precio con nuestro personal».
- **Un solo teléfono.** Si se pierde, se daña o se descarga, la caja sigue mostrando el precio al
  escanear, igual que hoy. Se puede agregar un segundo teléfono.
- **Sin internet** no se pueden consultar precios. Datos móviles como respaldo.
