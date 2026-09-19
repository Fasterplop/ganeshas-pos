'use client';

import Barcode from 'react-barcode';
import { formatVariant, labelFontPx, labelFontPxNoPrice } from '@/lib/productVariant';

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
 */
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

  const fs = showPrice
    ? labelFontPx(`${name}${variant ? ` · ${variant}` : ''}`)
    : labelFontPxNoPrice(name);

  return (
    <div
      className="flex flex-row items-center justify-between bg-white print:break-after-page"
      style={{ width: '62mm', height: '29mm', overflow: 'hidden', margin: 0, padding: '1.2mm 1.5mm 2.2mm 1.5mm' }}
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

      {/* Contenido principal */}
      <div className="flex flex-col items-center justify-center flex-1 w-full overflow-hidden pr-1">
        {showPrice ? (
          <>
            {/* Nombre + Talla · Color en un solo bloque: si el nombre es largo
                hace wrap hacia abajo (no se corta con "...") y la variante
                continúa en línea tras un " · ". */}
            <p
              className="font-black text-black w-full text-center leading-tight break-words"
              style={{ fontSize: `${fs.name}px` }}
            >
              {name.toUpperCase()}
              {variant && <span style={{ fontSize: `${fs.variant}px` }}> · {variant}</span>}
            </p>

            <div className="flex items-baseline gap-2 mt-0.5 mb-0.5">
              {struck && (
                <p className="text-[12px] line-through text-gray-500 leading-none">
                  ${Number(originalPrice).toFixed(2)}
                </p>
              )}
              <p className="text-[24px] font-black text-black leading-none">${price.toFixed(2)}</p>
            </div>

            <Barcode value={skuBarcode} width={1.3} height={20} fontSize={10} margin={0} displayValue={true} />
          </>
        ) : (
          <>
            <p
              className="font-black text-black w-full text-center leading-tight break-words"
              style={{ fontSize: `${fs.name}px` }}
            >
              {name.toUpperCase()}
            </p>

            {/* Talla y color en su propia línea, en negrita: el cliente ve su
                talla sin tener que escanear ni preguntar. */}
            {variant && (
              <p
                className="font-bold text-black w-full text-center leading-tight uppercase tracking-wide"
                style={{ fontSize: `${fs.variant}px` }}
              >
                {variant}
              </p>
            )}

            {/* Código de barras más alto y más ancho: es lo que el teléfono lee. */}
            <div className="mt-0.5">
              <Barcode value={skuBarcode} width={1.5} height={34} fontSize={10} margin={0} displayValue={true} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
