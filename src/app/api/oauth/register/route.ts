// POST /api/oauth/register — registro dinámico de clientes (RFC 7591).
//
// Lo usa un cliente MCP que no se presenta con documento de metadatos (Claude,
// o ChatGPT si se elige DCR). Solo clientes públicos: no se emite secreto, la
// seguridad la dan PKCE, el login del dueño y la lista cerrada de URLs de
// retorno (isAllowedRedirect).
import { randomBytes } from 'crypto';
import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { isAllowedRedirect } from '@/lib/finanzas/oauth/config';

const oauthError = (error: string, error_description: string) =>
  NextResponse.json({ error, error_description }, { status: 400 });

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return oauthError('invalid_client_metadata', 'El cuerpo debe ser JSON.');
  }

  const redirect_uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (!redirect_uris.length || redirect_uris.length > 10 || !redirect_uris.every((u) => typeof u === 'string')) {
    return oauthError('invalid_redirect_uri', 'Faltan redirect_uris.');
  }
  const bad = (redirect_uris as string[]).find((u) => !isAllowedRedirect(u));
  if (bad) return oauthError('invalid_redirect_uri', `URL de retorno no permitida: ${bad}`);

  const method = body.token_endpoint_auth_method ?? 'none';
  if (method !== 'none') {
    return oauthError('invalid_client_metadata', 'Solo se aceptan clientes públicos (token_endpoint_auth_method=none) con PKCE.');
  }

  const client_name = typeof body.client_name === 'string' ? body.client_name.slice(0, 100) : null;
  const client_id = `gfin_client_${randomBytes(16).toString('hex')}`;

  const { error } = await createAdminClient()
    .from('fin_oauth_clients')
    .insert({ client_id, client_name, redirect_uris, kind: 'dcr', metadata: body });
  if (error) return NextResponse.json({ error: 'server_error', error_description: error.message }, { status: 500 });

  return NextResponse.json(
    {
      client_id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name,
      redirect_uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
    { status: 201, headers: { 'Cache-Control': 'no-store' } },
  );
}
