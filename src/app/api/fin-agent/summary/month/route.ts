// GET /api/fin-agent/summary/month — ver src/lib/finanzas/agent/tools/summaries.ts
import { restGet } from '@/lib/finanzas/agent/rest';
import { monthTool } from '@/lib/finanzas/agent/tools';

export const GET = restGet(monthTool);
