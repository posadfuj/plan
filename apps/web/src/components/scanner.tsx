/**
 * Escáner de QR con la cámara trasera. Usa BarcodeDetector cuando el navegador lo trae
 * (Chrome en Android) y, si no, zxing-wasm (iPhone/Safari y el resto). El archivo .wasm se sirve
 * desde la propia app: la imagen de la cámara nunca sale del dispositivo.
 *
 * La cámara del navegador solo funciona en https:// o en localhost.
 */
import { useEffect, useRef, useState } from 'react';

type Detect = (source: HTMLVideoElement, canvas: HTMLCanvasElement) => Promise<string | null>;

interface NativeDetector {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
declare global {
  interface Window {
    BarcodeDetector?: {
      new (opts: { formats: string[] }): NativeDetector;
      getSupportedFormats(): Promise<string[]>;
    };
  }
}

async function nativeDetector(): Promise<Detect | null> {
  const BD = window.BarcodeDetector;
  if (!BD) return null;
  try {
    if (!(await BD.getSupportedFormats()).includes('qr_code')) return null;
    const detector = new BD({ formats: ['qr_code'] });
    return async (video) => (await detector.detect(video))[0]?.rawValue ?? null;
  } catch {
    return null;
  }
}

async function wasmDetector(): Promise<Detect> {
  const [{ prepareZXingModule, readBarcodes }, { default: wasmUrl }] = await Promise.all([
    import('zxing-wasm/reader'),
    import('zxing-wasm/reader/zxing_reader.wasm?url'),
  ]);
  // Se instancia ya (no en el primer escaneo): la caja precarga el lector al abrir el turno.
  await prepareZXingModule({
    overrides: {
      locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path),
    },
    fireImmediately: true,
  });
  return async (video, canvas) => {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return null;
    // Se analiza el centro de la imagen, reducido: más rápido en celulares de gama media o baja.
    const side = Math.min(w, h);
    const size = Math.min(side, 720);
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(video, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size);
    const results = await readBarcodes(ctx.getImageData(0, 0, size, size), {
      formats: ['QRCode'],
      tryHarder: true,
      maxNumberOfSymbols: 1,
    });
    return results[0]?.text ?? null;
  };
}

let detector: Promise<Detect> | null = null;
/** Un solo lector por pestaña; se prepara en segundo plano al abrir la caja. */
function getDetector(): Promise<Detect> {
  detector ??= nativeDetector().then((d) => d ?? wasmDetector());
  detector.catch(() => (detector = null));
  return detector;
}
export function warmUpScanner() {
  void getDetector().catch(() => undefined);
}

export function Scanner({ onResult, onCancel }: { onResult: (text: string) => void; onCancel: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false;
    let timer = 0;

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError(
          'Este navegador no permite usar la cámara aquí. Abre la caja con https:// o busca por celular.',
        );
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
      } catch {
        setError(
          'No pudimos abrir la cámara. Revisa el permiso de cámara del navegador o busca por celular.',
        );
        return;
      }
      if (stopped) return stream.getTracks().forEach((t) => t.stop());
      const v = video.current!;
      v.srcObject = stream;
      await v.play().catch(() => undefined);
      const detect = await getDetector();
      const tick = async () => {
        if (stopped || done.current) return;
        const text = await detect(v, canvas.current!).catch(() => null);
        if (text && !done.current) {
          done.current = true;
          navigator.vibrate?.(60);
          onResult(text);
          return;
        }
        timer = window.setTimeout(() => void tick(), 120);
      };
      void tick();
    })();

    return () => {
      stopped = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onResult]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black" data-testid="scanner">
      <div className="relative flex-1 overflow-hidden">
        <video ref={video} playsInline muted autoPlay className="h-full w-full object-cover" />
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="aspect-square w-3/4 max-w-sm rounded-3xl border-4 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,.45)]" />
        </div>
        <p className="absolute inset-x-0 top-6 text-center text-lg font-semibold text-white">
          Apunta al QR de la tarjeta del cliente
        </p>
        {error && (
          <div
            className="absolute inset-x-4 top-20 rounded-xl bg-white p-4 text-sm text-red-800"
            role="alert"
          >
            {error}
          </div>
        )}
      </div>
      <canvas ref={canvas} className="hidden" />
      <div className="p-4 pb-8">
        <button
          onClick={onCancel}
          className="min-h-14 w-full rounded-2xl bg-white text-lg font-semibold text-gray-900 active:scale-[.99]"
        >
          Cancelar
        </button>
      </div>
    </div>
  );
}

/**
 * Extrae el token de lo que leyó la cámara: la URL /s/{token} de la tarjeta del cliente
 * (de cualquier dominio: la tarjeta la arma con su propio origen) o el token solo.
 */
export function scanTokenFrom(text: string): string | null {
  const m = /(?:^|\/s\/)([0-9A-Za-z]{22})(?:[/?#]|$)/.exec(text.trim());
  return m ? m[1]! : null;
}
