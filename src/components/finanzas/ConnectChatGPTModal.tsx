'use client';

// Conectar ChatGPT (plugin) a Finanzas.
//
// El plugin se conecta al servidor MCP del POS (/api/mcp) y entra con OAuth:
// el dueño toca "Conectar" en ChatGPT, aprueba en /oauth/authorize y listo.
// Aquí se ven esas conexiones y se anulan. El token manual queda como opción
// avanzada, para probar con curl u otro cliente.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Modal from '@/components/Modal';
import { createClient } from '@/lib/supabase/client';
import { createFinAgentToken } from '@/app/(dashboard)/finanzas/actions';
import { FinNotice, Notice, btnPrimary, btnSecondary, btnDanger, inputClass } from '@/components/finanzas/ui';
import { formatDateTime } from '@/lib/finanzas/dates';
import { finErrorMessage, isMissingTableError } from '@/lib/finanzas/errors';

interface Connection {
  id: string;
  client_name: string | null;
  client_id: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface TokenRow {
  id: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

function CopyButton({ text, label = 'Copiar' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={btnSecondary}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          window.prompt('Copia el texto:', text);
        }
      }}
    >
      {done ? '✓ Copiado' : label}
    </button>
  );
}

// El contenido se monta solo mientras está abierto: al cerrar se pierde el
// token manual recién generado, que es justo lo que se quiere (se ve una vez).
export default function ConnectChatGPTModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  if (!isOpen) return null;
  return <ConnectBody onClose={onClose} />;
}

