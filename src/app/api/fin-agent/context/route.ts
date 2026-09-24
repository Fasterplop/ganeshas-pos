// GET /api/fin-agent/context — ver src/lib/finanzas/agent/tools/context.ts
import { restGet } from '@/lib/finanzas/agent/rest';
import { contextTool } from '@/lib/finanzas/agent/tools';

export const GET = restGet(contextTool);
