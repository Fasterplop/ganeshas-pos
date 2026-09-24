// Clientes OAuth: quién puede pedir acceso (ChatGPT, Claude).
//
// Dos formas de presentarse:
//   - CIMD: el client_id ES una URL (https://chatgpt.com/oauth/client.json)
//     con los metadatos del cliente. Se descarga, se valida y se guarda 24 h.
//   - DCR : el cliente se registró antes en /api/oauth/register y tiene un
//     client_id generado por nosotros.
import { createAdminClient } from '@/lib/supabase/admin';
import { isAllowedMetadataUrl, isAllowedRedirect } from './config';

export interface OAuthClient {
  client_id: string;
  client_name: string | null;
  redirect_uris: string[];
}

const CIMD_TTL_MS = 24 * 60 * 60 * 1000;

export async function getClient(clientId: string): Promise<OAuthClient | null> {
  if (!clientId || clientId.length > 500) return null;
  const admin = createAdminClient();

  const { data: row } = await admin
    .from('fin_oauth_clients')
    .select('client_id, client_name, redirect_uris, kind, refreshed_at')
    .eq('client_id', clientId)
    .maybeSingle();

  if (row && (row.kind === 'dcr' || Date.now() - new Date(row.refreshed_at).getTime() < CIMD_TTL_MS)) {
    return { client_id: row.client_id, client_name: row.client_name, redirect_uris: row.redirect_uris };
  }

  if (!isAllowedMetadataUrl(clientId)) return row ? { ...row } : null;

  const doc = await fetchMetadata(clientId);
  if (!doc) return row ? { ...row } : null; // si falla la descarga, se usa la copia guardada

  const client: OAuthClient = { client_id: clientId, client_name: doc.client_name, redirect_uris: doc.redirect_uris };
  await admin.from('fin_oauth_clients').upsert({
    client_id: clientId,
    client_name: doc.client_name,
    redirect_uris: doc.redirect_uris,
    kind: 'cimd',
    metadata: doc.raw,
    refreshed_at: new Date().toISOString(),
  });
  return client;
}

async function fetchMetadata(url: string): Promise<{ client_name: string | null; redirect_uris: string[]; raw: unknown } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error', headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > 64_000) return null;
    const raw = JSON.parse(text) as { client_id?: unknown; client_name?: unknown; redirect_uris?: unknown };
    // El documento tiene que decir que ES ese cliente (evita que una URL
    // se haga pasar por otra).
    if (raw.client_id !== url || !Array.isArray(raw.redirect_uris)) return null;
    const redirect_uris = raw.redirect_uris.filter((u): u is string => typeof u === 'string' && isAllowedRedirect(u));
    if (!redirect_uris.length) return null;
    return { client_name: typeof raw.client_name === 'string' ? raw.client_name.slice(0, 100) : null, redirect_uris, raw };
  } catch {
    return null;
  }
}

/** Nombre legible del cliente para la pantalla de "Permitir". */
export function clientLabel(client: OAuthClient): string {
  if (client.client_name) return client.client_name;
  try {
    return new URL(client.redirect_uris[0]).hostname;
  } catch {
    return 'Aplicación externa';
  }
}
