# WhatsApp post-venta (Fase 1) — Runbook de despliegue

Arquitectura (regla de oro: **solo n8n habla con Meta**; el POS nunca tiene el token):

```
POS (navegador) ──venta OK──▶ Server Action Next.js (mismo VPS)
                                │ ✋ compuerta de opt-in (ver abajo)
                                │ resuelve teléfono + puntos (service role)
                                │ POST http://127.0.0.1:5678/webhook/pos-sale
                                ▼ header x-pos-secret · fire-and-forget · timeout 5 s
                              n8n (Docker, mismo VPS) ──▶ graph.facebook.com

Cliente toca "Cancelar promociones" ──▶ Meta ──▶ https://n8n.ganeshastores.com/webhook/meta-wa
                                                   │ n8n detecta la baja
                                                   ▼ RPC wa_opt_out_by_phone (Supabase)
                                                 el cliente no recibe nada más
```

La venta **nunca** falla ni se demora por WhatsApp: si n8n está caído, el error se loguea y ya.

> ## ⚠️ La plantilla es de categoría MARKETING — implicaciones obligatorias
>
> La plantilla `confirmacion_compra_puntos2` incluye botón de Instagram y quick reply
> "Cancelar promociones", por lo que Meta la clasifica como **MARKETING**, no Utility.
> Eso NO es un detalle administrativo, cambia las reglas:
>
> - **Solo se envía a clientes con opt-in explícito.** El aviso presencial cubre un
>   mensaje transaccional, no promociones. Por eso el checkout tiene un checkbox de
>   consentimiento y el Server Action no envía nada sin él (`db/whatsapp_marketing_optin.sql`).
> - **El default es NO enviar**: los clientes que ya estaban en la base arrancan sin
>   opt-in. Hasta que los cajeros empiecen a preguntar, no sale ningún mensaje. Es lo correcto.
> - **Cuesta más** por mensaje que una plantilla de utility.
> - **El botón "Cancelar promociones" TIENE que funcionar**: si el cliente pide la baja y
>   sigue recibiendo mensajes, bloquea y reporta → baja el *quality rating* → Meta pausa la
>   plantilla o degrada el número. De eso se encarga el workflow `meta-eventos` (sección 4.2).
>
> Si en el futuro se quiere volver a **Utility** (más barato, sin opt-in): hay que quitar el
> botón de Instagram y el de "Cancelar promociones", y dejar el contenido estrictamente
> transaccional. Meta auto-clasifica por contenido: con elementos promocionales,
> recategoriza a Marketing aunque se pida Utility.

---

## 1. VPS — instalar n8n

```bash
# 1.0 Inventario (antes de tocar nada): qué corre y qué puertos hay ocupados
pm2 ls
systemctl status nginx
docker ps 2>/dev/null || echo "sin docker"
ss -tlnp | grep -E ':(80|443|5678)'

# 1.1 Docker (si no está)
curl -fsSL https://get.docker.com | sh

# 1.2 n8n
mkdir -p /opt/n8n && cd /opt/n8n
# copiar aquí el docker-compose.yml de esta carpeta
docker compose up -d
curl -s http://127.0.0.1:5678 >/dev/null && echo "n8n arriba"
```

## 2. DNS + HTTPS

1. Registro **A**: `n8n.ganeshastores.com` → IP del VPS.
2. Copiar `nginx-n8n.conf` a `/etc/nginx/sites-available/n8n.conf`, enlazar en `sites-enabled`, `nginx -t && systemctl reload nginx`.
3. `certbot --nginx -d n8n.ganeshastores.com`.
4. Abrir `https://n8n.ganeshastores.com` y crear la **cuenta owner** de n8n (primer arranque).

## 3. Meta Business (checklist manual)

