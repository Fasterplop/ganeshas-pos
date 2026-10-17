'use client';

// Ventana para pasar unidades de un producto de una tienda a la otra.
//
// La comparten la caja ("este producto es de la otra tienda: traerlo y
// agregarlo a la venta") y el inventario (transferir, en un sentido o en el otro).
// El movimiento lo hace el RPC `transfer_stock`; ver src/lib/transfers.ts.
//
// En el inventario (allowMove) primero se elige qué se quiere: mover unidades
// (el producto sigue siendo de su tienda) o pasar el producto a la otra tienda
// (`move_product_to_store`: cambia de dueña con todas sus unidades). Elegir es
// obligatorio a propósito: la primera transferencia real fue una mudanza hecha
// como préstamo, y el producto quedó fuera del inventario de la tienda que lo
// tenía.
//
// Tiene su propia capa (z-[130]) en vez de usar <Modal>: en la caja tiene que
// quedar POR ENCIMA del visor de la cámara, que es z-[120] a pantalla completa.

import { useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { formatVariant } from '@/lib/productVariant';
import {
  moveProductToStore,
  stockByStore,
  transferStock,
  type MoveResult,
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
  /** Se llama en cuanto el producto pasa a la otra tienda (antes de cerrar). */
  onMoved?: (result: MoveResult) => void;
  /**
   * Inventario: ofrecer «Pasar el producto a la otra tienda» además de mover
   * unidades. Solo aplica mientras el sentido sea desde la tienda dueña.
   */
  allowMove?: boolean;
  /** Si el producto es una variante: su modelo y cuántas variantes activas tiene (ella incluida). */
  groupInfo?: { name: string; variants: number } | null;
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
  onClose, onDone, onMoved, product, stores, fromStoreId, toStoreId, source,
  title, confirmLabel, minQuantity,
  allowFlip, allowMove, groupInfo, showNote, scannerSafe, confirmNegative, showSuccess,
}: BodyProps) {
  const supabase = createClient();
  const boxRef = useRef<HTMLDivElement>(null);
  // Un id por apertura (se genera al primer intento): un doble clic o un
  // reintento por mala señal no mueve dos veces, porque el RPC devuelve el
  // movimiento ya hecho. Uno por RPC: si una transferencia se hizo pero la
  // respuesta no llegó, pasar el producto con el mismo id devolvería aquella.
  const requestId = useRef<string | null>(null);
  const moveRequestId = useRef<string | null>(null);

  const [flipped, setFlipped] = useState(false);
  const fromId = flipped ? toStoreId : fromStoreId;
  const toId = flipped ? fromStoreId : toStoreId;

  // null = todavía no eligió (solo cuando se ofrece pasar el producto).
  const [mode, setMode] = useState<'units' | 'move' | null>(allowMove ? null : 'units');
  const [wholeGroup, setWholeGroup] = useState(false);
  const [moved, setMoved] = useState<MoveResult | null>(null);

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

  // Pasar el producto: solo desde su tienda dueña (no al devolver).
  const canMove = !!allowMove && !flipped && fromIsOwner;
  const moving = canMove && mode === 'move';
  const showUnits = !canMove || mode === 'units';
  const multiVariant = !!groupInfo && groupInfo.variants > 1;
  const movesGroup = !!groupInfo && (!multiVariant || wholeGroup);
  // Un negativo en la tienda dueña es un conteo por revisar: el SQL no lo
  // muda (OWNER_STOCK_NEGATIVE). Acá se avisa antes de que lo intenten.
  const moveBlocked = !loading && fromStock < 0;
  const canConfirmMove = !loading && !submitting && !moveBlocked;

  const chooseMode = (m: 'units' | 'move') => {
    setMode(m);
    setError(null);
  };

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

  const handleMove = async () => {
    if (!canConfirmMove) return;
    setSubmitting(true);
    setError(null);
    moveRequestId.current ??= newRequestId();
    const { result, error: rpcError } = await moveProductToStore(supabase, {
      productId: product.id,
      toStoreId: toId,
      wholeGroup: movesGroup,
      note,
      requestId: moveRequestId.current,
    });
    setSubmitting(false);

    if (!result) {
      setError(rpcError ?? 'No se pudo pasar el producto a la otra tienda.');
      const map = await stockByStore(supabase, product.id);
      if (map) setStocks(map);
      return;
    }

    onMoved?.(result);
    setMoved(result);
  };

  const heading = title ?? 'Transferir producto';
  const unitsWord = (n: number) => (n === 1 ? '1 unidad' : `${n} unidades`);

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
          {moved ? (
            <>
              <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg px-4 py-3 text-sm font-medium space-y-1">
                <p>
                  {moved.group_moved && moved.group_name
                    ? <>El modelo <strong>{moved.group_name}</strong> ({moved.product_ids.length === 1 ? '1 variante' : `${moved.product_ids.length} variantes`})</>
                    : <strong>{product.name}</strong>}{' '}
                  ahora es de {storeName(moved.to_store_id)}.
                </p>
                <p className="font-normal">
                  {moved.units === 0
                    ? `No había unidades en ${storeName(moved.from_store_id)}: no se movió ninguna.`
                    : `Pasaron ${unitsWord(moved.units)} de ${storeName(moved.from_store_id)}.`}
                  {moved.detached && moved.group_name && ` Salió del modelo «${moved.group_name}».`}
                </p>
              </div>
              {!moved.group_moved && (
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="border border-slate-200 rounded-lg px-3 py-2">
                    <p className="text-slate-500">{storeName(moved.from_store_id)}</p>
                    <p className="text-xl font-bold text-slate-800">{moved.from_stock}</p>
                  </div>
                  <div className="border border-slate-200 rounded-lg px-3 py-2">
                    <p className="text-slate-500">{storeName(moved.to_store_id)}</p>
                    <p className="text-xl font-bold text-slate-800">{moved.to_stock}</p>
                  </div>
                </div>
              )}
              <p className="text-sm text-slate-600">
                Ya no aparece en el inventario de {storeName(moved.from_store_id)}: está en el de {storeName(moved.to_store_id)}.
              </p>
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
          ) : done ? (
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

              {canMove && (
                <div className="space-y-2" role="radiogroup" aria-label="¿Qué quieres hacer?">
                  <p className="text-sm font-semibold text-slate-700">¿Qué quieres hacer?</p>
                  {([
                    {
                      value: 'units' as const,
                      label: 'Mover unidades',
                      help: `Siguen siendo de ${storeName(fromId)}. Para vender o exhibir allá un tiempo: no aparecen en el inventario de ${storeName(toId)}.`,
                    },
                    {
                      value: 'move' as const,
                      label: `Pasar el producto a ${storeName(toId)}`,
                      help: `Deja de ser de ${storeName(fromId)}: sale de este inventario y aparece en el de ${storeName(toId)} con todas sus unidades.`,
                    },
                  ]).map(opt => (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      aria-checked={mode === opt.value}
                      onClick={() => chooseMode(opt.value)}
                      disabled={submitting}
                      className={`w-full text-left rounded-lg border px-3 py-2.5 transition cursor-pointer disabled:opacity-60 ${mode === opt.value ? 'border-teal-500 bg-teal-50 ring-1 ring-teal-500' : 'border-slate-200 hover:border-teal-300 hover:bg-slate-50'}`}
                    >
                      <span className="block font-semibold text-slate-800">{opt.label}</span>
                      <span className="block text-sm text-slate-500 leading-snug">{opt.help}</span>
                    </button>
                  ))}
                </div>
              )}

              {moving && (
                <>
                  {/* Con el modelo entero estos números serían solo de una talla. */}
                  {!(multiVariant && wholeGroup) && (
                  <div className="flex items-stretch gap-2 text-sm">
                    <div className="flex-1 border border-slate-200 rounded-lg px-3 py-2">
                      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Sale de</p>
                      <p className="font-semibold text-slate-800">{storeName(fromId)}</p>
                      <p className="text-slate-500">{loading ? 'Consultando…' : `Hay ${fromStock} · queda 0`}</p>
                    </div>
                    <div className="flex items-center text-slate-400 text-xl" aria-hidden="true">→</div>
                    <div className="flex-1 border border-slate-200 rounded-lg px-3 py-2">
                      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Pasa a</p>
                      <p className="font-semibold text-slate-800">{storeName(toId)}</p>
                      <p className="text-slate-500">
                        {loading ? 'Consultando…' : `Hay ${toStock} · queda ${toStock + Math.max(0, fromStock)}`}
                      </p>
                    </div>
                  </div>
                  )}

                  {groupInfo && (multiVariant ? (
                    <div className="space-y-2" role="radiogroup" aria-label="Variantes">
                      <p className="text-sm text-slate-600">
                        Es una variante del modelo <strong>{groupInfo.name}</strong> ({groupInfo.variants} variantes).
                      </p>
                      {([
                        {
                          whole: false,
                          label: 'Solo esta variante',
                          help: `Sale del modelo y llega a ${storeName(toId)} como producto suelto. ${groupInfo.variants === 2 ? 'La otra sigue' : `Las otras ${groupInfo.variants - 1} siguen`} en ${storeName(fromId)}.`,
                        },
                        {
                          whole: true,
                          label: 'Todo el modelo',
                          help: `Las ${groupInfo.variants} variantes, cada una con todas sus unidades.`,
                        },
                      ]).map(opt => (
                        <label
                          key={String(opt.whole)}
                          className={`flex items-start gap-2 rounded-lg border px-3 py-2 cursor-pointer transition ${wholeGroup === opt.whole ? 'border-teal-500 bg-teal-50' : 'border-slate-200 hover:bg-slate-50'}`}
                        >
                          <input
                            type="radio"
                            name="move-whole-group"
                            checked={wholeGroup === opt.whole}
                            onChange={() => { setWholeGroup(opt.whole); setError(null); }}
                            disabled={submitting}
                            className="mt-1 w-4 h-4 accent-teal-600 shrink-0"
                          />
                          <span>
                            <span className="block font-medium text-slate-800">{opt.label}</span>
                            <span className="block text-sm text-slate-500 leading-snug">{opt.help}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-slate-600">
                      Es la única variante del modelo <strong>{groupInfo.name}</strong>: el modelo pasa con ella.
                    </p>
                  ))}

                  {moveBlocked && (
                    <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm font-medium">
                      {storeName(fromId)} tiene este producto en <strong>{fromStock}</strong>. Corrige el conteo
                      antes de pasarlo a {storeName(toId)}.
                    </div>
                  )}
                </>
              )}

              {showUnits && (
                <>
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
                </>
              )}

              {showNote && (moving || showUnits) && (
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
                {moving ? (
                  <button
                    type="button"
                    onClick={() => void handleMove()}
                    disabled={!canConfirmMove}
                    className="px-4 py-2.5 bg-[#0f5c5c] text-white rounded-lg font-bold hover:bg-[#0a4545] transition cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {submitting ? 'Pasando…' : movesGroup ? 'Pasar el modelo' : 'Pasar el producto'}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleConfirm()}
                    disabled={!showUnits || !canConfirm}
                    className="px-4 py-2.5 bg-[#0f5c5c] text-white rounded-lg font-bold hover:bg-[#0a4545] transition cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {submitting ? 'Transfiriendo…' : (confirmLabel ?? 'Transferir')}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
