// /api/mcp — servidor MCP de Finanzas (lo que conecta el plugin de ChatGPT).
//
// Transporte "Streamable HTTP" SIN estado y con respuestas JSON: cada POST
// arma un servidor, atiende el mensaje y se descarta. Encaja con pm2 en modo
// cluster (dos procesos) sin tener que compartir sesiones entre ellos.
//
// Autenticación OAuth 2.1: sin token válido responde 401 con
// WWW-Authenticate → resource_metadata, y el cliente (ChatGPT) arranca solo el
// login del dueño (/oauth/authorize). Ver src/lib/finanzas/oauth y
// db/finanzas_08_oauth.sql.
//
// Las herramientas son las mismas de /api/fin-agent (src/lib/finanzas/agent/
// tools). Solo enviar_a_bandeja escribe, y solo en la Bandeja.
import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { authenticate } from '@/lib/finanzas/agent/auth';
import { FIN_TOOLS } from '@/lib/finanzas/agent/tools';
import { zodMessage } from '@/lib/finanzas/agent/params';
import { SERVER_INSTRUCTIONS, SERVER_NAME } from '@/lib/finanzas/agent/instructions';
import { resourceMetadataUrl, SCOPE } from '@/lib/finanzas/oauth/config';
import type { AgentContext } from '@/lib/finanzas/agent/tool';

const SECURITY = [{ type: 'oauth2', scopes: [SCOPE] }];

// Descriptores de las herramientas: se calculan una vez por proceso.
const TOOL_DESCRIPTORS = FIN_TOOLS.map((t) => {
  const inputSchema = z.toJSONSchema(t.input, { io: 'input' }) as Record<string, unknown>;
  delete inputSchema.$schema;
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema,
    annotations: {
      title: t.title,
      readOnlyHint: t.readOnly,
      destructiveHint: false, // nada borra ni pisa: lo que se escribe queda pendiente
      idempotentHint: t.readOnly,
      openWorldHint: false, // solo las finanzas de este negocio
    },
    // ChatGPT lee `securitySchemes` arriba; algunos clientes solo _meta.
    securitySchemes: SECURITY,
    _meta: { securitySchemes: SECURITY },
  };
});

function buildServer(ctx: AgentContext) {
  const server = new Server(
    { name: SERVER_NAME, version: '1.0.0' },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DESCRIPTORS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = FIN_TOOLS.find((t) => t.name === request.params.name);
    if (!tool) {
      return { isError: true, content: [{ type: 'text' as const, text: `Herramienta desconocida: ${request.params.name}` }] };
    }
    const parsed = tool.input.safeParse(request.params.arguments ?? {});
    if (!parsed.success) {
      return { isError: true, content: [{ type: 'text' as const, text: `Parámetros inválidos: ${zodMessage(parsed.error)}` }] };
    }
    try {
      const result = await tool.run(ctx, parsed.data);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[mcp] ${tool.name}:`, msg);
      return { isError: true, content: [{ type: 'text' as const, text: `Error: ${msg}` }] };
    }
  });

  return server;
}

function unauthorized(req: Request, status: number, message: string) {
  const challenge =
    `Bearer resource_metadata="${resourceMetadataUrl(req)}", scope="${SCOPE}"` +
    (req.headers.get('authorization') ? `, error="invalid_token", error_description="${message}"` : '');
  return new Response(JSON.stringify({ error: status === 401 ? 'invalid_token' : 'forbidden', error_description: message }), {
    status,
    headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': challenge },
  });
}

export async function POST(req: Request) {
  const auth = await authenticate(req);
  if (!auth.ok) {
    return auth.status === 401 || auth.status === 403
      ? unauthorized(req, auth.status, auth.message)
      : Response.json({ error: auth.message }, { status: auth.status });
  }

  const server = buildServer(auth.ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // sin estado
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // Con respuestas JSON la respuesta ya está completa: se libera todo.
    void transport.close();
    void server.close();
  }
}

// Sin estado no hay flujo SSE que abrir (GET) ni sesión que cerrar (DELETE).
const notAllowed = () =>
  new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Método no permitido.' }, id: null }), {
    status: 405,
    headers: { Allow: 'POST', 'Content-Type': 'application/json' },
  });
export const GET = notAllowed;
export const DELETE = notAllowed;