> **Antes de empezar — entender los 3 identificadores (esto evita la confusión más común).**
> Meta maneja tres cosas distintas, cada una con su **propio ID** (que sean diferentes es lo CORRECTO, no un error):
>
> | Identificador | Qué es | Dónde vive |
> |---|---|---|
> | **App ID** | La "app de desarrollador": solo el conector a la Graph API. | developers.facebook.com |
> | **WABA ID** (WhatsApp Business Account) | La cuenta de mensajería que contiene números y plantillas. | WhatsApp Manager |
> | **Phone Number ID** | Un número concreto dentro de una WABA (va en la URL del envío). | WhatsApp Manager |
>
> Y hay **dos lugares distintos** que es fácil confundir:
> - **App Dashboard** (`developers.facebook.com/apps`) → tu app, agregar producto WhatsApp, token temporal, número de prueba.
> - **WhatsApp Manager** (`business.facebook.com` → WhatsApp Manager) → WABAs reales, números, plantillas, método de pago.
>
> **¿Por qué aparecen DOS cuentas de WhatsApp ("Test WhatsApp Business Account" y "Ganesha Store")?** Es normal:
> - **"Test WhatsApp Business Account"** la crea Meta **automáticamente** al agregar el producto WhatsApp a la app. Trae un **número de prueba gratis** y envía solo a ≤5 destinatarios de prueba. Es el sandbox. **Si ya la ves, el producto WhatsApp YA está agregado** (por eso no aparece el botón "añadir producto WhatsApp").
> - **"Ganesha Store"** es la WABA **real** del negocio (ya existía en el portafolio del cliente). Es la de producción.
>
> ⚠️ **Las plantillas NO se comparten entre WABAs.** Una plantilla creada en la WABA de prueba no existe en la de Ganesha Store, y viceversa. Por eso el orden de abajo: probamos ahora en la WABA de prueba y, cuando llegue el número real, recreamos la plantilla en Ganesha Store.

**Paso 3.1 — Confirmar que el producto WhatsApp está en la app**
- En `developers.facebook.com/apps` → seleccioná tu app → menú lateral izquierdo.
- **Deberías ver "WhatsApp"** en la lista de productos (con submenús *Configuración de la API* / *API Setup*). Si lo ves, ya está — pasá al 3.2. Si NO lo ves, hacé clic en "Agregar producto" y elegí WhatsApp.

**Paso 3.2 — Guardar los datos de prueba (para validar el workflow ahora)**
- App Dashboard → **WhatsApp → Configuración de la API** (*API Setup*).
- **Deberías ver:** un **número de prueba** ("De/From"), un **Identificador del número de teléfono** (*Phone number ID*) y un **Identificador de la cuenta de WhatsApp Business** (*WhatsApp Business Account ID* = el de la WABA de prueba), un **token de acceso temporal**, y una sección "Para/To" para **agregar hasta 5 números de destinatarios de prueba**.
- Anotá el **Phone number ID de prueba** y agregá **tu propio celular** como destinatario de prueba (te llega un código de verificación por WhatsApp).
- Ese token temporal caduca en horas: sirve solo para la primera prueba. El definitivo es el del Usuario del Sistema (paso 3.5).

**Paso 3.3 — Método de pago** (⚠️ sin esto la API "acepta" pero **no llega** el mensaje)
- WhatsApp Manager (`business.facebook.com` → WhatsApp Manager) → **Configuración → Pagos / facturación**.
- Vinculá la tarjeta del cliente. (Para la WABA de prueba con número de prueba no siempre es obligatorio; para la WABA real de Ganesha Store, sí.)

