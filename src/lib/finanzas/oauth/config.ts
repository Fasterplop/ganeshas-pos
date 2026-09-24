// Configuración del servidor OAuth 2.1 del POS (para el plugin de ChatGPT).
//
// El POS es a la vez:
//   - servidor de recursos : /api/mcp (el servidor MCP de Finanzas)
//   - servidor de autorización : /oauth/authorize, /api/oauth/token,
//                                /api/oauth/register
// Ver db/finanzas_08_oauth.sql y deploy/chatgpt/README.md.
//
// !! El `issuer` tiene que ser EXACTAMENTE el mismo texto en todos lados
// (metadatos, parámetro iss de la respuesta, authorization_servers): ChatGPT
// compara sin normalizar barras, puertos ni mayúsculas.

/** Cualquier cosa con encabezados: un Request o el headers() de Next. */
export type HasHeaders = { headers: { get(name: string): string | null } };

/** Origen público del POS. Fuera de la red local siempre https. */
export function issuerFrom(req: HasHeaders): string {
  const env = process.env.FIN_OAUTH_ISSUER?.replace(/\/+$/, '');
  if (env) return env;
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? 'pos.ganeshastores.com';
  const local = /^(localhost|127\.|192\.168\.|10\.)/.test(host);
  return `${local ? 'http' : 'https'}://${host}`;
}

export const MCP_PATH = '/api/mcp';
export const resourceFrom = (req: HasHeaders) => `${issuerFrom(req)}${MCP_PATH}`;
export const resourceMetadataUrl = (req: HasHeaders) =>
  `${issuerFrom(req)}/.well-known/oauth-protected-resource${MCP_PATH}`;

export const SCOPE = 'finanzas';

export const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutos
export const ACCESS_TTL_S = 60 * 60; // 1 hora
export const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 días (rota en cada uso)

/**
 * A dónde puede volver una autorización. Lista cerrada a propósito: con
 * registro dinámico abierto, cualquiera podría registrar un cliente que
 * devuelva el código a SU servidor y mandarle al dueño el enlace de "Permitir".
 * Solo ChatGPT y Claude (y localhost para probar).
 */
const ALLOWED_REDIRECT_HOSTS = ['chatgpt.com', 'chat.openai.com', 'claude.ai', 'claude.com'];

export function isAllowedRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === 'http:') return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    return u.protocol === 'https:' && ALLOWED_REDIRECT_HOSTS.includes(u.hostname) && !u.hash;
  } catch {
    return false;
  }
}

/** Documentos de metadatos de cliente (CIMD) que se aceptan: los mismos hosts. */
export function isAllowedMetadataUrl(clientId: string): boolean {
  try {
    const u = new URL(clientId);
    return u.protocol === 'https:' && ALLOWED_REDIRECT_HOSTS.includes(u.hostname) && u.pathname !== '/';
  } catch {
    return false;
  }
}
