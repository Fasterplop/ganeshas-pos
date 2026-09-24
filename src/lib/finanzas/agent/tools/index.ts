// Todas las herramientas del conector de Finanzas, en el orden en que las ve
// el asistente. Solo `enviar_a_bandeja` escribe, y solo en la Bandeja.
import { contextTool } from './context';
import { accountsTool, bcvTool, expensesTool, listProposalsTool, paymentsTool } from './reads';
import { dueTool, monthTool, supplierSummaryTool } from './summaries';
import { submitTool } from './submit';
import type { FinTool } from '../tool';

export const FIN_TOOLS: FinTool[] = [
  contextTool,
  bcvTool,
  expensesTool,
  paymentsTool,
  supplierSummaryTool,
  dueTool,
  monthTool,
  accountsTool,
  listProposalsTool,
  submitTool,
] as unknown as FinTool[];

export {
  contextTool,
  accountsTool,
  bcvTool,
  expensesTool,
  listProposalsTool,
  paymentsTool,
  dueTool,
  monthTool,
  supplierSummaryTool,
  submitTool,
};
