// Metadatos del servidor de autorización (RFC 8414).
//
// Solo clientes públicos con PKCE S256 (token_endpoint_auth_methods = none):
// ChatGPT y Claude no guardan secretos nuestros. Se aceptan las dos formas de
// registrarse: documento de metadatos (CIMD, la que prefiere ChatGPT) y
// registro dinámico (DCR). `authorization_response_iss_parameter_supported`
// obliga a mandar `iss` en cada respuesta de /oauth/authorize, y a cambio
// ChatGPT usa su URL de retorno fija.
import { NextResponse } from 'next/server';
import { issuerFrom, SCOPE } from '@/lib/finanzas/oauth/config';

export function GET(req: Request) {
  const issuer = issuerFrom(req);
  return NextResponse.json(
    {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/api/oauth/token`,
      registration_endpoint: `${issuer}/api/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [SCOPE],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      service_documentation: `${issuer}/finanzas/bandeja`,
    },
    { headers: { 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' } },
  );
}
