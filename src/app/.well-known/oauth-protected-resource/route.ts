// Metadatos del recurso protegido (RFC 9728): le dicen al cliente (ChatGPT,
// Claude) que /api/mcp se protege con OAuth y quién emite los tokens. Se
// publica en la raíz y con el sufijo de la ruta (/api/mcp), que es lo primero
// que prueba un cliente MCP.
import { NextResponse } from 'next/server';
import { issuerFrom, resourceFrom, SCOPE } from '@/lib/finanzas/oauth/config';

export function GET(req: Request) {
  return NextResponse.json(
    {
      resource: resourceFrom(req),
      authorization_servers: [issuerFrom(req)],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: 'Finanzas GaneshaStores',
    },
    { headers: { 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' } },
  );
}
