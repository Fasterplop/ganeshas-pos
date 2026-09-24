// GET /api/fin-agent/summary/suppliers — ver src/lib/finanzas/agent/tools/summaries.ts
import { restGet } from '@/lib/finanzas/agent/rest';
import { supplierSummaryTool } from '@/lib/finanzas/agent/tools';

export const GET = restGet(supplierSummaryTool);
