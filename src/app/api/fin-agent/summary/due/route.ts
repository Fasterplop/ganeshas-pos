// GET /api/fin-agent/summary/due — ver src/lib/finanzas/agent/tools/summaries.ts
import { restGet } from '@/lib/finanzas/agent/rest';
import { dueTool } from '@/lib/finanzas/agent/tools';

export const GET = restGet(dueTool);
