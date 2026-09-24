// Autenticación del conector de Finanzas.
//
// Dos tipos de token, ambos por `Authorization: Bearer <token>`:
//   - gfin_at_…  : token de acceso OAuth (fin_oauth_tokens). Lo obtiene el
//                  plugin de ChatGPT al conectarse (/api/oauth/*). Dura 1 hora
//                  y ChatGPT lo renueva con el de refresco.
//   - gfin_…     : token manual (fin_api_tokens), generado en Finanzas >
//                  Bandeja. Sirve para probar con curl o para otro cliente.
// En la base solo existe el sha256 de cada uno. Un token anulado (revoked_at)
// deja de servir al instante, y el usuario tiene que seguir siendo dueño.
//
// NUNCA loguear el token ni el encabezado Authorization.
import { createHash, randomBytes } from 'crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { isMissingTableError } from '@/lib/finanzas/errors';
import type { AgentContext } from './tool';

export type { AgentContext } from './tool';

/** Prefijo reconocible: si alguien pega el token en otro lado, se nota qué es. */
export const TOKEN_PREFIX = 'gfin_';
export const ACCESS_PREFIX = 'gfin_at_';
export const REFRESH_PREFIX = 'gfin_rt_';

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateToken(prefix = TOKEN_PREFIX): string {
  return prefix + randomBytes(32).toString('base64url');
}

export function jsonError(status: number, error: string, detail?: unknown) {
  return NextResponse.json({ error, ...(detail !== undefined ? { detail } : {}) }, { status });
}

export type AuthResult =
  | { ok: true; ctx: AgentContext }
  | { ok: false; status: 401 | 403 | 500 | 503; message: string };

function bearer(req: NextRequest | Request): string | null {
  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match && match[1].startsWith(TOKEN_PREFIX) ? match[1] : null;
}

/** Valida el token de la petición. No responde: devuelve qué pasó. */
export async function authenticate(req: NextRequest | Request): Promise<AuthResult> {
  const token = bearer(req);
  if (!token) return { ok: false, status: 401, message: 'Falta el token o no es válido.' };

  const admin = createAdminClient();
  const hash = hashToken(token);
  const now = new Date().toISOString();
  let profileId: string | null = null;

  if (token.startsWith(ACCESS_PREFIX)) {
    const { data, error } = await admin
      .from('fin_oauth_tokens')
      .select('id, profile_id, access_expires_at, revoked_at')
      .eq('access_hash', hash)
      .maybeSingle();
    if (error) {
      return isMissingTableError(error)
        ? { ok: false, status: 503, message: 'Falta correr db/finanzas_08_oauth.sql en Supabase.' }
        : { ok: false, status: 500, message: 'No se pudo validar el token.' };
    }
    if (data && !data.revoked_at && data.access_expires_at > now) {
      profileId = data.profile_id as string;
      touch(admin.from('fin_oauth_tokens').update({ last_used_at: now }).eq('id', data.id));
    } else if (data) {
      return { ok: false, status: 401, message: 'La sesión venció o fue anulada. Vuelve a conectar.' };
    }
  }

  if (!profileId) {
    const { data, error } = await admin
      .from('fin_api_tokens')
      .select('id, profile_id, revoked_at')
      .eq('token_hash', hash)
      .maybeSingle();
    if (error) {
      return isMissingTableError(error)
        ? { ok: false, status: 503, message: 'Falta correr db/finanzas_07_chatgpt.sql en Supabase.' }
        : { ok: false, status: 500, message: 'No se pudo validar el token.' };
    }
    if (!data || data.revoked_at) return { ok: false, status: 401, message: 'Token inválido o anulado.' };
    profileId = data.profile_id as string;
    touch(admin.from('fin_api_tokens').update({ last_used_at: now }).eq('id', data.id));
  }

  // Si al usuario le quitaron el rol de dueño, sus tokens dejan de servir.
  const { data: profile } = await admin.from('profiles').select('role').eq('id', profileId).maybeSingle();
  if (profile?.role !== 'owner') return { ok: false, status: 403, message: 'Solo el dueño puede usar el conector.' };

  return { ok: true, ctx: { admin, profileId } };
}

/**
 * Sello de último uso: informativo, no se espera ni se reintenta. OJO: el
 * builder de Supabase es perezoso; sin .then() la consulta nunca sale.
 */
function touch(q: PromiseLike<unknown>) {
  q.then(
    () => undefined,
    () => undefined,
  );
}

/**
 * Envuelve un handler REST: valida el token, y si el handler revienta
 * devuelve un 500 con el mensaje (sin stack).
 */
export function withAgent(handler: (req: NextRequest, ctx: AgentContext) => Promise<Response>) {
  return async (req: NextRequest) => {
    const auth = await authenticate(req);
    if (!auth.ok) return jsonError(auth.status, auth.message);
    try {
      return await handler(req, auth.ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[fin-agent] error:', msg);
      return jsonError(500, msg);
    }
  };
}
