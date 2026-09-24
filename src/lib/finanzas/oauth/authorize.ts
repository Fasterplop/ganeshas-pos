// Validación de una solicitud de autorización (/oauth/authorize), compartida
// por la pantalla de "Permitir" (GET) y por la decisión del dueño (POST).
//
// Orden que exige OAuth: si el cliente o la URL de retorno no son válidos, NO
// se redirige (se muestra el error en pantalla); cualquier otro error sí se
// devuelve al cliente en la URL de retorno, con `state` e `iss`.
import { createHash, randomBytes } from 'crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { getClient, type OAuthClient } from './clients';
import { CODE_TTL_MS, SCOPE } from './config';

export const AUTHORIZE_FIELDS = [
  'response_type',
  'client_id',
  'redirect_uri',
  'code_challenge',
  'code_challenge_method',
  'state',
  'scope',
  'resource',
] as const;

export type AuthorizeParams = Partial<Record<(typeof AUTHORIZE_FIELDS)[number], string>>;

export type AuthorizeCheck =
  | { kind: 'fatal'; message: string }
  | { kind: 'error_redirect'; url: string }
  | { kind: 'ok'; client: OAuthClient; params: AuthorizeParams & { redirect_uri: string; code_challenge: string } };

/** URL de retorno con parámetros, siempre con `iss` (RFC 9207) y `state`. */
export function redirectWith(redirectUri: string, issuer: string, state: string | undefined, extra: Record<string, string>): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  if (state) url.searchParams.set('state', state);
  url.searchParams.set('iss', issuer);
  return url.toString();
}

export async function checkAuthorize(params: AuthorizeParams, issuer: string, resource: string): Promise<AuthorizeCheck> {
  const client = params.client_id ? await getClient(params.client_id) : null;
  if (!client) return { kind: 'fatal', message: 'La aplicación que pide acceso no está registrada o no es válida.' };

  // Si trae una sola URL registrada, se puede omitir; si no, tiene que ser exacta.
  const redirect_uri = params.redirect_uri ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : undefined);
  if (!redirect_uri || !client.redirect_uris.includes(redirect_uri)) {
    return { kind: 'fatal', message: 'La dirección de retorno no coincide con la registrada por la aplicación.' };
  }

  const fail = (error: string, error_description: string): AuthorizeCheck => ({
    kind: 'error_redirect',
    url: redirectWith(redirect_uri, issuer, params.state, { error, error_description }),
  });

  if (params.response_type !== 'code') return fail('unsupported_response_type', 'Solo se admite response_type=code.');
  if (!params.code_challenge || params.code_challenge_method !== 'S256') {
    return fail('invalid_request', 'Se requiere PKCE con code_challenge_method=S256.');
  }
  if (params.resource && params.resource !== resource) return fail('invalid_target', 'Recurso desconocido.');
  const scopes = (params.scope ?? SCOPE).split(/\s+/).filter(Boolean);
  if (scopes.some((s) => s !== SCOPE)) return fail('invalid_scope', `El único alcance disponible es "${SCOPE}".`);

  return { kind: 'ok', client, params: { ...params, redirect_uri, code_challenge: params.code_challenge } };
}

/** Crea el código de autorización (un solo uso, 10 min). Devuelve el código. */
export async function issueCode(opts: {
  clientId: string;
  profileId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
}): Promise<string> {
  const code = randomBytes(32).toString('base64url');
  const { error } = await createAdminClient()
    .from('fin_oauth_codes')
    .insert({
      code_hash: createHash('sha256').update(code).digest('hex'),
      client_id: opts.clientId,
      profile_id: opts.profileId,
      redirect_uri: opts.redirectUri,
      code_challenge: opts.codeChallenge,
      scope: SCOPE,
      resource: opts.resource,
      expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
    });
  if (error) throw new Error(`No se pudo crear el código: ${error.message}`);
  return code;
}
