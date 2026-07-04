// src/middleware.ts
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({
    request: { headers: request.headers },
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return request.cookies.get(name)?.value;
        },
        set(name: string, value: string, options: CookieOptions) {
          request.cookies.set({ name, value, ...options });
          response = NextResponse.next({
            request: { headers: request.headers },
          });
          response.cookies.set({ name, value, ...options });
        },
        remove(name: string, options: CookieOptions) {
          request.cookies.set({ name, value: '', ...options });
          response = NextResponse.next({
            request: { headers: request.headers },
          });
          response.cookies.set({ name, value: '', ...options });
        },
      },
    }
  );

  // Refrescamos la sesión. Si Supabase no resuelve (DNS/ENOTFOUND) o el refresh
  // falla de forma transitoria (AuthRetryableFetchError / Invalid Refresh Token),
  // NO dejamos que la excepción tumbe el proceso: logueamos, tratamos la sesión
  // como no autenticada y dejamos pasar el request.
  try {
    await supabase.auth.getUser();
  } catch (error) {
    console.error('[middleware] Fallo al refrescar la sesión de Supabase (se continúa sin sesión):', error);
  }

  return response;
}

// Evitamos que el middleware se ejecute en archivos estáticos o imágenes
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};