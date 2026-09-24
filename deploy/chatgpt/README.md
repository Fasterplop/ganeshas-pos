# ChatGPT conectado a Finanzas

Gerardo sube a un GPT personalizado ("Finanzas Ganesha") el estado de cuenta que ya
descarga del banco. El GPT lo lee, lo compara con lo que ya está en el POS y
deja las compras, gastos y abonos que faltan en **Finanzas → Bandeja**. Nada se
registra hasta que Gerardo lo aprueba ahí.

**Regla del negocio:** el GPT **no toca Cuentas**. No registra cargos ni pagos a
tarjetas, ni cambia saldos. El saldo de las cuentas es manual
(`db/finanzas_06_saldo_manual.sql`). La tarjeta solo queda anotada como forma de
pago de la compra o el gasto.

## Piezas

| Pieza | Dónde |
|---|---|
| Tablas `fin_api_tokens` y `fin_inbox`, y RPC `fin_inbox_approve` | `db/finanzas_07_chatgpt.sql` |
| API para el GPT, autenticada con un token Bearer | `src/app/api/fin-agent/*` |
| Esquema OpenAPI que se importa en el GPT | `GET /api/fin-agent/openapi.json` |
| Bandeja de revisión y "Conectar ChatGPT" | `src/app/(dashboard)/finanzas/bandeja/page.tsx` |
| Instrucciones del GPT (una sola fuente) | `src/lib/finanzas/agent/gptInstructions.ts` |

## Instalación (una vez)

1. Correr `db/finanzas_07_chatgpt.sql` en el SQL Editor de Supabase. La
   verificación al final debe decir `rls_activa = true` en las dos tablas.
2. Desplegar el POS como siempre (git pull, npm install, npm run build, pm2 reload).
3. Entrar como dueño a **Finanzas → Bandeja → 🤖 Conectar ChatGPT** y hacer clic en
   **Generar token**. El token se ve una sola vez: se copia en ese momento.
4. En la cuenta de ChatGPT de Gerardo (Plus o superior): **Explorar GPT → Crear →
   Configurar**.
   - Nombre, descripción e instrucciones: se copian desde el mismo modal (botón
     "Copiar instrucciones").
   - Funciones: dejar activado **Intérprete de código** (para leer PDF y Excel).
   - **Crear nueva acción → Importar desde URL:**
     `https://pos.ganeshastores.com/api/fin-agent/openapi.json`
   - **Autenticación → Clave de API → Bearer**, y pegar el token.
   - Guardar como **Solo yo**. Al ser privado, no pide política de privacidad.
5. Probar: subir un estado de cuenta viejo y revisar que las líneas lleguen a
   la Bandeja.

## Endpoints

Todos exigen `Authorization: Bearer gfin_…`. Todos son de solo lectura, salvo
`POST /proposals`, que solo escribe en la bandeja.

- `GET /context`: cuentas, proveedores, categorías, tasa BCV de hoy y reglas.
- `GET /bcv?date=`: tasa guardada para ese día (`null` si no hay).
- `GET /expenses`: compras y gastos. Filtros: `from`, `to`, `kind`, `supplier_id`, `status=abiertas`, `q`.
- `GET /payments`: pagos registrados. Se usa para detectar lo que ya está en el sistema.
- `GET /summary/suppliers`: deuda por proveedor y consolidado de compras por proveedor.
- `GET /summary/due?days=7`: vencimientos, corte y pago de tarjetas, suscripciones.
- `GET /summary/month?month=`: gasto por categoría y presupuesto contra lo real.
- `GET /accounts`: saldos. Son manuales y aquí son solo lectura.
- `POST /proposals`, `GET /proposals`: enviar líneas a la bandeja y ver lo pendiente.

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

## Anular el acceso

En **Finanzas → Bandeja → Conectar ChatGPT**, botón **Anular**. El GPT recibe 401
desde ese momento.
