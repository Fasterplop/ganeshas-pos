'use client';

// Escáner de códigos de barras con la cámara de cualquier teléfono.
//
// Complementa al teléfono con lector láser (que teclea el código y Enter): este
// sirve con la cámara trasera de un teléfono normal. La cámara solo funciona
// con HTTPS (pos.ganeshastores.com ya lo tiene).
//
// POR QUÉ ES RÁPIDO:
//   - Chrome en Android trae `BarcodeDetector` nativo (ML Kit de Google): se
//     usa ese, directo sobre el video, sin copiar cuadros.
//   - Donde no existe (iPhone/Safari, Chrome de escritorio en Windows) se usa
//     el mismo API con zxing-cpp compilado a WebAssembly (paquete
//     barcode-detector). El .wasm se sirve desde /zxing/ (scripts/
//     copy-zxing-wasm.mjs) y empieza a descargarse al tocar el botón, en
//     paralelo con el permiso de cámara. Ahí se recorta la franja central y se
//     achica antes de leer: menos píxeles = menos milisegundos por cuadro.
//   - Solo se buscan los formatos que usa la tienda: CODE128 (las etiquetas
//     propias, src/components/labels/BarcodeLabel.tsx) y los de fábrica.
//   - Se lee cuadro a cuadro sin pausas (requestVideoFrameCallback), sin
//     lanzar una lectura nueva mientras la anterior no termina.
//   - Basta UNA lectura: CODE128 y EAN traen dígito verificador.
//
// Este reemplaza al BarcodeScannerModal con html5-qrcode que se probó y se
// revirtió en julio (commits 69ec11d / 82b1a62): decodificaba a 10 cuadros por
// segundo y se sentía lento.

import { useEffect, useRef, useState } from 'react';
import { ScanBarcode, Flashlight, FlashlightOff } from 'lucide-react';

// ---------------------------------------------------------------------------
// Detector (uno por pestaña, se reutiliza entre aperturas)
// ---------------------------------------------------------------------------

const FORMATS = ['code_128', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_39'] as const;

interface DetectorLike {
  detect(source: HTMLVideoElement | HTMLCanvasElement): Promise<Array<{ rawValue: string }>>;
}
interface NativeDetectorCtor {
  new (opts: { formats: string[] }): DetectorLike;
  getSupportedFormats(): Promise<string[]>;
}

let detectorPromise: Promise<{ detector: DetectorLike; native: boolean }> | null = null;

function getDetector() {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const Native = (globalThis as unknown as { BarcodeDetector?: NativeDetectorCtor }).BarcodeDetector;
      if (Native) {
        try {
          const supported = await Native.getSupportedFormats();
          const formats = FORMATS.filter((f) => supported.includes(f));
          if (formats.includes('code_128')) return { detector: new Native({ formats }), native: true };
        } catch {
          // Algunos navegadores exponen la clase pero sin soporte real: cae al WASM.
        }
      }
      const mod = await import('barcode-detector/ponyfill');
      await mod.prepareZXingModule({
        overrides: {
          locateFile: (path: string, prefix: string) =>
            path.endsWith('.wasm') ? `/zxing/${path}?v=${mod.ZXING_WASM_VERSION}` : prefix + path,
        },
        fireImmediately: true,
      });
      return {
        detector: new mod.BarcodeDetector({ formats: [...FORMATS] }) as unknown as DetectorLike,
        native: false,
      };
    })();
    // Si falló (sin red, por ejemplo), la próxima apertura lo reintenta.
    detectorPromise.catch(() => {
      detectorPromise = null;
    });
  }
  return detectorPromise;
}

// ---------------------------------------------------------------------------
// Sonido: iOS solo deja sonar audio creado dentro de un toque del usuario, por
// eso el contexto se "desbloquea" en el onClick del botón (ScanButton).
// ---------------------------------------------------------------------------

let audioCtx: AudioContext | null = null;

function unlockAudio() {
  try {
    const Ctor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    audioCtx ??= new Ctor();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
  } catch {
    // Sin audio: se queda la vibración.
  }
}

function beep(ok: boolean) {
  navigator.vibrate?.(ok ? 60 : [60, 60, 60]);
  if (!audioCtx) return;
  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = ok ? 1760 : 440;
    gain.gain.value = 0.15;
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + (ok ? 0.08 : 0.2));
  } catch {
    // ignorar
  }
}

// ---------------------------------------------------------------------------
// Botón
// ---------------------------------------------------------------------------

/**
 * Botón con ícono de cámara. Por defecto solo se ve en teléfono y tablet
 * (`lg:hidden`): en la caja de escritorio está el lector USB.
 */
