'use client';

// Ventana para pasar unidades de un producto de una tienda a la otra.
//
// La comparten la caja ("este producto es de la otra tienda: traerlo y
// agregarlo a la venta") y el inventario (transferir, en un sentido o en el otro).
// El movimiento lo hace el RPC `transfer_stock`; ver src/lib/transfers.ts.
//
// Tiene su propia capa (z-[130]) en vez de usar <Modal>: en la caja tiene que
// quedar POR ENCIMA del visor de la cámara, que es z-[120] a pantalla completa.

import { useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { formatVariant } from '@/lib/productVariant';
import {
  stockByStore,
  transferStock,
  type StoreLite,
  type TransferProduct,
  type TransferResult,
  type TransferSource,
} from '@/lib/transfers';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** Se llama en cuanto la transferencia queda hecha (antes de cerrar). */
  onDone?: (result: TransferResult) => void;
  product: TransferProduct | null;
  stores: StoreLite[];
  fromStoreId: string | null;
  toStoreId: string | null;
  source: TransferSource;
  title?: string;
  confirmLabel?: string;
  /** Cantidad inicial y mínima (la caja pide al menos lo que falta). */
  minQuantity?: number;
  /** Inventario: permite invertir el sentido (enviar / traer de vuelta). */
  allowFlip?: boolean;
  /** Inventario: campo de nota opcional. */
  showNote?: boolean;
  /**
   * Caja: anula el teclado mientras la ventana está abierta. El lector de
   * códigos es un teclado que escribe y manda Enter; sin esto, escanear el
   * siguiente producto confirmaría la transferencia.
   */
  scannerSafe?: boolean;
  /**
   * Inventario: si el origen quedaría en negativo, pedir una casilla de
   * confirmación (protege de un dedazo). La caja no la pide: ahí el producto
   * está en la mano del cajero y el aviso ámbar alcanza.
   */
  confirmNegative?: boolean;
  /** Inventario: mostrar cómo quedó cada tienda antes de cerrar. */
  showSuccess?: boolean;
}

export default function TransferModal(props: Props) {
  // Cerrado no se monta el cuerpo: cada apertura arranca con estado limpio.
  if (!props.isOpen || !props.product || !props.fromStoreId || !props.toStoreId) return null;
  return (
    <TransferModalBody
      {...props}
      product={props.product}
      fromStoreId={props.fromStoreId}
      toStoreId={props.toStoreId}
    />
  );
}

type BodyProps = Omit<Props, 'isOpen' | 'product' | 'fromStoreId' | 'toStoreId'> & {
  product: TransferProduct;
  fromStoreId: string;
  toStoreId: string;
};

const MAX_QTY = 999; // mismo tope que el RPC

function newRequestId(): string | null {
  try {
    return crypto.randomUUID();
  } catch {
    return null; // sin contexto seguro: se pierde la idempotencia, no la función
  }
}

