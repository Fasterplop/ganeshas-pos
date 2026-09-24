// Copia el lector de códigos de barras (zxing_reader.wasm) a public/zxing/.
//
// Lo usa el escáner con cámara (src/components/CameraScanner.tsx) en los
// teléfonos cuyo navegador no trae BarcodeDetector nativo (iPhone/Safari).
// Se sirve desde nuestro propio dominio en vez del CDN por defecto de la
// librería: más rápido desde Venezuela y sin depender de un tercero.
//
// Corre solo antes de `npm run dev` y `npm run build` (predev/prebuild), así
// el .wasm siempre corresponde a la versión instalada de zxing-wasm. El
// archivo copiado está en .gitignore.
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// zxing-wasm es dependencia de barcode-detector. npm normalmente la sube a la
// raíz de node_modules; si hubiera choque de versiones quedaría anidada.
// (No se usa require.resolve: ninguno de los dos paquetes exporta su
// package.json.)
const candidates = [
  join(root, 'node_modules', 'barcode-detector', 'node_modules', 'zxing-wasm'),
  join(root, 'node_modules', 'zxing-wasm'),
].map((dir) => join(dir, 'dist', 'reader', 'zxing_reader.wasm'));

const src = candidates.find((p) => existsSync(p));
if (!src) {
  console.error('[copy-zxing-wasm] No se encontró zxing_reader.wasm. ¿Falta npm install?');
  process.exit(1);
}

const outDir = join(root, 'public', 'zxing');
mkdirSync(outDir, { recursive: true });
copyFileSync(src, join(outDir, 'zxing_reader.wasm'));
console.log('[copy-zxing-wasm] public/zxing/zxing_reader.wasm listo');
