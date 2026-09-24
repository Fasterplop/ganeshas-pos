// Pantalla de "Permitir acceso" del plugin de ChatGPT (OAuth /authorize).
//
// ChatGPT abre esta página cuando el dueño toca "Conectar". Si no hay sesión
// del POS, se pasa por /login y se vuelve aquí. Solo el dueño puede aprobar.
// La decisión se envía por POST a /api/oauth/authorize, que es quien emite el
// código y redirige de vuelta a ChatGPT.
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { issuerFrom, resourceFrom } from '@/lib/finanzas/oauth/config';
import { AUTHORIZE_FIELDS, checkAuthorize, type AuthorizeParams } from '@/lib/finanzas/oauth/authorize';
import { clientLabel } from '@/lib/finanzas/oauth/clients';

export const dynamic = 'force-dynamic';

function Card({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-slate-100 flex items-center justify-center p-4 font-sans">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-lg border border-slate-200 p-6 sm:p-8">{children}</div>
    </main>
  );
}

export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const params: AuthorizeParams = {};
  for (const f of AUTHORIZE_FIELDS) {
    const v = sp[f];
    if (typeof v === 'string' && v) params[f] = v;
  }

  const h = await headers();
  const req = { headers: h };
  const check = await checkAuthorize(params, issuerFrom(req), resourceFrom(req));

  if (check.kind === 'fatal') {
    return (
      <Card>
        <h1 className="text-xl font-bold text-slate-800 mb-2">No se puede conectar</h1>
        <p className="text-sm text-slate-600">{check.message}</p>
      </Card>
    );
  }
  if (check.kind === 'error_redirect') redirect(check.url);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const qs = new URLSearchParams(params as Record<string, string>).toString();
    redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${qs}`)}`);
  }

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).maybeSingle();
  if (profile?.role !== 'owner') {
    return (
      <Card>
        <h1 className="text-xl font-bold text-slate-800 mb-2">Solo el dueño</h1>
        <p className="text-sm text-slate-600">
          Finanzas es exclusivo del dueño. Entraste como <b>{user.email}</b>: cierra sesión en el POS y vuelve a
          conectar con la cuenta del dueño.
        </p>
      </Card>
    );
  }

  const name = clientLabel(check.client);
  const returnHost = new URL(check.params.redirect_uri).hostname;

  return (
    <Card>
      <p className="text-[11px] uppercase tracking-widest text-teal-700 font-bold">GaneshaStores POS</p>
      <h1 className="text-xl sm:text-2xl font-bold text-slate-800 mt-1">
        ¿Conectar {name} a Finanzas?
      </h1>
      <p className="text-sm text-slate-500 mt-1">
        Como <b className="text-slate-700">{user.email}</b>. Vuelve a <span className="font-mono">{returnHost}</span>.
      </p>

      <div className="mt-5 space-y-3 text-sm">
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3">
          <p className="font-semibold text-emerald-900 mb-1">Podrá</p>
          <ul className="list-disc list-inside text-emerald-900 space-y-0.5">
            <li>Leer compras, gastos, deudas, vencimientos y saldos de Finanzas.</li>
            <li>Dejar propuestas en la Bandeja, que solo tú apruebas.</li>
          </ul>
        </div>
        <div className="bg-red-50 border border-red-200 rounded-lg p-3">
          <p className="font-semibold text-red-900 mb-1">No podrá</p>
          <ul className="list-disc list-inside text-red-900 space-y-0.5">
            <li>Registrar nada sin tu aprobación, ni borrar o cambiar lo registrado.</li>
            <li>Tocar los saldos de cuentas y tarjetas.</li>
            <li>Ver ventas, clientes, productos ni stock.</li>
          </ul>
        </div>
        <p className="text-xs text-slate-500">
          Puedes anular este acceso cuando quieras en Finanzas → Bandeja → Conectar ChatGPT.
        </p>
      </div>

      <form method="POST" action="/api/oauth/authorize" className="mt-6 flex flex-col-reverse sm:flex-row gap-2">
        {AUTHORIZE_FIELDS.map((f) =>
          check.params[f] ? <input key={f} type="hidden" name={f} value={check.params[f]} /> : null,
        )}
        <button
          type="submit"
          name="decision"
          value="deny"
          className="flex-1 bg-white hover:bg-slate-50 text-slate-700 font-semibold px-4 py-3 rounded-lg border border-slate-300 cursor-pointer"
        >
          Cancelar
        </button>
        <button
          type="submit"
          name="decision"
          value="allow"
          className="flex-1 bg-teal-700 hover:bg-teal-800 text-white font-semibold px-4 py-3 rounded-lg cursor-pointer"
        >
          Permitir
        </button>
      </form>
    </Card>
  );
}
