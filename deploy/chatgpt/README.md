# ChatGPT conectado a Finanzas (plugin MCP)

Gerardo le sube al plugin **Finanzas Ganesha** el estado de cuenta que ya
descarga del banco. El plugin lo lee, lo compara con lo que ya está en el POS y
deja las compras, gastos y abonos que faltan en **Finanzas → Bandeja**. Nada se
registra hasta que Gerardo lo aprueba ahí.

**Por qué un plugin y no un GPT:** OpenAI retira los GPT personalizados el
11 de diciembre de 2026, y desde el 26 de octubre ya no se pueden crear. Su
reemplazo son los plugins, que se conectan a un servidor MCP con login OAuth.

**Regla del negocio:** el conector **no toca Cuentas**. No registra cargos ni
pagos a tarjetas, ni cambia saldos. El saldo de las cuentas es manual
(`db/finanzas_06_saldo_manual.sql`). La tarjeta solo queda anotada como forma de
pago de la compra o el gasto.

## Piezas

| Pieza | Dónde |
|---|---|
| Bandeja (`fin_inbox`), tokens manuales y RPC `fin_inbox_approve` | `db/finanzas_07_chatgpt.sql` |
| Clientes, códigos y tokens OAuth | `db/finanzas_08_oauth.sql` |
| Herramientas (una sola implementación) | `src/lib/finanzas/agent/tools/*` |
| Servidor MCP (Streamable HTTP, sin estado) | `POST /api/mcp` |
| Instrucciones que lee ChatGPT | `src/lib/finanzas/agent/instructions.ts` |
| Metadatos OAuth | `/.well-known/oauth-protected-resource[/api/mcp]` y `/.well-known/oauth-authorization-server` |
| Login: pantalla "Permitir" y decisión | `/oauth/authorize` y `POST /api/oauth/authorize` |
| Canje y renovación de tokens | `POST /api/oauth/token` |
| Registro dinámico de clientes (Claude) | `POST /api/oauth/register` |
| Misma API en REST, con token manual (para curl) | `/api/fin-agent/*` |
| Bandeja y "Conectar ChatGPT" | `src/app/(dashboard)/finanzas/bandeja/page.tsx` |

## Cómo funciona el login

1. ChatGPT llama a `/api/mcp` sin token y recibe un 401 con
   `WWW-Authenticate: Bearer resource_metadata=…`.
2. Lee los metadatos y se presenta con su documento de cliente (CIMD,
   `https://chatgpt.com/oauth/client.json`). Claude, en cambio, se registra por
   DCR.
3. Abre `/oauth/authorize` con PKCE S256. Si no hay sesión, se pasa por
   `/login?next=…`. Solo el dueño puede tocar **Permitir**.
4. Vuelve a ChatGPT con `code`, `state` e `iss`. ChatGPT canjea el código en
   `/api/oauth/token` y recibe dos tokens:
   - `gfin_at_…`, de acceso, que dura 1 hora;
   - `gfin_rt_…`, de refresco, que dura 90 días y cambia cada vez que se usa.

**Seguridad:**
- Solo se aceptan direcciones de retorno de `chatgpt.com`, `claude.ai` y
  `claude.com` (y `localhost` para pruebas). Así nadie puede registrar un
  cliente propio y mandarle a Gerardo el enlace de "Permitir".
- Solo se guarda el sha256 de cada código y de cada token.
- Si el usuario deja de ser dueño, sus tokens dejan de funcionar.
- En toda la conexión, lo único que escribe es la herramienta
  `enviar_a_bandeja`, y solo en la Bandeja. ChatGPT además pide confirmación
  antes de usar herramientas que escriben.

## Instalación (una vez)

1. Correr `db/finanzas_08_oauth.sql` en el SQL Editor de Supabase, después del
   07. La verificación al final debe decir `rls_activa = true` en las tres
   tablas, con 1, 0 y 2 políticas.
2. Desplegar el POS como siempre.
3. **En ChatGPT (plan Business):**
   1. Ir a **Configuración → Seguridad e inicio de sesión → Modo
      desarrollador** y activarlo. Si no aparece, el administrador del espacio
      de trabajo tiene que habilitar el modo desarrollador o los conectores
      personalizados.
   2. En **chatgpt.com/plugins**, tocar **+**, poner de nombre
      **Finanzas Ganesha**, pegar la dirección
      `https://pos.ganeshastores.com/api/mcp` y elegir autenticación **OAuth**.
   3. Tocar **Conectar**. Se abre el POS: entrar con el usuario del dueño y
      tocar **Permitir**.
4. Probar: en un chat, llamar a `@Finanzas Ganesha` y preguntarle "¿qué cuentas
   tengo?".

Las conexiones activas se ven y se anulan en **Finanzas → Bandeja → Conectar
ChatGPT**.

## Herramientas

| Herramienta | Qué hace |
|---|---|
| `obtener_contexto` | Cuentas, proveedores, categorías, tasa BCV de hoy y reglas. |
| `tasa_bcv` | Tasa guardada para una fecha (`null` si no hay). |
| `listar_compras_gastos` | Compras y gastos. Filtros: fechas, tipo, proveedor, `status=abiertas`, texto. |
| `listar_pagos` | Pagos registrados. Se usa para detectar lo que ya está en el sistema. |
| `resumen_proveedores` | Deuda por proveedor y consolidado de compras por proveedor. |
| `vencimientos` | Lo que vence, corte y pago de tarjetas, suscripciones. |
| `resumen_mes` | Gasto por categoría y presupuesto contra lo real. |
| `saldos_cuentas` | Saldos. Son manuales y aquí son solo lectura. |
| `ver_bandeja` | Lo que está esperando aprobación. |
| `enviar_a_bandeja` | **La única que escribe**, y solo en la Bandeja. |

## Repetidos

Cada línea recibe una `dedup_key` con este formato:
`cuenta|fecha|monto|referencia (o hash del texto)|n° de ocurrencia en el lote`.
Esa llave es única en `fin_inbox`, sin importar el estado de la línea.

- **Mismo archivo subido otra vez:** no se duplica nada, y lo que se descartó
  antes no vuelve a aparecer.
- **Línea ya registrada en el sistema:** si ya existe un pago en esa cuenta, ese
  día y por ese monto, o con la misma referencia, la línea se salta y se informa
  como `ya_existe`.
- **Cobros idénticos en el mismo archivo:** cuentan como dos, porque son
  entregas parciales del proveedor.
- **Coincidencias parecidas:** mismo monto con ±3 días de diferencia, o una
  compra pendiente del proveedor por ese monto. La línea se agrega igual, pero
  con un aviso visible en la Bandeja.

## Probar con curl (token manual)

Generar un token en **Finanzas → Bandeja → Conectar ChatGPT → Avanzado**:

```bash
curl -H "Authorization: Bearer gfin_…" https://pos.ganeshastores.com/api/fin-agent/context
```

El mismo token sirve en `/api/mcp`.
