'use client';

import { useEffect, useRef, useState } from 'react';
import type { Html5Qrcode } from 'html5-qrcode';

// Escáner de códigos de barras con la cámara del teléfono. Los botones que lo
// abren van con `lg:hidden` (solo móvil/tablet); la cámara requiere HTTPS.
//
// NOTA: actualmente NO está conectado en ninguna página — los puntos de
// integración quedaron comentados en /pos, /inventory y /labels (buscar
// "BarcodeScannerModal" en esas páginas para reactivarlos).
interface BarcodeScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  // Recibe el código leído. Si devuelve un string se muestra como feedback
  // dentro del visor (útil en modo continuo: "✓ añadido" / "✗ no encontrado").
  onScan: (code: string) => void | string | null | Promise<void | string | null>;
  // true = sigue escaneando tras cada lectura (POS/etiquetas);
  // false = cierra el visor con la primera lectura (formulario de inventario).
  continuous?: boolean;
  title?: string;
}

const READER_ID = 'barcode-scanner-viewfinder';
// Ignorar relecturas del MISMO código dentro de esta ventana (la cámara decodifica
// varias veces por segundo mientras la etiqueta siga frente al lente).
const DUP_COOLDOWN_MS = 2500;

export default function BarcodeScannerModal({ isOpen, ...rest }: BarcodeScannerModalProps) {
  // Montar/desmontar el visor con cada apertura deja el estado interno
  // (cámara, feedback, errores) siempre limpio.
  if (!isOpen) return null;
  return <ScannerDialog {...rest} />;
}

