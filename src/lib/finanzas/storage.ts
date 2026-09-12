'use client';

// Adjuntos del módulo de Finanzas (fotos de recibos y de guías de envío).
//
// El bucket `finanzas` es PRIVADO: un recibo lleva montos, proveedores y a
// veces datos bancarios, así que no puede quedar en una URL pública
// adivinable. Se lee con URL firmada y de corta vida.
//
// La BD guarda la RUTA, nunca la URL firmada: las URLs caducan, y guardarlas
// sería guardar basura con fecha de vencimiento.

import { createClient } from '@/lib/supabase/client';

export const FIN_BUCKET = 'finanzas';
export type FinFolder = 'receipts' | 'shipments';

const MAX_BYTES = 5 * 1024 * 1024; // igual al file_size_limit del bucket
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'];

/**
 * Comprime una foto antes de subirla: WebP, lado mayor 1600 px.
 *
 * Sin esto, una foto del celular pesa 4-5 MB, el bucket se llena y el cliente
 * deja de adjuntar recibos — que es la forma real en que esta función se paga
 * sola. 1600 px basta de sobra para leer un recibo en pantalla.
 *
 * Los PDF pasan intactos, y si el navegador no sabe decodificar el formato
 * (HEIC de iPhone en algunos navegadores) se devuelve el original en vez de
 * fallar: mejor subir 4 MB que perder el respaldo.
 */
export async function compressImage(file: File, maxSide = 1600, quality = 0.82): Promise<File> {
  if (!file.type.startsWith('image/')) return file;

  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/webp', quality),
    );
    if (!blob || blob.size >= file.size) return file; // no empeorar el original

    const name = file.name.replace(/\.[^.]+$/, '') + '.webp';
    return new File([blob], name, { type: 'image/webp', lastModified: Date.now() });
  } catch {
    return file;
  }
}

/** Valida el archivo antes de tocar la red. Devuelve el motivo, o null si va bien. */
export function validateFinFile(file: File): string | null {
  if (!ALLOWED.includes(file.type)) {
    return 'Solo se pueden adjuntar imágenes (JPG, PNG, WebP, HEIC) o PDF.';
  }
  if (file.size > MAX_BYTES) {
    return 'El archivo pesa más de 5 MB. Toma la foto de nuevo o reduce su tamaño.';
  }
  return null;
}

/**
 * Sube un adjunto y devuelve la ruta a guardar en la BD.
 * `ownerRecordId` es el id de la compra o de la caja: agrupa los archivos.
 */
export async function uploadFinanzasFile(
  file: File,
  folder: FinFolder,
  ownerRecordId: string,
): Promise<{ path: string | null; error: string | null }> {
  const prepared = await compressImage(file);

  const invalid = validateFinFile(prepared);
  if (invalid) return { path: null, error: invalid };

  const ext = (prepared.name.split('.').pop() || 'bin').toLowerCase();
  const path = `${folder}/${ownerRecordId}/${crypto.randomUUID()}.${ext}`;

  const supabase = createClient();
  const { error } = await supabase.storage.from(FIN_BUCKET).upload(path, prepared, {
    contentType: prepared.type,
    upsert: false,
  });

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes('bucket') && msg.includes('not found')) {
      return {
        path: null,
        error: 'Falta crear el bucket de Finanzas. Corre db/finanzas_02_storage.sql en Supabase.',
      };
    }
    return { path: null, error: error.message };
  }

  return { path, error: null };
}

/** URL temporal para mostrar un adjunto. Se pide en el momento de abrirlo. */
export async function signedUrl(path: string, seconds = 120): Promise<string | null> {
  if (!path) return null;
  const supabase = createClient();
  const { data, error } = await supabase.storage.from(FIN_BUCKET).createSignedUrl(path, seconds);
  if (error) return null;
  return data?.signedUrl ?? null;
}

export async function removeFinanzasFile(path: string): Promise<string | null> {
  if (!path) return null;
  const supabase = createClient();
  const { error } = await supabase.storage.from(FIN_BUCKET).remove([path]);
  return error ? error.message : null;
}
