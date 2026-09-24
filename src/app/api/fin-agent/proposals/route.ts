// /api/fin-agent/proposals — POST envía líneas a la Bandeja, GET lista lo
// pendiente. Ver src/lib/finanzas/agent/tools/submit.ts y reads.ts.
import { restGet, restPost } from '@/lib/finanzas/agent/rest';
import { listProposalsTool, submitTool } from '@/lib/finanzas/agent/tools';

export const GET = restGet(listProposalsTool);
export const POST = restPost(submitTool);
