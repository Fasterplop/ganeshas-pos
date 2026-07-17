# Fase 2 — Sección "Marketing" (WhatsApp) · DISEÑO (no construido)

Plan de diseño para la sección de marketing por WhatsApp del POS. **No hay código de esto todavía**; se construye en una fase aparte. La regla de arquitectura se mantiene: **solo n8n habla con Meta** — el POS dispara webhooks hacia n8n y lee/escribe su propio estado en Supabase.

> ## ✅ Ya construido en la Fase 1 (adelantado)
> Al quedar la plantilla post-venta categorizada como **MARKETING**, la base de consentimiento
> dejó de ser opcional y se implementó junto con la Fase 1:
> - `customers.wa_marketing_opt_in` + `wa_opt_out_at` (`db/whatsapp_marketing_optin.sql`).
> - RPC `wa_opt_out_by_phone` (baja por teléfono, cruzando últimos 10 dígitos).
> - Checkbox de consentimiento en el checkout del POS + compuerta de opt-in en `notifySaleWhatsApp`.
> - Workflow n8n `meta-eventos`: webhook público de Meta (`/webhook/meta-wa`) con handshake de
>   verificación y procesamiento de "Cancelar promociones" / BAJA / STOP.
>
> **Lo que sigue pendiente de esta fase:** `wa_templates`, `wa_campaigns`, `wa_campaign_recipients`,
> la UI `/marketing`, y los workflows `wa-create-template` / `wa-send-campaign`.
> El webhook `meta-eventos` ya existe: solo hay que **extenderlo** para suscribir además
> `message_template_status_update` y los `statuses` de mensajes.

## Objetivo

Que el `owner` pueda, desde el POS:
1. Crear plantillas de WhatsApp de categoría **MARKETING** y mandarlas a aprobación de Meta.
2. Una vez aprobadas, elegir clientes de la base de datos y enviarles la plantilla (campañas).

## Diferencias clave vs. la Fase 1 (utility)

| | Utility (Fase 1) | Marketing (Fase 2) |
|---|---|---|
| Consentimiento | Aviso presencial suficiente | **Opt-in explícito y registrado** + opt-out automático |
| Costo | Tarifa utility | Tarifa marketing, **mayor**, cobrada por mensaje (tarifas Meta para Venezuela) |
| Aprobación de plantilla | Rápida, texto transaccional | Revisión más estricta; puede ser rechazada o **pausada** por mala calidad |
| Volumen | 1 mensaje por venta | Masivo → sujeto al **límite de mensajería por tier** |

## Modelo de datos (Supabase, todo aditivo)

- **`wa_templates`**: `id, name (slug), language ('es'), category ('MARKETING'), body, variables_count, meta_template_id, status (draft|pending|approved|rejected|paused), rejection_reason, created_at`.
- **`wa_campaigns`**: `id, template_id, name, status (draft|sending|done|failed), variable_mapping (jsonb: por variable, texto fijo o campo del cliente), created_by, created_at, finished_at`.
- **`wa_campaign_recipients`**: `campaign_id, document_id, phone, status (queued|sent|delivered|read|failed), wamid, error, updated_at`. Esta tabla es la **auditoría de envíos** (la Fase 1 no la necesita; aquí sí).
- **`customers`**: `+ wa_marketing_opt_in boolean default false`, `+ wa_opt_out_at timestamptz`. Solo se envía marketing a clientes con `wa_marketing_opt_in = true` y `wa_opt_out_at IS NULL`. El consentimiento presencial de la Fase 1 **no cubre marketing**: hay que capturar el opt-in (checkbox en `/customers` y en el checkout del POS).

## UI: nueva ruta `/marketing` (solo `owner`)

Entrada en `Sidebar.tsx` / `TopBarMenu.tsx`, mismo gate de rol que `/dashboard`.

**Pestaña Plantillas**
- Form: nombre (→ slug automático), cuerpo con insertador de variables `{{n}}`, preview estilo WhatsApp, valores de ejemplo obligatorios (Meta los exige).
- Validaciones en cliente: no empezar ni terminar con variable; idioma fijo `es`; incluir línea de baja ("Envía BAJA para dejar de recibir promociones").
- "Enviar a aprobación" → Server Action → webhook n8n `wa-create-template`. Badges de estado (pendiente/aprobada/rechazada + motivo/pausada).

**Pestaña Campañas**
- Elegir plantilla **aprobada** → mapear variables (texto fijo o campo del cliente: nombre, puntos).
- Selector de destinatarios con filtros: sucursal, **opt-in (obligatorio, no desactivable)**, mínimo de puntos, fecha de última compra.
- Resumen previo: cantidad de destinatarios + **costo estimado** (tarifa marketing × mensajes) → confirmar.
- Vista de progreso: contadores por estado (enviado/entregado/leído/fallido) leyendo `wa_campaign_recipients`.

## Workflows n8n

1. **`wa-create-template`** (webhook desde Server Action): `POST /{WABA_ID}/message_templates` (permiso `whatsapp_business_management`) → guarda `meta_template_id` y `status = pending` en Supabase.
2. **`wa-meta-events`** (webhook PÚBLICO para Meta): configurar en App Dashboard → WhatsApp → Webhooks, callback `https://n8n.ganeshastores.com/webhook/meta-wa` + verify token; suscribir `message_template_status_update` y `messages`:
   - Cambio de estado de plantilla → actualiza `wa_templates.status` (+ `rejection_reason`).
   - Statuses de mensajes (sent/delivered/read/failed) → actualiza `wa_campaign_recipients` por `wamid`.
   - Mensaje entrante "BAJA"/"STOP" (o botón de opt-out) → `wa_opt_out_at = now()` en todas las filas del cliente.
3. **`wa-send-campaign`** (webhook desde Server Action con `campaign_id`): lee destinatarios `queued` desde Supabase (credencial service role **solo en n8n**) → loop con throttle (~1 msg/s) → marca `sent`/`failed` con `wamid`/`error` por fila → al terminar marca la campaña `done`.

## Reglas de negocio

- **Opt-in obligatorio** para cualquier envío de marketing; opt-out procesado automáticamente y respetado para siempre.
- **Cupo diario por tier**: 250 conversaciones/24 h sin verificación del negocio; ~1.000 con verificación; escala con la calidad. La campaña corta al llegar al cupo y reanuda al día siguiente (o avisa al owner).
- **Quality rating**: muchos bloqueos/reportes bajan la calidad y Meta puede **pausar la plantilla**. Estrategia: empezar con segmentos chicos de clientes frecuentes, medir, y recién después ampliar.
- Costo mostrado SIEMPRE antes de confirmar una campaña.

## Prerrequisitos antes de construir

1. Fase 1 estable en producción (número real registrado, token de System User, mensajes llegando).
2. App de Meta en **modo Live** → política de privacidad y términos publicados en ganeshastores.com.
3. **Verificación del negocio** en Meta (recomendada: sube el tier de 250 → 1.000/día).
4. Credencial de Supabase (service role) cargada en n8n.
5. Definir con el cliente el mecanismo de captura del opt-in en tienda.

## Orden de construcción sugerido

1. SQL aditivo (tablas `wa_*` + columnas de opt-in en `customers`).
2. Workflow `wa-meta-events` + configuración del webhook en Meta (base para todo lo demás).
3. Pestaña Plantillas + `wa-create-template` (ciclo completo: crear → aprobar → ver estado).
4. Pestaña Campañas + `wa-send-campaign` (con throttle y cupo diario).
5. Opt-in/opt-out end-to-end (checkbox en POS/customers + baja automática).
