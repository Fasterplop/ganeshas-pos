// Red de seguridad a nivel de proceso.
//
// El middleware de @supabase/ssr puede lanzar un AuthApiError ("Invalid Refresh
// Token: Refresh Token Not Found") cuando un navegador envía una cookie de
// refresh token vencida/inválida. Ese rechazo ocurre dentro de un lock async
// interno de Supabase, por lo que ESCAPA del try/catch que envuelve a
// getUser() y sube como "unhandled rejection" a nivel de proceso — lo que
// Node convierte en un crash del worker (pm2 lo reinicia → 502 intermitente).
//
// Este hook registra manejadores globales que LOGUEAN y mantienen el proceso
// vivo, en vez de dejar que una excepción async transitoria tumbe la caja.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    process.on('unhandledRejection', (reason) => {
      console.error('[unhandledRejection] Rechazo async no atrapado (el proceso sigue vivo):', reason);
    });

    process.on('uncaughtException', (error) => {
      console.error('[uncaughtException] Excepción no atrapada (el proceso sigue vivo):', error);
    });
  }
}
