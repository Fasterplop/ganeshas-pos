// POST /api/oauth/authorize — la decisión del dueño en la pantalla "Permitir".
//
// Vuelve a validar TODO (no se confía en los campos ocultos del formulario),
// exige sesión de dueño y responde con una redirección (303) a la URL de
// retorno del cliente: con `code` si aprobó, con `error=access_denied` si no.
//
// Contra CSRF: la cookie de sesión de Supabase es SameSite=Lax, así que un
// POST desde otro sitio llega sin sesión; además se exige que el Origin sea el
// propio POS.
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { issuerFrom, resourceFrom } from '@/lib/finanzas/oauth/config';
import { AUTHORIZE_FIELDS, checkAuthorize, issueCode, redirectWith, type AuthorizeParams } from '@/lib/finanzas/oauth/authorize';

const page = (status: number, message: string) =>
  new NextResponse(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

export async function POST(req: Request) {
  const issuer = issuerFrom(req);
  const origin = req.headers.get('origin');
  if (origin && origin !== issuer) return page(403, 'Origen no permitido.');

  const form = await req.formData();
  const params: AuthorizeParams = {};
  for (const f of AUTHORIZE_FIELDS) {
    const v = form.get(f);
    if (typeof v === 'string' && v) params[f] = v;
  }

  const resource = resourceFrom(req);
  const check = await checkAuthorize(params, issuer, resource);
  if (check.kind === 'fatal') return page(400, check.message);
  if (check.kind === 'error_redirect') return NextResponse.redirect(check.url, 303);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return page(401, 'La sesión del POS venció. Vuelve a conectar desde ChatGPT.');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).maybeSingle();
  if (profile?.role !== 'owner') return page(403, 'Solo el dueño puede conectar Finanzas.');

  const { redirect_uri, state } = check.params;

  if (form.get('decision') !== 'allow') {
    return NextResponse.redirect(
      redirectWith(redirect_uri, issuer, state, { error: 'access_denied', error_description: 'El dueño canceló.' }),
      303,
    );
  }

  const code = await issueCode({
    clientId: check.client.client_id,
    profileId: user.id,
    redirectUri: redirect_uri,
    codeChallenge: check.params.code_challenge,
    resource,
  });
  return NextResponse.redirect(redirectWith(redirect_uri, issuer, state, { code }), 303);
}