export function ScanButton({
  onClick,
  className = 'lg:hidden',
  label,
  title = 'Escanear con la cámara',
}: {
  onClick: () => void;
  className?: string;
  label?: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={() => {
        unlockAudio();
        void getDetector(); // empieza a cargar mientras se pide la cámara
        onClick();
      }}
      className={`shrink-0 inline-flex items-center justify-center gap-1.5 rounded-lg bg-teal-700 hover:bg-teal-800 text-white font-semibold px-3 py-2 text-sm transition-colors cursor-pointer ${className}`}
    >
      <ScanBarcode size={20} />
      {label && <span className="whitespace-nowrap">{label}</span>}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Visor
// ---------------------------------------------------------------------------

export interface CameraScannerProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Recibe el código leído. En modo continuo, si devuelve un texto se muestra
   * sobre el video ("✓ Agregado …" / "✗ No encontrado …"); si empieza con ✗
   * suena el tono de error.
   */
  onScan: (code: string) => void | string | null | Promise<void | string | null>;
  /** true = sigue escaneando (POS, Etiquetas, Ofertas). false = cierra con la primera lectura. */
  continuous?: boolean;
  title?: string;
}

/** Ignorar relecturas del mismo código mientras sigue frente a la cámara. */
const SAME_CODE_COOLDOWN_MS = 1500;
/** Ancho máximo del recorte que se le pasa al lector WASM. */
const WASM_MAX_WIDTH = 800;

export default function CameraScanner({ isOpen, ...rest }: CameraScannerProps) {
  // Montar/desmontar con cada apertura deja cámara y estado siempre limpios.
  if (!isOpen) return null;
  return <ScannerView {...rest} />;
}

function ScannerView({
  onClose,
  onScan,
  continuous = false,
  title = 'Escanear código',
}: Omit<CameraScannerProps, 'isOpen'>) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const [starting, setStarting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ text: string; ok: boolean } | null>(null);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  // El bucle arranca una sola vez: lee los props por ref para no usar un
  // closure viejo (en modo continuo el padre re-renderiza con cada lectura).
  const onScanRef = useRef(onScan);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onScanRef.current = onScan;
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | null = null;
    let busy = false;
    let handling = false;
    let done = false;
    let lastRead: { code: string; at: number } | null = null;
    let feedbackTimer: ReturnType<typeof setTimeout> | null = null;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const stop = () => {
      stopped = true;
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      trackRef.current = null;
    };

    const handleCode = async (raw: string) => {
      const code = raw.trim();
      if (!code || done || handling) return;
      const now = Date.now();
      if (lastRead && lastRead.code === code && now - lastRead.at < SAME_CODE_COOLDOWN_MS) return;
      lastRead = { code, at: now };

      if (!continuous) {
        // Se cierra ANTES de procesar: el resultado se ve en la pantalla de
        // atrás en vez de quedarse mirando un video congelado.
        done = true;
        beep(true);
        stop();
        onCloseRef.current();
        void onScanRef.current(code);
        return;
      }

      handling = true;
      try {
        const result = await onScanRef.current(code);
        const text = typeof result === 'string' && result ? result : `✓ ${code}`;
        const ok = !text.startsWith('✗');
        beep(ok);
        if (!stopped) {
          setFeedback({ text, ok });
          if (feedbackTimer) clearTimeout(feedbackTimer);
          feedbackTimer = setTimeout(() => setFeedback(null), 2200);
        }
      } finally {
        // El cooldown cuenta desde que terminó de procesarse.
        lastRead = { code, at: Date.now() };
        handling = false;
      }
    };

    // Franja central del cuadro, achicada: es donde el usuario apunta.
    const cropToCanvas = (video: HTMLVideoElement) => {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const sw = Math.round(vw * 0.9);
      const sh = Math.round(Math.min(vh * 0.45, sw * 0.6));
      const sx = Math.round((vw - sw) / 2);
      const sy = Math.round((vh - sh) / 2);
      const scale = Math.min(1, WASM_MAX_WIDTH / sw);
      const dw = Math.round(sw * scale);
      const dh = Math.round(sh * scale);
      if (canvas.width !== dw) canvas.width = dw;
      if (canvas.height !== dh) canvas.height = dh;
      ctx?.drawImage(video, sx, sy, sw, sh, 0, 0, dw, dh);
      return canvas;
    };

    const onVisibility = () => {
      // Al salir de la app se suelta la cámara (si no, queda la luz encendida).
      if (document.visibilityState === 'hidden') onCloseRef.current();
    };
    document.addEventListener('visibilitychange', onVisibility);

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStarting(false);
        setError('Este navegador no permite usar la cámara. La cámara solo funciona si la página abre con https://');
        return;
      }

      try {
        const detectorP = getDetector();
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();

        const track = stream.getVideoTracks()[0];
        trackRef.current = track;
        try {
          const caps = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities & {
            focusMode?: string[];
            torch?: boolean;
          };
          if (caps.focusMode?.includes('continuous')) {
            await track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] });
          }
          if (caps.torch) setTorchAvailable(true);
        } catch {
          // Enfoque/linterna son extras: si el teléfono no los deja, se sigue.
        }

        const { detector, native } = await detectorP;
        if (stopped) return;
        setStarting(false);

        type VideoWithRVFC = HTMLVideoElement & {
          requestVideoFrameCallback?: (cb: () => void) => number;
        };
        const v = video as VideoWithRVFC;
        const schedule = () => {
          if (stopped) return;
          if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(tick);
          else requestAnimationFrame(tick);
        };
        const tick = () => {
          if (stopped) return;
          if (busy || handling || video.readyState < 2 || !video.videoWidth) {
            schedule();
            return;
          }
          busy = true;
          detector
            .detect(native ? video : cropToCanvas(video))
            .then((codes) => {
              const hit = codes.find((c) => c.rawValue);
              if (hit) void handleCode(hit.rawValue);
            })
            .catch(() => {
              // Un cuadro que no se pudo leer: normal, se sigue con el próximo.
            })
            .finally(() => {
              busy = false;
              schedule();
            });
        };
        schedule();
      } catch (err) {
        if (stopped) return;
        setStarting(false);
        const name = err instanceof Error ? err.name : '';
        const msg = err instanceof Error ? err.message : String(err);
        if (name === 'NotAllowedError' || /permission|denied|notallowed/i.test(msg)) {
          setError('Permiso de cámara denegado. Actívalo para este sitio en los ajustes del navegador y vuelve a intentar.');
        } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
          setError('No se encontró una cámara en este equipo.');
        } else if (name === 'NotReadableError') {
          setError('La cámara está ocupada por otra app. Ciérrala y vuelve a intentar.');
        } else {
          setError('No se pudo iniciar el escáner. Revisa la conexión y que la página abra con https://');
        }
      }
    })();

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      if (feedbackTimer) clearTimeout(feedbackTimer);
      stop();
    };
  }, [continuous]);

  const toggleTorch = async () => {
    const track = trackRef.current;
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorchOn(next);
    } catch {
      setTorchAvailable(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[120] bg-black flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 bg-black/80 text-white">
        <h2 className="font-bold text-base flex items-center gap-2">
          <ScanBarcode size={20} /> {title}
        </h2>
        <button
          onClick={onClose}
          className="text-2xl leading-none px-3 py-1 rounded-full hover:bg-white/10 cursor-pointer"
          aria-label="Cerrar escáner"
        >
          ✕
        </button>
      </div>

      <div className="relative flex-1 overflow-hidden">
        <video ref={videoRef} className="absolute inset-0 w-full h-full object-cover" playsInline muted autoPlay />

        {/* Guía: la franja que se lee. Fuera de ella se oscurece. */}
        {!error && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="relative w-[88%] max-w-md aspect-[2.2/1] rounded-xl border-2 border-white/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]">
              <div className="absolute left-3 right-3 top-1/2 h-0.5 bg-red-500/90 animate-pulse" />
            </div>
          </div>
        )}

        {starting && !error && (
          <p className="absolute inset-x-0 top-6 text-center text-white/80 text-sm">Abriendo cámara…</p>
        )}

        {error && (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <p className="text-red-200 text-sm text-center leading-relaxed bg-black/70 rounded-xl p-4">⚠️ {error}</p>
          </div>
        )}

        {feedback && (
          <div className="absolute bottom-6 inset-x-4 pointer-events-none">
            <p
              className={`text-center text-base font-bold px-4 py-3 rounded-xl shadow-lg ${
                feedback.ok ? 'bg-emerald-600/95 text-white' : 'bg-red-600/95 text-white'
              }`}
            >
              {feedback.text}
            </p>
          </div>
        )}
      </div>

      <div className="px-4 py-4 bg-black/80 flex items-center gap-3">
        <p className="flex-1 text-white/70 text-xs leading-snug">
          Pon el código dentro del recuadro.{continuous && ' Puedes escanear varios seguidos.'}
        </p>
        {torchAvailable && (
          <button
            onClick={toggleTorch}
            className="p-3 rounded-full bg-white/15 text-white hover:bg-white/25 cursor-pointer"
            aria-label={torchOn ? 'Apagar linterna' : 'Encender linterna'}
          >
            {torchOn ? <FlashlightOff size={20} /> : <Flashlight size={20} />}
          </button>
        )}
        <button
          onClick={onClose}
          className="px-5 py-3 rounded-xl bg-white text-slate-900 font-bold text-sm cursor-pointer"
        >
          Listo
        </button>
      </div>
    </div>
  );
}
