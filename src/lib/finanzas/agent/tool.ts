// Definición común de las herramientas del conector de Finanzas.
//
// Cada herramienta (contexto, compras, deuda por proveedor, enviar a la
// bandeja...) se escribe UNA vez aquí en src/lib/finanzas/agent/tools/ y la
// exponen dos puertas:
//   - /api/mcp           : el plugin de ChatGPT (MCP + OAuth). Es la principal.
//   - /api/fin-agent/*   : REST con token manual, para probar con curl.
// Así lo que ve ChatGPT y lo que se prueba a mano es exactamente lo mismo.
import type { z } from 'zod';
import type { createAdminClient } from '@/lib/supabase/admin';

export interface AgentContext {
  admin: ReturnType<typeof createAdminClient>;
  /** Dueño que autorizó el acceso: queda como created_by de lo que entra. */
  profileId: string;
}

export interface FinTool<S extends z.ZodType = z.ZodType> {
  /** Nombre de la herramienta MCP (snake_case). */
  name: string;
  /** Título corto para la interfaz de ChatGPT. */
  title: string;
  /** Cuándo usarla. La lee el modelo: clara y corta. */
  description: string;
  input: S;
  /** true = solo lee. false = escribe (solo en la Bandeja, nunca más allá). */
  readOnly: boolean;
  run(ctx: AgentContext, input: z.infer<S>): Promise<Record<string, unknown>>;
}

export function defineTool<S extends z.ZodType>(tool: FinTool<S>): FinTool<S> {
  return tool;
}

/** Lanza si la consulta de Supabase falló; así cada herramienta queda lineal. */
export function must<T>(res: { data: T | null; error: { message?: string } | null }, what: string): T | null {
  if (res.error) throw new Error(`${what}: ${res.error.message ?? 'error de base de datos'}`);
  return res.data;
}

/** Igual que `must`, para listas: nunca devuelve null. */
export function mustList<T>(res: { data: T[] | null; error: { message?: string } | null }, what: string): T[] {
  return must(res, what) ?? [];
}
