// GET /api/fin-agent/payments — ver src/lib/finanzas/agent/tools/reads.ts
import { restGet } from '@/lib/finanzas/agent/rest';
import { paymentsTool } from '@/lib/finanzas/agent/tools';

export const GET = restGet(paymentsTool);
