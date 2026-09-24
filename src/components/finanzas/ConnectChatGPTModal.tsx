'use client';

// Conectar el GPT "Finanzas Ganesha": generar y anular tokens, y los datos que
// hay que pegar en ChatGPT (URL del esquema e instrucciones).
//
// El token se muestra UNA vez: en la base solo queda su hash
// (src/app/(dashboard)/finanzas/actions.ts).

import { useCallback, useEffect, useMemo, useState } from 'react';
import Modal from '@/components/Modal';
import { createClient } from '@/lib/supabase/client';
import { createFinAgentToken } from '@/app/(dashboard)/finanzas/actions';
import { FinNotice, Notice, btnPrimary, btnSecondary, btnDanger, inputClass } from '@/components/finanzas/ui';
import { formatDateTime } from '@/lib/finanzas/dates';
import { finErrorMessage } from '@/lib/finanzas/errors';
import { GPT_DESCRIPTION, GPT_INSTRUCTIONS, GPT_NAME } from '@/lib/finanzas/agent/gptInstructions';

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
// token recién generado, que es justo lo que se quiere (se ve una sola vez).
export default function ConnectChatGPTModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  if (!isOpen) return null;
  return <ConnectBody onClose={onClose} />;
}

function ConnectBody({ onClose }: { onClose: () => void }) {
  const supabase = useMemo(() => createClient(), []);
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [label, setLabel] = useState('ChatGPT de Gerardo');
  const [newToken, setNewToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  // Solo se monta en el navegador (modal abierto), así que window existe.
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('fin_api_tokens')
      .select('id, label, created_at, last_used_at, revoked_at')
      .order('created_at', { ascending: false });
    if (error) setNotice({ type: 'error', text: finErrorMessage(error) });
    else setTokens((data ?? []) as TokenRow[]);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

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

  const revoke = async (t: TokenRow) => {
    if (!window.confirm(`¿Anular "${t.label}"? ChatGPT dejará de poder entrar con ese token.`)) return;
    const { error } = await supabase
      .from('fin_api_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', t.id);
    if (error) setNotice({ type: 'error', text: finErrorMessage(error) });
    else load();
  };

  const schemaUrl = `${origin}/api/fin-agent/openapi.json`;
  const active = tokens.filter((t) => !t.revoked_at);

  return (
    <Modal isOpen onClose={onClose} title="Conectar ChatGPT">
      <div className="space-y-6 text-sm text-slate-700">
        <FinNotice notice={notice} onClose={() => setNotice(null)} />

        <section className="space-y-2">
          <h3 className="font-bold text-slate-800">1. Token de acceso</h3>
          <p className="text-slate-500">
            Es la llave con la que ChatGPT entra a Finanzas. Solo puede leer y dejar propuestas en la Bandeja. Si
            lo anulas, deja de funcionar al instante.
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
                placeholder="Nombre (ej. ChatGPT de Gerardo)"
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
                    <button className={btnDanger} onClick={() => revoke(t)}>
                      Anular
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {active.length > 1 && (
            <p className="text-xs text-amber-700">
              Hay {active.length} tokens activos. Si ya no usas alguno, anúlalo.
            </p>
          )}
        </section>

        <section className="space-y-2">
          <h3 className="font-bold text-slate-800">2. Crear el GPT en ChatGPT</h3>
          <ol className="list-decimal list-inside space-y-1.5 text-slate-600">
            <li>
              En ChatGPT (Plus o superior): <b>Explorar GPT → Crear → Configurar</b>.
            </li>
            <li>
              Nombre: <b>{GPT_NAME}</b>. Descripción: <span className="text-slate-500">{GPT_DESCRIPTION}</span>
            </li>
            <li>
              En <b>Instrucciones</b> pega el texto de abajo. En Funciones deja activado <b>Intérprete de código</b>{' '}
              (para leer PDF y Excel).
            </li>
            <li>
              <b>Crear nueva acción → Importar desde URL</b> y pega la URL del esquema.
            </li>
            <li>
              <b>Autenticación → Clave de API → Bearer</b> y pega el token del paso 1.
            </li>
            <li>
              Guardar como <b>Solo yo</b>. Listo: súbele un estado de cuenta.
            </li>
          </ol>

          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs break-all bg-slate-50 border border-slate-200 rounded px-2 py-1.5 flex-1 min-w-0">
              {schemaUrl}
            </span>
            <CopyButton text={schemaUrl} label="Copiar URL" />
          </div>

          <div className="space-y-2">
            <textarea
              readOnly
              value={GPT_INSTRUCTIONS}
              className={`${inputClass} font-mono text-xs h-40`}
              onFocus={(e) => e.currentTarget.select()}
            />
            <CopyButton text={GPT_INSTRUCTIONS} label="Copiar instrucciones" />
          </div>
        </section>
      </div>
    </Modal>
  );
}