function TransferModalBody({
  onClose, onDone, product, stores, fromStoreId, toStoreId, source,
  title, confirmLabel, minQuantity,
  allowFlip, showNote, scannerSafe, confirmNegative, showSuccess,
}: BodyProps) {
  const supabase = createClient();
  const boxRef = useRef<HTMLDivElement>(null);
  // Un id por apertura (se genera al primer intento): un doble clic o un
  // reintento por mala señal no mueve dos veces, porque el RPC devuelve el
  // movimiento ya hecho.
  const requestId = useRef<string | null>(null);

  const [flipped, setFlipped] = useState(false);
  const fromId = flipped ? toStoreId : fromStoreId;
  const toId = flipped ? fromStoreId : toStoreId;

  const minQty = Math.max(1, Math.floor(minQuantity ?? 1));
  const [quantity, setQuantity] = useState(Math.min(MAX_QTY, minQty));
  const [note, setNote] = useState('');
  const [stocks, setStocks] = useState<Record<string, number> | null>(null);
  const [acceptNegative, setAcceptNegative] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<TransferResult | null>(null);

  const storeName = (id: string) => stores.find(s => s.id === id)?.name ?? 'la otra tienda';
  const variant = formatVariant(product.talla, product.color);

  // Stock fresco de las dos tiendas: lo que hay en la lista de quien abrió la
  // ventana puede tener minutos.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const map = await stockByStore(supabase, product.id);
      if (!cancelled) setStocks(map ?? {});
    })();
    return () => { cancelled = true; };
  }, [supabase, product.id]);

  // Caja: el foco sale del buscador y el teclado queda anulado (salvo Escape).
  // onClose y submitting se leen por ref para no desmontar y volver a montar
  // los listeners en cada render de la página que abrió la ventana.
  const onCloseRef = useRef(onClose);
  const submittingRef = useRef(submitting);
  useEffect(() => {
    onCloseRef.current = onClose;
    submittingRef.current = submitting;
  });

  useEffect(() => {
    if (!scannerSafe) return;
    (document.activeElement as HTMLElement | null)?.blur?.();
    boxRef.current?.focus();

    const swallow = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.type === 'keydown' && e.key === 'Escape' && !submittingRef.current) onCloseRef.current();
    };
    window.addEventListener('keydown', swallow, true);
    window.addEventListener('keypress', swallow, true);
    window.addEventListener('keyup', swallow, true);
    return () => {
      window.removeEventListener('keydown', swallow, true);
      window.removeEventListener('keypress', swallow, true);
      window.removeEventListener('keyup', swallow, true);
    };
  }, [scannerSafe]);

  const loading = stocks === null;
  const fromStock = stocks?.[fromId] ?? 0;
  const toStock = stocks?.[toId] ?? 0;
  const fromIsOwner = product.owner_store_id === fromId;

  // De la tienda dueña se puede sacar más de lo anotado (con aviso): el sistema
  // nunca bloquea una venta y ese negativo se ve en su inventario. De la tienda
  // NO dueña nunca: un negativo ahí es justo el descuadre que no se ve.
  const maxQty = fromIsOwner ? MAX_QTY : Math.max(0, fromStock);
  const goesNegative = !loading && quantity > fromStock;
  const blocked = !loading && !fromIsOwner && quantity > maxQty;
  const needsCheckbox = !!confirmNegative && goesNegative && fromIsOwner;

  const canConfirm = !loading && !submitting && quantity >= 1 && !blocked
    && (!needsCheckbox || acceptNegative);

  const changeQty = (delta: number) => {
    setQuantity(q => Math.max(minQty, Math.min(maxQty || minQty, q + delta)));
    setAcceptNegative(false);
    setError(null);
  };

  const flip = () => {
    setFlipped(f => !f);
    setQuantity(minQty);
    setAcceptNegative(false);
    setError(null);
  };

  const handleConfirm = async () => {
    if (!canConfirm) return;
    setSubmitting(true);
    setError(null);
    requestId.current ??= newRequestId();
    const { result, error: rpcError } = await transferStock(supabase, {
      productId: product.id,
      fromStoreId: fromId,
      toStoreId: toId,
      quantity,
      source,
      note,
      allowNegative: goesNegative && fromIsOwner,
      requestId: requestId.current,
    });
    setSubmitting(false);

    if (!result) {
      setError(rpcError ?? 'No se pudo hacer la transferencia.');
      // El stock pudo haber cambiado mientras la ventana estaba abierta.
      const map = await stockByStore(supabase, product.id);
      if (map) setStocks(map);
      return;
    }

    onDone?.(result);
    if (showSuccess) setDone(result);
    else onClose();
  };

  const heading = title ?? 'Transferir producto';

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
      <div
        ref={boxRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        className="bg-white rounded-xl shadow-2xl w-full max-w-md max-h-[90vh] flex flex-col overflow-hidden outline-none"
      >
        <div className="px-5 py-4 bg-teal-50 border-b border-teal-100 flex justify-between items-start gap-3">
          <h2 className="text-lg font-bold text-teal-800 leading-snug">{heading}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Cerrar"
            className="text-slate-400 hover:text-slate-700 transition p-1 rounded-full hover:bg-white disabled:opacity-50"
          >
            ✕
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-4">
          {done ? (
            <>
              <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg px-4 py-3 text-sm font-medium">
                {done.quantity === 1 ? 'Se pasó 1 unidad' : `Se pasaron ${done.quantity} unidades`} de{' '}
                <strong>{product.name}</strong> de {storeName(done.from_store_id)} a {storeName(done.to_store_id)}.
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="border border-slate-200 rounded-lg px-3 py-2">
                  <p className="text-slate-500">{storeName(done.from_store_id)}</p>
                  <p className="text-xl font-bold text-slate-800">{done.from_stock}</p>
                </div>
                <div className="border border-slate-200 rounded-lg px-3 py-2">
                  <p className="text-slate-500">{storeName(done.to_store_id)}</p>
                  <p className="text-xl font-bold text-slate-800">{done.to_stock}</p>
                </div>
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 bg-[#0f5c5c] text-white rounded-lg font-medium hover:bg-[#0a4545] transition cursor-pointer"
                >
                  Listo
                </button>
              </div>
            </>
          ) : (
            <>
              <div>
                <p className="text-lg font-bold text-slate-900 leading-snug">{product.name}</p>
                {variant && <p className="text-sm text-slate-500">{variant}</p>}
                {product.sku_barcode && (
                  <p className="text-xs font-mono text-slate-400 mt-0.5">{product.sku_barcode}</p>
                )}
                {product.price != null && (
                  <p className="text-2xl font-extrabold text-teal-700 mt-1">${Number(product.price).toFixed(2)}</p>
                )}
              </div>

              <div className="flex items-stretch gap-2 text-sm">
                <div className="flex-1 border border-slate-200 rounded-lg px-3 py-2">
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Sale de</p>
                  <p className="font-semibold text-slate-800">{storeName(fromId)}</p>
                  <p className="text-slate-500">{loading ? 'Consultando…' : `Hay ${fromStock}`}</p>
                </div>
                <div className="flex items-center text-slate-400 text-xl" aria-hidden="true">→</div>
                <div className="flex-1 border border-slate-200 rounded-lg px-3 py-2">
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Entra a</p>
                  <p className="font-semibold text-slate-800">{storeName(toId)}</p>
                  <p className="text-slate-500">{loading ? 'Consultando…' : `Hay ${toStock}`}</p>
                </div>
              </div>

              {allowFlip && (
                <button
                  type="button"
                  onClick={flip}
                  disabled={submitting}
                  className="text-sm font-semibold text-teal-700 hover:text-teal-900 underline underline-offset-2 disabled:opacity-50"
                >
                  ⇄ Invertir el sentido
                </button>
              )}

              <div className="flex items-center justify-between gap-3">
                <span className="text-base font-medium text-slate-700">
                  {source === 'pos' ? '¿Cuántas traes?' : '¿Cuántas unidades?'}
                </span>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => changeQty(-1)}
                    disabled={submitting || quantity <= minQty}
                    className="w-11 h-11 flex items-center justify-center rounded-full bg-slate-100 text-slate-700 hover:bg-slate-200 transition font-bold text-xl disabled:opacity-40"
                  >
                    −
                  </button>
                  <span className="w-9 text-center text-2xl font-bold text-slate-800">{quantity}</span>
                  <button
                    type="button"
                    onClick={() => changeQty(1)}
                    disabled={submitting || loading || quantity >= maxQty}
                    className="w-11 h-11 flex items-center justify-center rounded-full bg-slate-100 text-slate-700 hover:bg-teal-100 hover:text-teal-700 transition font-bold text-xl disabled:opacity-40"
                  >
                    +
                  </button>
                </div>
              </div>

              {blocked && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm font-medium">
                  {maxQty === 0
                    ? `En ${storeName(fromId)} no hay unidades de este producto para pasar.`
                    : `En ${storeName(fromId)} solo hay ${maxQty}.`}
                </div>
              )}

              {goesNegative && fromIsOwner && (
                <div className="bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-lg text-sm">
                  El sistema tiene anotadas <strong>{fromStock}</strong> en {storeName(fromId)}. Si el producto
                  está en la mano se puede continuar: {storeName(fromId)} quedará en negativo y aparecerá en sus
                  «Agotados» para que revisen el conteo.
                  {needsCheckbox && (
                    <label className="mt-2 flex items-start gap-2 cursor-pointer font-medium">
                      <input
                        type="checkbox"
                        checked={acceptNegative}
                        onChange={e => setAcceptNegative(e.target.checked)}
                        className="mt-0.5 w-4 h-4 accent-amber-600 shrink-0"
                      />
                      Entiendo que {storeName(fromId)} quedará en negativo.
                    </label>
                  )}
                </div>
              )}

              {showNote && (
                <div>
                  <label className="block text-sm font-medium text-slate-600 mb-1">Nota (opcional)</label>
                  <input
                    type="text"
                    value={note}
                    onChange={e => setNote(e.target.value)}
                    maxLength={200}
                    placeholder="Ej.: para la vitrina de la entrada"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>
              )}

              {error && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm font-medium">
                  {error}
                </div>
              )}

              <div className="flex justify-end gap-3 pt-1">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={submitting}
                  className="px-4 py-2.5 border border-slate-300 rounded-lg font-medium text-slate-700 hover:bg-slate-50 transition cursor-pointer disabled:opacity-60"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={() => void handleConfirm()}
                  disabled={!canConfirm}
                  className="px-4 py-2.5 bg-[#0f5c5c] text-white rounded-lg font-bold hover:bg-[#0a4545] transition cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {submitting ? 'Transfiriendo…' : (confirmLabel ?? 'Transferir')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
