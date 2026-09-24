// GET /api/fin-agent/bcv?date= — ver src/lib/finanzas/agent/tools/reads.ts
import { restGet } from '@/lib/finanzas/agent/rest';
import { bcvTool } from '@/lib/finanzas/agent/tools';

export const GET = restGet(bcvTool);
