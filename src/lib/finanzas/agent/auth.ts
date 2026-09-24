// Autenticación del conector de ChatGPT (/api/fin-agent/*).
//
// El GPT manda `Authorization: Bearer <token>`. En la base solo existe el
// sha256 del token (fin_api_tokens.token_hash), así que se hashea lo recibido
// y se busca. Un token anulado (revoked_at) deja de servir al instante.
//
// NUNCA loguear el token ni el encabezado Authorization.
import { createHash, randomBytes } from 'crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { isMissingTableError } from '@/lib/finanzas/errors';

type Admin = ReturnType<typeof createAdminClient>;

export interface AgentContext {
  admin: Admin;
  /** Dueño del token: queda como created_by de lo que entra. */
  profileId: string;
}

/** Prefijo reconocible: si alguien pega el token en otro lado, se nota qué es. */
const TOKEN_PREFIX = 'gfin_';

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

export function jsonError(status: number, error: string, detail?: unknown) {
  return NextResponse.json({ error, ...(detail !== undefined ? { detail } : {}) }, { status });
}

/**
 * Envuelve un handler: valida el token, y si el handler revienta devuelve un
 * 500 con el mensaje (sin stack) para que el GPT pueda contárselo al dueño.
 */
export function withAgent(
  handler: (req: NextRequest, ctx: AgentContext) => Promise<Response>,
) {
  return async (req: NextRequest) => {
    const header = req.headers.get('authorization') ?? '';
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    if (!match || !match[1].startsWith(TOKEN_PREFIX)) {
      return jsonError(401, 'Falta el token o no es válido.');
    }

    const admin = createAdminClient();
    const { data: tok, error } = await admin
      .from('fin_api_tokens')
      .select('id, profile_id, revoked_at')
      .eq('token_hash', hashToken(match[1]))
      .maybeSingle();

    if (error) {
      // Las migraciones se aplican a mano: el código puede estar desplegado
      // antes que db/finanzas_07_chatgpt.sql.
      if (isMissingTableError(error)) {
        return jsonError(503, 'El conector todavía no está instalado: falta correr db/finanzas_07_chatgpt.sql en Supabase.');
      }
      return jsonError(500, 'No se pudo validar el token.');
    }
    if (!tok || tok.revoked_at) return jsonError(401, 'Token inválido o anulado.');

    // Sello de último uso: informativo, no se espera ni se reintenta. OJO: el
    // builder de Supabase es perezoso; sin .then() la consulta nunca sale.
    admin
      .from('fin_api_tokens')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', tok.id)
      .then(
        () => undefined,
        () => undefined,
      );

    try {
      return await handler(req, { admin, profileId: tok.profile_id as string });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[fin-agent] error:', msg);
      return jsonError(500, msg);
    }
  };
}

/** Lanza si la consulta de Supabase falló; así el handler queda lineal. */
export function must<T>(res: { data: T | null; error: { message?: string } | null }, what: string): T | null {
  if (res.error) throw new Error(`${what}: ${res.error.message ?? 'error de base de datos'}`);
  return res.data;
}

/** Igual que `must`, para listas: nunca devuelve null. */
export function mustList<T>(res: { data: T[] | null; error: { message?: string } | null }, what: string): T[] {
  return must(res, what) ?? [];
}