**Paso 3.4 — Crear la plantilla UTILITY**
- WhatsApp Manager → **Plantillas de mensajes → Crear plantilla**.
- **Elegí la WABA correcta** en el selector de arriba: para probar ahora → *Test WhatsApp Business Account*; para producción → *Ganesha Store*. (Recomendado: creala en **ambas** para no rehacer trabajo, o al menos en la que vayas a usar primero.)
- Categoría: **Marketing** · Idioma: **Español** que guarde como código **`es`** (no `es_MX` ni "Spanish (MEX)") — debe coincidir EXACTO con el código.
- Nombre: `confirmacion_compra_puntos2` (debe coincidir EXACTO con el nodo HTTP del workflow).
- Cuerpo (no empieza ni termina con variable ✔):

     ```
     ¡Gracias por tu compra en Ganesha Store! 🛍️
     Agradecemos tu confianza y esperamos verte nuevamente muy pronto.

     ⭐ Puntos ganados: {{1}}
     🏆 Puntos acumulados: {{2}}

     📞 Atención en ventas: 0426 4259352
     📦 Hacemos envíos a toda Venezuela.
     ```
   - Valores de ejemplo (Meta los pide): `{{1}}` = `15`, `{{2}}` = `120`.
   - Botones:
     | # | Tipo | Texto | Destino |
     |---|---|---|---|
     | 1 | URL estática | Síguenos en Instagram | `https://www.instagram.com/ganesha_store01/` |
     | 2 | URL estática | Consulta tus recompensas | `https://www.ganeshastores.com/recompensas` |
     | 3 | Quick Reply | Cancelar promociones | (lo procesa el workflow `meta-eventos`) |

     ⚠️ **Verificar el botón 1**: al crearlo quedó apuntando por error a `/recompensas`. Debe ir a `https://www.instagram.com/ganesha_store01/`. Corregirlo en WhatsApp Manager.
   - Los botones **no cambian el payload del envío**: las URL estáticas no llevan parámetros y el payload del quick reply es opcional. El workflow solo manda las 2 variables del body.
   - Enviar → queda **En revisión** (*Pending*).

**Paso 3.5 — Usuario del Sistema** (token de producción — el temporal caduca en horas)
- **Business Settings** (`business.facebook.com/settings`) → **Usuarios → Usuarios del sistema** → **Agregar** → nombre `n8n-pos`, rol **Admin**.
- **Asignar activos** (*Assign assets*): asigná la **App** y la **WABA de Ganesha Store**, ambas con **Control total** (*Full control*).
- **Generar token** (*Generate new token*): elegí la app, vencimiento **Nunca** (*Never*), y marcá los permisos **`whatsapp_business_messaging`** + **`whatsapp_business_management`**.
- **Copiá el token ahora** (Meta lo muestra una sola vez). Va **únicamente** como credencial en n8n — nunca en el repo ni en `.env.local`.

**Paso 3.6 — Número del negocio** (cuando el cliente lo entregue)
- WhatsApp Manager → WABA *Ganesha Store* → **Números de teléfono → Agregar número**. El número **no puede estar activo en la app normal de WhatsApp** (hay que darlo de baja ahí primero). Verificación por SMS/llamada.
- Anotá su **Phone number ID** (este reemplaza al de prueba en el workflow de n8n).

**Paso 3.7 — Modo Live de la app**
- App Dashboard → arriba, cambiar de **Desarrollo** a **Live/Producción**. Requiere **URL de política de privacidad** (App → Configuración → Básica). Pendiente: publicar la página en www.ganeshastores.com.
- En modo Desarrollo solo llegan mensajes a los ≤5 destinatarios de prueba. Sin verificación del negocio, límite ~250 conversaciones iniciadas/24 h.

## 4. Workflow n8n

1. Importar `n8n-workflow-pos-venta-whatsapp.json` (Workflows → Import from file).
2. Crear credenciales (Credentials → Header Auth) y asignarlas a los nodos:
   - **POS webhook secret (x-pos-secret)** — nodo Webhook: Name `x-pos-secret`, Value = secreto largo aleatorio (`openssl rand -hex 32`).
   - **Meta WhatsApp token (Authorization)** — nodo HTTP Request: Name `Authorization`, Value `Bearer <token>`.
     - **Prueba inicial:** usá el **token temporal** y el **Phone number ID de prueba** (paso 3.2). La plantilla debe estar en la WABA de prueba y el destino debe ser un número de prueba verificado.
     - **Producción:** cambiá al **token del Usuario del Sistema** (paso 3.5) y al **Phone number ID del número real** (paso 3.6), con la plantilla aprobada en la WABA de Ganesha Store.
3. En el nodo "Enviar plantilla WhatsApp": reemplazar `REEMPLAZAR_PHONE_NUMBER_ID` en la URL por el Phone number ID (de prueba primero, real después).
4. **Activar** el workflow (la URL de producción pasa a ser `/webhook/pos-sale`; la de prueba es `/webhook-test/pos-sale`).

### 4.2. Workflow `meta-eventos` (procesa "Cancelar promociones") — OBLIGATORIO

