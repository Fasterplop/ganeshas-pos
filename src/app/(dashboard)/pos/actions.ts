// src/app/(dashboard)/pos/actions.ts
'use server';

import { createClient as createServerClient } from '@/lib/supabase/server';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * Dispara el webhook de n8n que envía el WhatsApp de agradecimiento post-venta.
 *
 * n8n es el ÚNICO componente que habla con la API de Meta: aquí no existe el
 * token de WhatsApp ni se llama a graph.facebook.com. Este action solo arma el
 * payload (teléfono + puntos) y hace un POST al webhook local de n8n.
 *
 * La plantilla está categorizada como MARKETING en Meta, por lo que solo se
 * envía a clientes con consentimiento explícito (wa_marketing_opt_in) y sin
 * baja registrada (wa_opt_out_at). Enviar marketing sin opt-in degrada el
 * quality rating del número y Meta termina pausando la plantilla.
 *
 * Fire-and-forget: cualquier fallo se loguea y se ignora — la venta ya quedó
 * registrada y jamás debe verse afectada por la mensajería.
 */
export async function notifySaleWhatsApp(payload: {
  saleId: string | number;
  documentId: string;
  pointsEarned: number;
}) {
  const webhookUrl = process.env.N8N_SALE_WEBHOOK_URL;
  const webhookSecret = process.env.N8N_WEBHOOK_SECRET;
  if (!webhookUrl || !webhookSecret) return; // integración no configurada (dev sin n8n)

  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  // Service role: el teléfono puede vivir en la fila de OTRA sucursal y la RLS
  // por tienda del cajero no permite leerla. El acumulado es el pool global
  // (suma de reward_points de todas las sucursales, ya actualizado por el POS).
  const { data: rows, error } = await supabaseAdmin
    .from('customers')
    .select('phone, reward_points, wa_marketing_opt_in, wa_opt_out_at')
    .eq('document_id', payload.documentId);

  if (error || !rows || rows.length === 0) return;

  // Compuerta de consentimiento (plantilla MARKETING). El opt-in/opt-out es de
  // la persona, no de la sucursal: basta una baja en cualquier fila para callar.
  const optedOut = rows.some((r) => r.wa_opt_out_at !== null);
  const optedIn = rows.some((r) => r.wa_marketing_opt_in === true);
  if (optedOut || !optedIn) return;

  const phone = rows
    .map((r) => (typeof r.phone === 'string' ? r.phone.trim() : ''))
    .find((p) => p !== '');
  if (!phone) return; // cliente sin teléfono: no hay a quién escribirle

  const pointsTotal = rows.reduce((acc, r) => acc + (r.reward_points || 0), 0);

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-pos-secret': webhookSecret,
      },
      body: JSON.stringify({
        saleId: payload.saleId,
        documentId: payload.documentId,
        phone,
        pointsEarned: payload.pointsEarned,
        pointsTotal,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.error('[whatsapp] No se pudo notificar a n8n (la venta no se afecta):', err);
  }
}
