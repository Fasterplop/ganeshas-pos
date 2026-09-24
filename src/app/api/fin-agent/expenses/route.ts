// GET /api/fin-agent/expenses — ver src/lib/finanzas/agent/tools/reads.ts
import { restGet } from '@/lib/finanzas/agent/rest';
import { expensesTool } from '@/lib/finanzas/agent/tools';

export const GET = restGet(expensesTool);