function ConnectBody({ onClose }: { onClose: () => void }) {
  const supabase = useMemo(() => createClient(), []);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [oauthMissing, setOauthMissing] = useState(false);
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [label, setLabel] = useState('Pruebas');
  const [newToken, setNewToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  // Solo se monta en el navegador (modal abierto), así que window existe.
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const mcpUrl = `${origin}/api/mcp`;

  const load = useCallback(async () => {
    const [conn, tok] = await Promise.all([
      supabase
        .from('fin_oauth_tokens')
        .select('id, client_name, client_id, created_at, last_used_at, revoked_at')
        .order('created_at', { ascending: false }),
      supabase
        .from('fin_api_tokens')
        .select('id, label, created_at, last_used_at, revoked_at')
        .order('created_at', { ascending: false }),
    ]);
    if (conn.error) {
      if (isMissingTableError(conn.error)) setOauthMissing(true);
      else setNotice({ type: 'error', text: finErrorMessage(conn.error) });
    } else setConnections((conn.data ?? []) as Connection[]);
    if (!tok.error) setTokens((tok.data ?? []) as TokenRow[]);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  const revoke = async (table: 'fin_oauth_tokens' | 'fin_api_tokens', id: string, name: string) => {
    if (!window.confirm(`¿Anular "${name}"? Deja de tener acceso a Finanzas al instante.`)) return;
    const { error } = await supabase.from(table).update({ revoked_at: new Date().toISOString() }).eq('id', id);
    if (error) setNotice({ type: 'error', text: finErrorMessage(error) });
    else load();
  };

  const create = async () => {
    setBusy(true);
    setNotice(null);
    const res = await createFinAgentToken(label);
    setBusy(false);
    if (res.error || !res.token) {
      setNotice({ type: 'error', text: res.error ?? 'No se pudo crear el token.' });
      return;
    }
    setNewToken(res.token);
    load();
  };

  const activeConnections = connections.filter((c) => !c.revoked_at);

  return (
    <Modal isOpen onClose={onClose} title="Conectar ChatGPT">
      <div className="space-y-6 text-sm text-slate-700">
        <FinNotice notice={notice} onClose={() => setNotice(null)} />

        {oauthMissing && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-amber-900">
            Falta correr <span className="font-mono">db/finanzas_08_oauth.sql</span> en Supabase para poder conectar
            el plugin.
          </div>
        )}

        <section className="space-y-2">
          <h3 className="font-bold text-slate-800">Conexiones</h3>
          {activeConnections.length === 0 ? (
            <p className="text-slate-500">Ninguna aplicación conectada todavía.</p>
          ) : (
            <ul className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
              {activeConnections.map((c) => (
                <li key={c.id} className="px-3 py-2 flex flex-wrap items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-slate-800">{c.client_name || 'Aplicación externa'}</p>
                    <p className="text-xs text-slate-400">
                      Conectada {formatDateTime(c.created_at)} ·{' '}
                      {c.last_used_at ? `último uso ${formatDateTime(c.last_used_at)}` : 'sin usar todavía'}
                    </p>
                  </div>
                  <button
                    className={btnDanger}
                    onClick={() => revoke('fin_oauth_tokens', c.id, c.client_name || 'la conexión')}
                  >
                    Anular
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-2">
          <h3 className="font-bold text-slate-800">Cómo conectar ChatGPT (una sola vez)</h3>
          <ol className="list-decimal list-inside space-y-1.5 text-slate-600">
            <li>
              En ChatGPT: <b>Configuración → Seguridad e inicio de sesión → Modo desarrollador</b> y actívalo. En un
              plan Business, si no aparece, lo habilita el administrador del espacio de trabajo.
            </li>
            <li>
              Entra a <b>chatgpt.com/plugins</b>, toca <b>+</b> y pega la dirección del servidor de abajo. Nombre:{' '}
              <b>Finanzas Ganesha</b>. Autenticación: <b>OAuth</b>.
            </li>
            <li>
              Toca <b>Conectar</b>: se abre esta página del POS. Entra con el usuario del dueño y toca{' '}
              <b>Permitir</b>.
            </li>
            <li>
              Listo. En un chat, llama a <b>@Finanzas Ganesha</b> y súbele el estado de cuenta.
            </li>
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs break-all bg-slate-50 border border-slate-200 rounded px-2 py-1.5 flex-1 min-w-0">
              {mcpUrl}
            </span>
            <CopyButton text={mcpUrl} label="Copiar dirección" />
          </div>
          <p className="text-xs text-slate-500">
            Las instrucciones las lee ChatGPT solo desde el servidor: no hay que pegar nada más. La misma dirección
            sirve para conectar Claude.
          </p>
        </section>

        <details className="border border-slate-200 rounded-lg p-3">
          <summary className="font-semibold text-slate-700 cursor-pointer">Avanzado: token manual para pruebas</summary>
          <div className="space-y-2 mt-3">
            <p className="text-slate-500">
              Para probar la API con <span className="font-mono">curl</span> (
              <span className="font-mono">Authorization: Bearer …</span>). Se muestra una sola vez.
            </p>
            {newToken ? (
              <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 space-y-2">
                <p className="font-semibold text-emerald-900">Cópialo ahora: no se vuelve a mostrar.</p>
                <p className="font-mono text-xs break-all bg-white border border-emerald-200 rounded px-2 py-1.5">
                  {newToken}
                </p>
                <CopyButton text={newToken} label="Copiar token" />
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <input
                  className={`${inputClass} flex-1 min-w-[180px]`}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="Nombre"
                />
                <button className={btnPrimary} onClick={create} disabled={busy}>
                  {busy ? 'Generando…' : 'Generar token'}
                </button>
              </div>
            )}
            {tokens.length > 0 && (
              <ul className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
                {tokens.map((t) => (
                  <li key={t.id} className="px-3 py-2 flex flex-wrap items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <p className={`font-medium ${t.revoked_at ? 'text-slate-400 line-through' : 'text-slate-800'}`}>
                        {t.label}
                      </p>
                      <p className="text-xs text-slate-400">
                        Creado {formatDateTime(t.created_at)} ·{' '}
                        {t.revoked_at
                          ? `anulado ${formatDateTime(t.revoked_at)}`
                          : t.last_used_at
                            ? `último uso ${formatDateTime(t.last_used_at)}`
                            : 'sin usar todavía'}
                      </p>
                    </div>
                    {!t.revoked_at && (
                      <button className={btnDanger} onClick={() => revoke('fin_api_tokens', t.id, t.label)}>
                        Anular
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </details>
      </div>
    </Modal>
  );
}