function ScannerDialog({
  onClose,
  onScan,
  continuous = false,
  title = 'Escanear código',
}: Omit<BarcodeScannerModalProps, 'isOpen'>) {
  const [starting, setStarting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  // La cámara registra su callback UNA sola vez (al iniciar): leemos los props
  // vía refs para que cada lectura use siempre la versión más reciente y no un
  // closure viejo (crítico en modo continuo, donde el padre re-renderiza).
  const onScanRef = useRef(onScan);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onScanRef.current = onScan;
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    let cancelled = false;
    let scanner: Html5Qrcode | null = null;
    let doneReading = false; // en modo single: ya se leyó uno, ignorar el resto
    let lastRead: { code: string; at: number } | null = null;
    let feedbackTimer: ReturnType<typeof setTimeout> | null = null;

    const handleDecoded = async (raw: string) => {
      const code = raw.trim();
      if (!code || doneReading) return;

      const now = Date.now();
      if (lastRead && lastRead.code === code && now - lastRead.at < DUP_COOLDOWN_MS) return;
      lastRead = { code, at: now };

      if (!continuous) doneReading = true;

      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        navigator.vibrate?.(80);
      }

      const result = await onScanRef.current(code);

      if (!continuous) {
        onCloseRef.current();
        return;
      }

      if (typeof result === 'string' && !cancelled) {
        setFeedback(result);
        if (feedbackTimer) clearTimeout(feedbackTimer);
        feedbackTimer = setTimeout(() => setFeedback(null), 2500);
      }
    };

    const stopScanner = async () => {
      const s = scanner;
      scanner = null;
      if (!s) return;
      try {
        if (s.isScanning) await s.stop();
        s.clear();
      } catch {
        // Ya estaba detenido o el visor fue desmontado: nada que limpiar.
      }
    };

    (async () => {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        setStarting(false);
        setError('Este navegador no permite usar la cámara. Recuerda que la cámara solo funciona con conexión segura (HTTPS).');
        return;
      }

      try {
        // Import dinámico: html5-qrcode toca APIs del navegador y no debe
        // cargarse durante el render en servidor.
        const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import('html5-qrcode');
        if (cancelled) return;

        scanner = new Html5Qrcode(READER_ID, {
          formatsToSupport: [
            Html5QrcodeSupportedFormats.CODE_128, // formato de las etiquetas propias (react-barcode)
            Html5QrcodeSupportedFormats.EAN_13,
            Html5QrcodeSupportedFormats.EAN_8,
            Html5QrcodeSupportedFormats.UPC_A,
            Html5QrcodeSupportedFormats.UPC_E,
            Html5QrcodeSupportedFormats.CODE_39,
            Html5QrcodeSupportedFormats.QR_CODE,
          ],
          // En Android/Chrome usa el detector nativo del navegador: mucho
          // mejor decodificando CODE128 que la implementación en JS.
          experimentalFeatures: { useBarCodeDetectorIfSupported: true },
          verbose: false,
        });

        await scanner.start(
          { facingMode: 'environment' }, // cámara trasera
          {
            fps: 10,
            // Franja ancha y baja: guía natural para códigos 1D.
            qrbox: (vw, vh) => ({
              width: Math.max(50, Math.floor(Math.min(vw * 0.85, 340))),
              height: Math.max(50, Math.floor(Math.min(vh * 0.4, 150))),
            }),
          },
          (decodedText) => void handleDecoded(decodedText),
          () => {
            // Errores por frame sin código a la vista: ruido normal, se ignoran.
          }
        );

        if (cancelled) {
          await stopScanner();
          return;
        }
        setStarting(false);
      } catch (err) {
        if (cancelled) return;
        setStarting(false);
        const msg = err instanceof Error ? err.message : String(err);
        if (/permission|denied|notallowed/i.test(msg)) {
          setError('Permiso de cámara denegado. Habilítalo para este sitio en los ajustes del navegador y vuelve a intentar.');
        } else {
          setError('No se pudo iniciar la cámara. Verifica que otra app no la esté usando y que la página cargue por HTTPS.');
        }
      }
    })();

    return () => {
      cancelled = true;
      if (feedbackTimer) clearTimeout(feedbackTimer);
      void stopScanner();
    };
  }, [continuous]);

  return (
    <div className="fixed inset-0 z-[110] flex flex-col items-center justify-center bg-black/85 p-4">
      <div className="w-full max-w-md bg-slate-900 rounded-2xl overflow-hidden shadow-2xl border border-slate-700">
        {/* Cabecera */}
        <div className="px-4 py-3 flex items-center justify-between bg-slate-800">
          <h2 className="text-white font-bold text-base">📷 {title}</h2>
          <button
            onClick={onClose}
            className="text-slate-300 hover:text-white transition text-lg font-bold px-2 py-0.5 rounded-full hover:bg-slate-700"
            aria-label="Cerrar escáner"
          >
            ✕
          </button>
        </div>

        {/* Visor de cámara (html5-qrcode inyecta el <video> aquí) */}
        <div className="relative bg-black min-h-[260px] flex items-center justify-center">
          <div id={READER_ID} className="w-full [&_video]:w-full [&_video]:h-auto" />
          {starting && !error && (
            <p className="absolute inset-0 flex items-center justify-center text-slate-300 text-sm">
              Iniciando cámara...
            </p>
          )}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center p-6">
              <p className="text-red-300 text-sm text-center leading-relaxed">⚠️ {error}</p>
            </div>
          )}
          {/* Feedback de la última lectura (modo continuo) */}
          {feedback && (
            <div className="absolute bottom-3 left-3 right-3 pointer-events-none">
              <p
                className={`text-center text-sm font-bold px-3 py-2 rounded-lg shadow-lg ${
                  feedback.startsWith('✗')
                    ? 'bg-red-500/90 text-white'
                    : 'bg-emerald-500/90 text-white'
                }`}
              >
                {feedback}
              </p>
            </div>
          )}
        </div>

        {/* Pie: instrucción + cerrar */}
        <div className="px-4 py-3 bg-slate-800 flex items-center justify-between gap-3">
          <p className="text-slate-400 text-xs leading-snug">
            Apunta la cámara al código de barras.
            {continuous && ' Puedes escanear varios seguidos.'}
          </p>
          <button
            onClick={onClose}
            className="shrink-0 px-4 py-2 bg-slate-700 text-white text-sm font-bold rounded-lg hover:bg-slate-600 transition"
          >
            Listo
          </button>
        </div>
      </div>
    </div>
  );
}
