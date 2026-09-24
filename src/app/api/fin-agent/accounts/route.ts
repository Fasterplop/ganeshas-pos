// GET /api/fin-agent/accounts — ver src/lib/finanzas/agent/tools/reads.ts
import { restGet } from '@/lib/finanzas/agent/rest';
import { accountsTool } from '@/lib/finanzas/agent/tools';

export const GET = restGet(accountsTool);
