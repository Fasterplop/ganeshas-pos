-- ============================================================================
-- FINANZAS 08 - Login OAuth 2.1 para el plugin de ChatGPT (servidor MCP).
--
-- POR QUE: OpenAI retira los GPT personalizados el 11-dic-2026. Su reemplazo,
-- los plugins, se conectan a un servidor MCP (/api/mcp) y NO aceptan un token
-- pegado a mano: exigen OAuth 2.1 con PKCE. El POS hace de servidor de
-- autorizacion: el dueno toca "Conectar" en ChatGPT, entra con su usuario del
-- POS, aprueba, y ChatGPT recibe un token que el dueno puede anular.
--
-- Tres tablas:
--   fin_oauth_clients : quien se conecto (ChatGPT, Claude...). Por registro
--                       dinamico (DCR) o por documento de metadatos (CIMD).
--   fin_oauth_codes   : codigos de autorizacion de un solo uso (10 min).
--   fin_oauth_tokens  : tokens de acceso (1 h) y de refresco (90 dias, rotan).
-- De todos los secretos se guarda SOLO el sha256.
--
-- Quien escribe: solo el servidor con la service_role (src/lib/finanzas/oauth).
-- El dueno, desde Finanzas > Bandeja, puede VER sus conexiones y ANULARLAS.
--
-- !! Politicas ANTES del ENABLE (event trigger ensure_rls, ver finanzas_01).
-- fin_oauth_codes queda sin politicas A PROPOSITO: RLS activa + cero politicas
-- = nadie la lee con la clave anonima ni con sesion; solo la service_role.
--
-- TODO ADITIVO. Idempotente. Aplicar en el SQL Editor de Supabase DESPUES de
-- finanzas_07.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.fin_oauth_clients (
  client_id     text NOT NULL,
  client_name   text,
  redirect_uris text[] NOT NULL,
  -- 'dcr' = se registro en /api/oauth/register; 'cimd' = client_id es una URL
  -- con sus metadatos (asi se presenta ChatGPT).
  kind          text NOT NULL CHECK (kind IN ('dcr','cimd')),
  metadata      jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  refreshed_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fin_oauth_clients_pkey PRIMARY KEY (client_id)
);

CREATE TABLE IF NOT EXISTS public.fin_oauth_codes (
  code_hash      text NOT NULL,
  client_id      text NOT NULL,
  profile_id     uuid NOT NULL,
  redirect_uri   text NOT NULL,
  code_challenge text NOT NULL,
  scope          text,
  resource       text,
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fin_oauth_codes_pkey PRIMARY KEY (code_hash),
  CONSTRAINT fin_oauth_codes_client_fkey  FOREIGN KEY (client_id)  REFERENCES public.fin_oauth_clients(client_id) ON DELETE CASCADE,
  CONSTRAINT fin_oauth_codes_profile_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id)
);

CREATE TABLE IF NOT EXISTS public.fin_oauth_tokens (
  id                 uuid NOT NULL DEFAULT uuid_generate_v4(),
  client_id          text NOT NULL,
  client_name        text,
  profile_id         uuid NOT NULL,
  access_hash        text NOT NULL,
  access_expires_at  timestamptz NOT NULL,
  refresh_hash       text,
  refresh_expires_at timestamptz,
  scope              text,
  resource           text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz,
  revoked_at         timestamptz,
  CONSTRAINT fin_oauth_tokens_pkey PRIMARY KEY (id),
  CONSTRAINT fin_oauth_tokens_client_fkey  FOREIGN KEY (client_id)  REFERENCES public.fin_oauth_clients(client_id) ON DELETE CASCADE,
  CONSTRAINT fin_oauth_tokens_profile_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fin_oauth_tokens_access  ON public.fin_oauth_tokens (access_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fin_oauth_tokens_refresh ON public.fin_oauth_tokens (refresh_hash) WHERE refresh_hash IS NOT NULL;


-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS fin_oauth_clients_select_owner ON public.fin_oauth_clients;
CREATE POLICY fin_oauth_clients_select_owner ON public.fin_oauth_clients
  FOR SELECT TO authenticated USING (public.fin_is_owner());
ALTER TABLE public.fin_oauth_clients ENABLE ROW LEVEL SECURITY;

-- Sin politicas: solo la service_role.
ALTER TABLE public.fin_oauth_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fin_oauth_tokens_select_owner ON public.fin_oauth_tokens;
CREATE POLICY fin_oauth_tokens_select_owner ON public.fin_oauth_tokens
  FOR SELECT TO authenticated USING (public.fin_is_owner());

-- Anular una conexion = poner revoked_at. Nada mas se edita desde el navegador.
DROP POLICY IF EXISTS fin_oauth_tokens_update_owner ON public.fin_oauth_tokens;
CREATE POLICY fin_oauth_tokens_update_owner ON public.fin_oauth_tokens
  FOR UPDATE TO authenticated USING (public.fin_is_owner()) WITH CHECK (public.fin_is_owner());
ALTER TABLE public.fin_oauth_tokens ENABLE ROW LEVEL SECURITY;


-- ============================================================================
-- VERIFICACION. Debe decir rls_activa = true en las tres; politicas 1, 0 y 2.
-- ============================================================================
SELECT jsonb_pretty(jsonb_agg(jsonb_build_object(
         'tabla', c.relname,
         'rls_activa', c.relrowsecurity,
         'politicas', (SELECT COUNT(*) FROM pg_policies p
                        WHERE p.schemaname = 'public' AND p.tablename = c.relname)
       ) ORDER BY c.relname))
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname IN ('fin_oauth_clients', 'fin_oauth_codes', 'fin_oauth_tokens');