Sin esto, el botón de baja no hace nada y el número termina degradado por reportes.

1. **Aplicar la migración SQL** primero: `db/whatsapp_marketing_optin.sql` en el SQL Editor de Supabase (agrega `wa_marketing_opt_in` / `wa_opt_out_at`, la función `wa_opt_out_by_phone` y extiende `get_global_points`).
2. Importar `n8n-workflow-meta-eventos.json`.
3. Crear la credencial **Supabase** en n8n (Credentials → Supabase API): Host = la URL del proyecto, Service Role Secret = `SUPABASE_SERVICE_ROLE_KEY`. Asignarla al nodo "Registrar baja en Supabase" y reemplazar `REEMPLAZAR_PROYECTO` en la URL del nodo.
4. **Activar** el workflow.
5. Registrar el webhook en Meta: App Dashboard → **WhatsApp → Configuración** (*Configuration*) → Webhooks → **Editar**:
   - Callback URL: `https://n8n.ganeshastores.com/webhook/meta-wa`
   - Verify token: cualquier string (solo se usa en el handshake).
   - Meta hace un GET de verificación → el workflow responde el `hub.challenge` → **deberías ver el tilde verde**.
   - Luego **Administrar** (*Manage*) → suscribir el campo **`messages`**.
6. Probar: enviarte la plantilla, tocar "Cancelar promociones", y verificar que en `customers` quedó `wa_opt_out_at` con fecha. La siguiente venta de ese cliente ya no dispara mensaje.

> El teléfono se cruza por los **últimos 10 dígitos** (`wa_opt_out_by_phone`), porque `customers.phone` es texto libre (`0414-123.45.67`) y Meta envía `584141234567`.

## 5. POS — variables de entorno

En `.env.local` del VPS (y local si se quiere probar contra el n8n del VPS):

```
N8N_SALE_WEBHOOK_URL=http://127.0.0.1:5678/webhook/pos-sale
N8N_WEBHOOK_SECRET=<el mismo secreto del header x-pos-secret>
```

Si faltan, el POS no envía nada (no-op) y la venta funciona normal. Tras editar: `npm run build && pm2 restart <app>`.

## 6. Verificación end-to-end

1. `curl` directo al webhook (con el workflow activo):
   ```bash
   curl -X POST http://127.0.0.1:5678/webhook/pos-sale \
     -H 'Content-Type: application/json' -H 'x-pos-secret: <secreto>' \
     -d '{"saleId":0,"documentId":"V-TEST","phone":"0414 1234567","pointsEarned":15,"pointsTotal":120}'
   ```
   → debe llegar el WhatsApp (en desarrollo, solo a destinatarios de prueba).
2. Venta real en el POS con cliente con teléfono **y el checkbox de consentimiento marcado** → mensaje con puntos correctos; venta registrada normal.
3. **Venta con cliente SIN el checkbox marcado → no se envía nada** (compuerta de opt-in), venta normal.
4. Venta sin cliente o sin teléfono → no se envía nada, venta normal.
5. Tocar "Cancelar promociones" en el WhatsApp recibido → `wa_opt_out_at` se llena en `customers` → la caja muestra "🔕 Este cliente pidió no recibir promociones" y no se envía más.
6. `docker stop n8n` → la venta cierra sin error visible para el cajero.

## 7. Troubleshooting

| Síntoma | Causa probable |
|---|---|
| API responde 200 con `wamid` pero el mensaje no llega | Falta el método de pago en la cuenta de WhatsApp, o el número es nuevo y la facturación está propagando (~10-15 min). **No es un bug.** |
| Error 132001 (template not found) | El nombre o el idioma no coinciden EXACTO (`confirmacion_compra_puntos` / `es`). |
| Error 131030 (recipient not in allowed list) | App en modo desarrollo: el destinatario no está en la lista de prueba. |
| Error 190 (token) | Token temporal vencido → usar el token del Usuario del Sistema (vencimiento Nunca). |
| n8n no recibe nada | Workflow inactivo (URL `/webhook-test/` vs `/webhook/`), o secreto `x-pos-secret` distinto entre `.env.local` y la credencial. |
