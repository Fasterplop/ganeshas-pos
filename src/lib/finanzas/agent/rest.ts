// Puerta REST de las herramientas (/api/fin-agent/*): GET lee los parámetros
// del query string y POST del cuerpo JSON. La lógica vive en ./tools.
import { NextResponse } from 'next/server';
import { withAgent, jsonError } from './auth';
import { parseQuery, zodMessage } from './params';
import type { FinTool } from './tool';

export function restGet(tool: FinTool) {
  return withAgent(async (req, ctx) => {
    const q = parseQuery(req, tool.input);
    if (!q.ok) return q.res;
    return NextResponse.json(await tool.run(ctx, q.data));
  });
}

export function restPost(tool: FinTool) {
  return withAgent(async (req, ctx) => {
    let json: unknown;
    try {
      json = await req.json();
    } catch {
      return jsonError(400, 'El cuerpo debe ser JSON.');
    }
    const parsed = tool.input.safeParse(json);
    if (!parsed.success) return jsonError(400, zodMessage(parsed.error));
    return NextResponse.json(await tool.run(ctx, parsed.data));
  });
}
