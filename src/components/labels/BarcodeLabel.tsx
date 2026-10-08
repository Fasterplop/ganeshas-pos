'use client';

import Barcode from 'react-barcode';
import { formatVariant, labelFontPx, labelFontPxNoPrice, LABEL_NAME_LINE_HEIGHT } from '@/lib/productVariant';

/**
 * Etiqueta térmica 62x29 mm (rollo Brother DK-1209).
 *
 * Este markup estaba COPIADO en /labels y en /inventory. Vive acá para que las
 * dos versiones no se separen: cualquier ajuste de milímetros o de tipografía
 * tiene que verse igual imprimiendo en lote y imprimiendo de a una.
 *
 * Dos variantes, según `showPrice`:
 *
 *  - CON precio (la de siempre, y la única de la Tienda de Juguetes): nombre +
 *    " · talla/color" en el mismo bloque, el precio grande debajo (con el
 *    anterior tachado si hay descuento) y el código de barras al pie.
 *
 *  - SIN precio (Tienda de Ropa): se quita el precio y ese espacio va al
 *    nombre, a la talla/color en su PROPIA línea y en negrita —para que el
 *    cliente vea su talla sin preguntar— y a un código de barras más alto, que
 *    el teléfono lee más rápido y desde más lejos. El código de barras es el
 *    mismo de siempre: las etiquetas viejas ya pegadas se siguen escaneando.
 *
 * OJO con el alto: la Brother NO imprime los ~3 mm de arriba ni los ~3 mm de
 * abajo de la etiqueta troquelada (de 341 puntos de alto solo 271 son
 * imprimibles). Lo que el navegador dibuje en esas franjas sale en blanco, así
 * que el contenido tiene que caber en ~23 mm y no en 29. Las dos variantes se
 * arman dentro de esa franja, y en las dos lo único que puede ceder si algo no
 * cabe es el nombre: el precio, la talla y el código nunca se recortan. Los
 * tamaños de letra salen de labelFontPx / labelFontPxNoPrice, que ya cuentan
 * con estas medidas: si se mueve algo acá, hay que rehacer esa cuenta.
 */

// El relleno ES la franja que la impresora no imprime, con un pelo de margen.
// Lo que queda adentro (~85 px de alto) sale completo.
const LABEL_PADDING = '3.3mm 1.5mm';
// Alto de las barras sin precio: nunca menos que las de la etiqueta con precio
// (20 px, que ya se sabe que escanea) ni más de lo que aporta leer mejor.
const BARS_MIN_PX = 20;
const BARS_MAX_PX = 40;

export interface BarcodeLabelProps {
  name: string;
  skuBarcode: string;
  talla?: string | null;
  color?: string | null;
  /** Precio a imprimir. Se ignora cuando showPrice es false. */
  price?: number;
  /** Precio anterior, tachado. Se omite si no hay descuento. */
  originalPrice?: number | null;
  showPrice: boolean;
}

export default function BarcodeLabel({
  name,
  skuBarcode,
  talla,
  color,
  price = 0,
  originalPrice = null,
  showPrice,
}: BarcodeLabelProps) {
  const variant = formatVariant(talla, color);
  const struck = showPrice && originalPrice != null && originalPrice > price;

  const fs = showPrice ? labelFontPx(name, variant) : labelFontPxNoPrice(name, variant);

  return (
    <div
      className="flex flex-row items-center justify-between bg-white print:break-after-page"
      style={{ width: '62mm', height: '29mm', overflow: 'hidden', margin: 0, padding: LABEL_PADDING }}
    >
      {/* Texto vertical: nombre de la tienda */}
      <div className="flex items-center justify-center h-full pl-1">
        <p
          className="text-[8px] font-black text-black tracking-wider uppercase"
          style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
        >
          Ganesha Store
        </p>
      </div>

      {/* Contenido principal: ocupa todo el alto imprimible y centra adentro. */}
      <div className="flex flex-col items-center justify-center flex-1 w-full h-full overflow-hidden pr-1">
        {showPrice ? (
          <>
            {/* Nombre + Talla · Color en un solo bloque: si el nombre es largo
                hace wrap hacia abajo (no se corta con "...") y la variante
                continúa en línea tras un " · ". Si algo no cabe, lo único que
                cede es el nombre (min-h-0 + overflow-hidden). */}
            <p
              className="font-black text-black w-full text-center break-words min-h-0 overflow-hidden"
              style={{ fontSize: `${fs.name}px`, lineHeight: LABEL_NAME_LINE_HEIGHT }}
            >
              {name.toUpperCase()}
              {variant && <span style={{ fontSize: `${fs.variant}px` }}> · {variant}</span>}
            </p>

            <div className="flex items-baseline gap-2 my-px shrink-0">
              {struck && (
                <p className="text-[12px] line-through text-gray-500 leading-none">
                  ${Number(originalPrice).toFixed(2)}
                </p>
              )}
              <p className="text-[24px] font-black text-black leading-none">${price.toFixed(2)}</p>
            </div>

            <div className="shrink-0">
              <Barcode value={skuBarcode} width={1.3} height={20} fontSize={10} margin={0} displayValue={true} />
            </div>
          </>
        ) : (
          <>
            {/* Si algo no cabe, lo único que cede es el nombre (min-h-0 +
                overflow-hidden): la talla y el código nunca se recortan. */}
            <p
              className="font-black text-black w-full text-center break-words min-h-0 overflow-hidden"
              style={{ fontSize: `${fs.name}px`, lineHeight: LABEL_NAME_LINE_HEIGHT }}
            >
              {name.toUpperCase()}
            </p>

            {/* Talla y color en su propia línea, en negrita: el cliente ve su
                talla sin tener que escanear ni preguntar. */}
            {variant && (
              <p
                className="font-bold text-black w-full text-center uppercase tracking-wide shrink-0"
                style={{ fontSize: `${fs.variant}px`, lineHeight: 1.15 }}
              >
                {variant}
              </p>
            )}

            {/* Código de barras más ancho y tan alto como deje el nombre: es lo
                que el teléfono lee. Se dibuja al alto máximo y la caja lo
                recorta por abajo (a una barra no le cambia nada ser más
                corta), así un nombre de dos renglones le quita alto en vez de
                empujarlo fuera de la zona imprimible. */}
            <div
              className="mt-0.5 flex-1 w-full flex justify-center items-start overflow-hidden"
              style={{ minHeight: `${BARS_MIN_PX}px`, maxHeight: `${BARS_MAX_PX}px` }}
            >
              <Barcode value={skuBarcode} width={1.5} height={BARS_MAX_PX} margin={0} displayValue={false} />
            </div>

            {/* El código en texto va aparte porque dentro del SVG se recortaría
                junto con las barras. */}
            <p
              className="shrink-0 text-black leading-none"
              style={{ fontSize: '10px', fontFamily: 'monospace', marginTop: '2px' }}
            >
              {skuBarcode}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
