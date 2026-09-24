// POST /api/oauth/token — canjea el código por tokens y renueva tokens.
//
//   authorization_code : código (un solo uso, 10 min) + code_verifier (PKCE
//                        S256) + la misma redirect_uri y client_id.
//   refresh_token      : el de refresco ROTA en cada uso (el viejo deja de
//                        servir), así un token robado se nota al instante.
//
// Tokens opacos: gfin_at_… (acceso, 1 h) y gfin_rt_… (refresco, 90 días).
// En la base solo queda el sha256 (fin_oauth_tokens).
import { createHash } from 'crypto';
import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { ACCESS_PREFIX, REFRESH_PREFIX, generateToken, hashToken } from '@/lib/finanzas/agent/auth';
import { ACCESS_TTL_S, REFRESH_TTL_MS, SCOPE, resourceFrom } from '@/lib/finanzas/oauth/config';
import { getClient } from '@/lib/finanzas/oauth/clients';

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

const oauthError = (error: string, error_description: string, status = 400) =>
  NextResponse.json({ error, error_description }, { status, headers: NO_STORE });

async function readBody(req: Request): Promise<Record<string, string>> {
  const type = req.headers.get('content-type') ?? '';
  if (type.includes('application/json')) {
    const json = (await req.json()) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(json).map(([k, v]) => [k, String(v ?? '')]));
  }
  const form = await req.formData();
  const out: Record<string, string> = {};
  form.forEach((v, k) => {
    if (typeof v === 'string') out[k] = v;
  });
  return out;
}

function newTokens() {
  const access = generateToken(ACCESS_PREFIX);
  const refresh = generateToken(REFRESH_PREFIX);
  return {
    access,
    refresh,
    row: {
      access_hash: hashToken(access),
      access_expires_at: new Date(Date.now() + ACCESS_TTL_S * 1000).toISOString(),
      refresh_hash: hashToken(refresh),
      refresh_expires_at: new Date(Date.now() + REFRESH_TTL_MS).toISOString(),
    },
  };
}

const tokenResponse = (access: string, refresh: string) =>
  NextResponse.json(
    { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: SCOPE },
    { headers: NO_STORE },
  );

export async function POST(req: Request) {
  let body: Record<string, string>;
  try {
    body = await readBody(req);
  } catch {
    return oauthError('invalid_request', 'Cuerpo inválido.');
  }
  const admin = createAdminClient();
  const resource = resourceFrom(req);
  if (body.resource && body.resource !== resource) return oauthError('invalid_target', 'Recurso desconocido.');

  // ---------------------------------------------------------------------------
  if (body.grant_type === 'authorization_code') {
    const { code, code_verifier, redirect_uri, client_id } = body;
    if (!code || !code_verifier || !client_id) return oauthError('invalid_request', 'Faltan code, code_verifier o client_id.');

    // Se marca como usado en la MISMA sentencia que lo busca: dos canjes a la
    // vez del mismo código no pueden ganar los dos.
    const { data: row, error } = await admin
      .from('fin_oauth_codes')
      .update({ used_at: new Date().toISOString() })
      .eq('code_hash', createHash('sha256').update(code).digest('hex'))
      .is('used_at', null)
      .gt('expires_at', new Date().toISOString())
      .select('client_id, profile_id, redirect_uri, code_challenge, resource')
      .maybeSingle();
    if (error) return oauthError('server_error', error.message, 500);
    if (!row) return oauthError('invalid_grant', 'El código no existe, venció o ya se usó.');
    if (row.client_id !== client_id) return oauthError('invalid_grant', 'El código es de otra aplicación.');
    if (redirect_uri && redirect_uri !== row.redirect_uri) return oauthError('invalid_grant', 'redirect_uri no coincide.');

    const challenge = createHash('sha256').update(code_verifier).digest('base64url');
    if (challenge !== row.code_challenge) return oauthError('invalid_grant', 'PKCE: code_verifier no coincide.');

    const client = await getClient(client_id);
    const t = newTokens();
    const { error: insError } = await admin.from('fin_oauth_tokens').insert({
      ...t.row,
      client_id,
      client_name: client?.client_name ?? null,
      profile_id: row.profile_id,
      scope: SCOPE,
      resource: row.resource ?? resource,
    });
    if (insError) return oauthError('server_error', insError.message, 500);
    return tokenResponse(t.access, t.refresh);
  }

  // ---------------------------------------------------------------------------
  if (body.grant_type === 'refresh_token') {
    const { refresh_token, client_id } = body;
    if (!refresh_token?.startsWith(REFRESH_PREFIX)) return oauthError('invalid_grant', 'refresh_token inválido.');

    const { data: row, error } = await admin
      .from('fin_oauth_tokens')
      .select('id, client_id, profile_id, refresh_expires_at, revoked_at')
      .eq('refresh_hash', hashToken(refresh_token))
      .maybeSingle();
    if (error) return oauthError('server_error', error.message, 500);
    if (!row || row.revoked_at || !row.refresh_expires_at || row.refresh_expires_at <= new Date().toISOString()) {
      return oauthError('invalid_grant', 'La conexión venció o fue anulada. Vuelve a conectar.');
    }
    if (client_id && client_id !== row.client_id) return oauthError('invalid_grant', 'El token es de otra aplicación.');

    // Si al usuario le quitaron el rol de dueño, no se renueva.
    const { data: profile } = await admin.from('profiles').select('role').eq('id', row.profile_id).maybeSingle();
    if (profile?.role !== 'owner') return oauthError('invalid_grant', 'Solo el dueño puede usar el conector.');

    const t = newTokens();
    const { data: updated, error: upError } = await admin
      .from('fin_oauth_tokens')
      .update(t.row)
      .eq('id', row.id)
      .eq('refresh_hash', hashToken(refresh_token)) // rotación atómica
      .select('id')
      .maybeSingle();
    if (upError) return oauthError('server_error', upError.message, 500);
    if (!updated) return oauthError('invalid_grant', 'El token de refresco ya se usó.');
    return tokenResponse(t.access, t.refresh);
  }

  return oauthError('unsupported_grant_type', 'Solo authorization_code y refresh_token.');
}
