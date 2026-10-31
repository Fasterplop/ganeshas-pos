'use client';

// Enviar piezas a la otra tienda (pasos 2 y 3 de la propuesta v2).
//
// La cajera pistolea sin parar; cada pieza se agrupa en su modelo y la columna
// «En <tienda> llega a…» dice a qué producto padre llega:
//   ↩ vuelve      la pieza es de la otra tienda: vuelve a su producto
//   ✓ mismo       la otra tienda tiene un modelo con el mismo nombre
//   🔗 enlazado   ya se eligió una vez (enlace guardado)
//   ≈ parecido    nombre parecido: un toque para confirmar (Sí / Otro)
//   ＋ no lo tiene llega con su padre de origen, no suelta (o «Enlazar»)
// Dentro de un modelo de la otra tienda, cada pieza se suma a su variante
// (misma talla y color) o crea una variante nueva.
//
// Todo lo que se muestra es una PROPUESTA: el RPC send_shipment vuelve a
// decidir con las mismas reglas y valida que lo elegido sea de la otra tienda
// (db/traslados_01.sql). Por eso lo que se manda es solo la decisión: el
// modelo o el producto elegido, o «que llegue con su padre».
//
// El envío en curso se guarda en este navegador a cada cambio («Seguir
// después»): si se cierra la pestaña o se va a otra pantalla, al volver sigue
// ahí.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Minus, Plus, X } from 'lucide-react';
import type { SupabaseClient } from '@supabase/supabase-js';
import CameraScanner, { ScanButton } from '@/components/CameraScanner';
import Modal from '@/components/Modal';
import ElegirModelo, { type ModeloPick } from '@/components/traslados/ElegirModelo';
import { formatVariant } from '@/lib/productVariant';
import { localStockOf } from '@/lib/transfers';
import {
  clearDraft,
  fetchStoreCatalog,
  fetchTwins,
  groupPrice,
  loadDraft,
  nameKey,
  normText,
  notifyTrasladosChanged,
  resolveScan,
  saveDraft,
  sendShipment,
  sizesOf,
  suggestGroup,
  variantInGroup,
  type DestGroup,
  type DestProduct,
  type ModelChoice,
  type ScanProduct,
  type SendLine,
  type TwinMaps,
} from '@/lib/traslados';

interface StoreLite {
  id: string;
  name: string;
}

interface Line {
  /** product_id, o product_id|talla en los códigos con varias tallas. */
  key: string;
  product: ScanProduct;
  /** Talla anotada (códigos de Juguetes con varias tallas en un campo). */
  size: string | null;
  qty: number;
  /** Unidades en la tienda que envía al momento de pistolear (null = no se pudo leer). */
  stock: number | null;
}

type Plan =
  | { kind: 'vuelve' }
  | { kind: 'grupo'; group: DestGroup; how: 'mismo' | 'parecido' | 'elegido' | 'enlazado'; confirmed: boolean; fromChoice: boolean }
  | { kind: 'producto'; product: DestProduct; how: 'mismo' | 'elegido' | 'enlazado' }
  | { kind: 'origen'; chosen: boolean };

type LineTarget =
  | { kind: 'vuelve' }
  | { kind: 'existe'; product: DestProduct; how: 'variante' | 'enlazado' | 'elegido' }
  | { kind: 'nueva'; price: number }
  | { kind: 'producto'; product: DestProduct }
  | { kind: 'origen' };

interface Model {
  key: string;
  name: string;
  groupId: string | null;
  lines: Line[];
  pieces: number;
  plan: Plan | null; // null mientras carga el catálogo
}

const lineKey = (productId: string, size: string | null) => (size ? `${productId}|${size}` : productId);
const modelKeyOf = (p: ScanProduct) => p.parent_group_id ?? `p:${p.id}`;
const short = (name: string) => name.replace(/^tienda de /i, '') || name;
const money = (n: number) => `$${n.toFixed(2)}`;
const PRODUCT_COLS = 'id, sku_barcode, name, talla, color, price, owner_store_id, parent_group_id, is_active';

let errSeq = 0;

export default function EnviarTraslado({
  supabase,
  userId,
  fromStore,
  toStore,
  onExit,
}: {
  supabase: SupabaseClient;
  userId: string;
  fromStore: StoreLite;
  toStore: StoreLite;
  /** Volver al inicio de Traslados (sent = se acaba de enviar algo). */
  onExit: (sent: boolean) => void;
}) {
  const [catalog, setCatalog] = useState<{ groups: DestGroup[]; products: DestProduct[] } | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [groupNames, setGroupNames] = useState<Record<string, string>>({});
  const [twins, setTwins] = useState<TwinMaps>({ products: new Map(), groups: new Map() });
  const [choices, setChoices] = useState<Record<string, ModelChoice>>({});
  const [variantChoices, setVariantChoices] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [scanErrors, setScanErrors] = useState<{ id: number; text: string }[]>([]);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [sizePrompt, setSizePrompt] = useState<{ product: ScanProduct; stock: number | null } | null>(null);
  const [picker, setPicker] = useState<Model | null>(null);
  const [variantPicker, setVariantPicker] = useState<{ line: Line; group: DestGroup } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [restoredNote, setRestoredNote] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ pieces: number; at: Date } | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  // Lo pistoleado, para la cámara (que llama a handleCode desde su propio bucle).
  const linesRef = useRef<Line[]>([]);
  useEffect(() => {
    linesRef.current = lines;
  }, [lines]);
  const restoredRef = useRef(false);
  // Un id por envío: un doble toque o un reintento no envía dos veces.
  const [requestId] = useState(() => crypto.randomUUID());

  const toShort = short(toStore.name);
  const fromShort = short(fromStore.name);

  // --- Contexto de cada pieza: grupo de origen y enlaces guardados ----------
  const loadContext = useCallback(
    async (products: ScanProduct[]) => {
      const gids = [...new Set(products.map((p) => p.parent_group_id).filter((g): g is string => !!g))];
      const [twinMaps, groupsRes] = await Promise.all([
        fetchTwins(supabase, products.map((p) => p.id), gids, toStore.id),
        gids.length
          ? supabase.from('product_groups').select('id, name').in('id', gids)
          : Promise.resolve({ data: [] as { id: string; name: string }[] }),
      ]);
      setTwins((prev) => ({
        products: new Map([...prev.products, ...twinMaps.products]),
        groups: new Map([...prev.groups, ...twinMaps.groups]),
      }));
      const names: Record<string, string> = {};
      for (const g of (groupsRes.data ?? []) as { id: string; name: string }[]) names[g.id] = g.name;
      setGroupNames((prev) => ({ ...prev, ...names }));
    },
    [supabase, toStore.id],
  );

  // --- Al abrir: catálogo de la otra tienda y el borrador, si hay ------------
  useEffect(() => {
    let cancelled = false;
    fetchStoreCatalog(supabase, toStore.id).then((res) => {
      if (cancelled) return;
      if (res.error) setCatalogError(res.error);
      setCatalog({ groups: res.groups, products: res.products });
    });

    (async () => {
      const draft = loadDraft(userId, fromStore.id);
      if (!draft || draft.toStoreId !== toStore.id || draft.lines.length === 0) {
        if (draft?.note) setNote(draft.note);
        restoredRef.current = true;
        return;
      }
      const ids = [...new Set(draft.lines.map((l) => l.product_id))];
      const [{ data: prods }, { data: stocks }] = await Promise.all([
        supabase.from('products').select(PRODUCT_COLS).in('id', ids),
        supabase.from('store_stock').select('product_id, stock').eq('store_id', fromStore.id).in('product_id', ids),
      ]);
      if (cancelled) return;
      const byId = new Map(((prods ?? []) as (ScanProduct & { is_active: boolean })[]).filter((p) => p.is_active).map((p) => [p.id, p]));
      const stockBy = new Map(((stocks ?? []) as { product_id: string; stock: number }[]).map((s) => [s.product_id, Number(s.stock) || 0]));
      const restored: Line[] = [];
      for (const l of draft.lines) {
        const p = byId.get(l.product_id);
        if (!p) continue;
        restored.push({ key: lineKey(p.id, l.size), product: { ...p, price: Number(p.price) || 0 }, size: l.size, qty: l.qty, stock: stockBy.get(p.id) ?? 0 });
      }
      setLines(restored);
      setChoices(draft.choices ?? {});
      setVariantChoices(draft.variantChoices ?? {});
      setNote(draft.note ?? '');
      const pieces = restored.reduce((a, l) => a + l.qty, 0);
      if (pieces > 0) setRestoredNote(`Se recuperó el envío que dejaste para después (${pieces} ${pieces === 1 ? 'pieza' : 'piezas'}).`);
      await loadContext(restored.map((l) => l.product));
      restoredRef.current = true;
    })();

    return () => {
      cancelled = true;
    };
  }, [supabase, userId, fromStore.id, toStore.id, loadContext]);

  // --- Borrador: se guarda a cada cambio --------------------------------------
  useEffect(() => {
    if (!restoredRef.current || sent) return;
    saveDraft(userId, fromStore.id, {
      toStoreId: toStore.id,
      note,
      lines: lines.map((l) => ({ product_id: l.product.id, qty: l.qty, size: l.size })),
      choices,
      variantChoices,
      savedAt: new Date().toISOString(),
    });
  }, [lines, choices, variantChoices, note, userId, fromStore.id, toStore.id, sent]);

  // --- Pistolear --------------------------------------------------------------
  const addError = useCallback((text: string) => setScanErrors((prev) => [{ id: ++errSeq, text }, ...prev].slice(0, 8)), []);

  const addUnit = useCallback((product: ScanProduct, size: string | null, stock: number | null) => {
    const key = lineKey(product.id, size);
    setLines((prev) => {
      const i = prev.findIndex((l) => l.key === key);
      if (i >= 0) return prev.map((l, j) => (j === i ? { ...l, qty: Math.min(999, l.qty + 1) } : l));
      return [...prev, { key, product, size, qty: 1, stock }];
    });
  }, []);

  const handleCode = useCallback(
    async (raw: string): Promise<string> => {
      const scanned = raw.trim();
      if (!scanned) return '';
      // Repetida: suma 1 sin ir a la base (salvo códigos con varias tallas, que preguntan).
      const known = linesRef.current.find((l) => l.product.sku_barcode === scanned && !l.size);
      if (known) {
        addUnit(known.product, null, known.stock);
        return `✓ ${known.product.name} ×${known.qty + 1}`;
      }

      const r = await resolveScan(supabase, scanned, fromStore.id);
      if (r.kind === 'not_found') {
        addError(`${scanned} · Ese código no existe`);
        return `✗ ${scanned}: no existe`;
      }
      if (r.kind === 'not_here') {
        addError(`${scanned} · ${r.product.name}: no está en ${fromStore.name}, no se envía`);
        return `✗ ${r.product.name}: no está en ${fromShort}`;
      }
      const p = r.product;
      const already = linesRef.current.find((l) => l.product.id === p.id);
      const stock = already ? already.stock : await localStockOf(supabase, p.id, fromStore.id);
      if (!already) void loadContext([p]);

      if (sizesOf(p.talla).length > 0) {
        setCameraOpen(false);
        setSizePrompt({ product: p, stock });
        return `Elige la talla de ${p.name}`;
      }
      addUnit(p, null, stock);
      return `✓ ${p.name}${r.viaTwin ? ' (su producto aquí)' : ''}`;
    },
    [supabase, fromStore.id, fromStore.name, fromShort, addUnit, addError, loadContext],
  );

  const submitCode = async () => {
    const c = code;
    setCode('');
    setBusy(true);
    await handleCode(c);
    setBusy(false);
    setTimeout(() => inputRef.current?.focus(), 10);
  };

  const setQty = (key: string, qty: number) =>
    setLines((prev) => (qty <= 0 ? prev.filter((l) => l.key !== key) : prev.map((l) => (l.key === key ? { ...l, qty: Math.min(999, qty) } : l))));

  // --- A qué llega cada modelo ------------------------------------------------
  const models = useMemo<Model[]>(() => {
    const map = new Map<string, Model>();
    for (const l of lines) {
      const key = modelKeyOf(l.product);
      let m = map.get(key);
      if (!m) {
        const name = (l.product.parent_group_id ? (groupNames[l.product.parent_group_id] ?? l.product.name) : l.product.name).trim();
        m = { key, name, groupId: l.product.parent_group_id, lines: [], pieces: 0, plan: null };
        map.set(key, m);
      }
      m.lines.push(l);
      m.pieces += l.qty;
    }
    if (!catalog) return [...map.values()];

    const groupById = new Map(catalog.groups.map((g) => [g.id, g]));
    const productById = new Map(catalog.products.map((p) => [p.id, p]));
    for (const m of map.values()) {
      if (m.lines.every((l) => l.product.owner_store_id === toStore.id)) {
        m.plan = { kind: 'vuelve' };
        continue;
      }
      const choice = choices[m.key];
      if (choice?.kind === 'group' && groupById.has(choice.groupId)) {
        m.plan = { kind: 'grupo', group: groupById.get(choice.groupId)!, how: choice.match, confirmed: true, fromChoice: true };
        continue;
      }
      if (choice?.kind === 'product' && productById.has(choice.productId)) {
        m.plan = { kind: 'producto', product: productById.get(choice.productId)!, how: 'elegido' };
        continue;
      }
      if (choice?.kind === 'origen') {
        m.plan = { kind: 'origen', chosen: true };
        continue;
      }
      // Enlace guardado: del modelo, o del producto suelto.
      const gLink = m.groupId ? twins.groups.get(m.groupId) : undefined;
      if (gLink && groupById.has(gLink)) {
        m.plan = { kind: 'grupo', group: groupById.get(gLink)!, how: 'enlazado', confirmed: true, fromChoice: false };
        continue;
      }
      const pLink = !m.groupId ? twins.products.get(m.lines[0].product.id) : undefined;
      if (pLink && productById.has(pLink)) {
        m.plan = { kind: 'producto', product: productById.get(pLink)!, how: 'enlazado' };
        continue;
      }
      // Propuesta por el nombre.
      const sug = suggestGroup(m.name, catalog.groups);
      if (sug.group) {
        m.plan = { kind: 'grupo', group: sug.group, how: sug.kind === 'mismo' ? 'mismo' : 'parecido', confirmed: sug.kind === 'mismo', fromChoice: false };
        continue;
      }
      if (!m.groupId) {
        // Suelto: otro suelto con el mismo nombre, talla y color.
        const p0 = m.lines[0].product;
        const same = catalog.products.find(
          (d) => !d.parent_group_id && nameKey(d.name) === nameKey(p0.name) && normText(d.talla) === normText(p0.talla) && normText(d.color) === normText(p0.color),
        );
        if (same) {
          m.plan = { kind: 'producto', product: same, how: 'mismo' };
          continue;
        }
      }
      m.plan = { kind: 'origen', chosen: false };
    }
    return [...map.values()];
  }, [lines, groupNames, catalog, choices, twins, toStore.id]);

  const targetOf = useCallback(
    (line: Line, plan: Plan | null): LineTarget | null => {
      if (!plan || !catalog) return null;
      if (line.product.owner_store_id === toStore.id || plan.kind === 'vuelve') return { kind: 'vuelve' };
      if (plan.kind === 'origen') return { kind: 'origen' };
      if (plan.kind === 'producto') return { kind: 'producto', product: plan.product };
      const override = variantChoices[line.key];
      const chosen = override ? catalog.products.find((p) => p.id === override) : undefined;
      if (chosen) return { kind: 'existe', product: chosen, how: 'elegido' };
      if (plan.how === 'enlazado' && !plan.fromChoice && !line.size) {
        const linkId = twins.products.get(line.product.id);
        const linked = linkId ? catalog.products.find((p) => p.id === linkId) : undefined;
        if (linked) return { kind: 'existe', product: linked, how: 'enlazado' };
      }
      const v = variantInGroup(plan.group.id, line.size ?? line.product.talla, line.product.color, catalog.products);
      if (v) return { kind: 'existe', product: v, how: 'variante' };
      return { kind: 'nueva', price: groupPrice(plan.group, catalog.products) };
    },
    [catalog, toStore.id, variantChoices, twins],
  );

  /** Lo que se manda al RPC por cada línea (ver la cabecera del archivo). */
  const sendLineOf = (line: Line, plan: Plan): SendLine => {
    const base: SendLine = { product_id: line.product.id, qty: line.qty, size: line.size };
    if (line.product.owner_store_id === toStore.id || plan.kind === 'vuelve') return base;
    if (plan.kind === 'origen') return { ...base, origin: true };
    if (plan.kind === 'producto') {
      if (plan.how === 'enlazado' && !line.size) return base;
      return { ...base, target_product_id: plan.product.id, match: plan.how === 'mismo' ? 'mismo' : 'elegido' };
    }
    const override = variantChoices[line.key];
    if (override) return { ...base, target_product_id: override, match: 'elegido' };
    if (plan.how === 'enlazado' && !plan.fromChoice) return base;
    return { ...base, target_group_id: plan.group.id, match: plan.how === 'enlazado' ? 'elegido' : plan.how };
  };

  // --- Avisos y bloqueos ------------------------------------------------------
  const pieces = lines.reduce((a, l) => a + l.qty, 0);
  const lineIssue = (l: Line): { level: 'error' | 'warn'; text: string } | null => {
    if (l.stock === null) return null;
    if (l.qty <= l.stock) return null;
    if (l.product.owner_store_id !== fromStore.id) {
      return { level: 'error', text: `Solo hay ${l.stock} en ${fromShort}: es de la otra tienda, no se puede enviar más` };
    }
    return { level: 'warn', text: `El sistema tenía ${l.stock}, revisar` };
  };
  const blockers: string[] = [];
  if (!catalog) blockers.push(`Cargando los productos de ${toStore.name}…`);
  for (const m of models) {
    if (m.plan?.kind === 'grupo' && !m.plan.confirmed) blockers.push(`Confirma a qué producto llega «${m.name}» (≈).`);
  }
  if (lines.some((l) => lineIssue(l)?.level === 'error')) blockers.push('Hay piezas sin unidades en esta tienda (en rojo).');
  if (lines.length > 0 && !note.trim()) blockers.push('Escribe el motivo del envío.');
  const warnCount = lines.filter((l) => lineIssue(l)?.level === 'warn').length + scanErrors.length;
  const canSend = lines.length > 0 && blockers.length === 0;

  // --- Decisiones -------------------------------------------------------------
  const choose = (m: Model, c: ModelChoice | null) => {
    setChoices((prev) => {
      const next = { ...prev };
      if (c) next[m.key] = c;
      else delete next[m.key];
      return next;
    });
    // Al cambiar de modelo, las variantes elegidas a mano ya no aplican.
    setVariantChoices((prev) => {
      const next = { ...prev };
      for (const l of m.lines) delete next[l.key];
      return next;
    });
  };

  const onPickModel = (pick: ModeloPick) => {
    if (!picker) return;
    if (pick.kind === 'group') choose(picker, { kind: 'group', groupId: pick.group.id, match: 'elegido' });
    else if (pick.kind === 'product') choose(picker, { kind: 'product', productId: pick.product.id });
    else choose(picker, { kind: 'origen' });
    setPicker(null);
  };

  // --- Enviar -----------------------------------------------------------------
  const doSend = async () => {
    setSending(true);
    setSendError(null);
    const payload: SendLine[] = [];
    for (const m of models) for (const l of m.lines) if (m.plan) payload.push(sendLineOf(l, m.plan));
    const res = await sendShipment(supabase, {
      fromStoreId: fromStore.id,
      toStoreId: toStore.id,
      note,
      lines: payload,
      requestId,
    });
    setSending(false);
    if (res.error) {
      setSendError(res.error);
      return;
    }
    clearDraft(userId, fromStore.id);
    notifyTrasladosChanged();
    setConfirmOpen(false);
    setSent({ pieces: res.pieces || pieces, at: new Date() });
  };

  // --- Pantalla de enviado ------------------------------------------------------
  if (sent) {
    return (
      <div className="max-w-xl mx-auto bg-white rounded-2xl border border-slate-200 shadow-sm p-6 sm:p-8 text-center space-y-5">
        <div className="mx-auto w-16 h-16 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center text-3xl font-bold">✓</div>
        <div>
          <h2 className="text-2xl font-bold text-slate-800">Enviado a {toStore.name}</h2>
          <p className="text-slate-500 mt-1">
            {sent.pieces} {sent.pieces === 1 ? 'pieza' : 'piezas'} ·{' '}
            {sent.at.toLocaleTimeString('es-VE', { hour: 'numeric', minute: '2-digit', hour12: true })}
          </p>
        </div>
        <ul className="text-left text-sm space-y-2 bg-slate-50 rounded-xl p-4">
          <li className="text-emerald-700">✓ Ya salieron del inventario de {fromShort}.</li>
          <li className="text-emerald-700">✓ Ya están en {toShort}, cada una en su producto.</li>
          <li className="text-amber-700">⏳ {toShort} confirma que llegaron.</li>
        </ul>
        <button
          onClick={() => onExit(true)}
          className="w-full bg-[#0f5c5c] hover:bg-teal-800 text-white font-bold py-3 rounded-xl cursor-pointer"
        >
          Listo
        </button>
      </div>
    );
  }

  // --- Pantalla de envío --------------------------------------------------------
  return (
    <div className="max-w-5xl mx-auto space-y-4">
      {/* Cabecera: de dónde a dónde, el destino en grande y fijo. */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-6">
        <div className="flex-1 min-w-0">
          <p className="text-xs uppercase tracking-widest text-slate-400 font-bold">Enviar piezas</p>
          <p className="text-sm text-slate-600 mt-1">
            De <span className="font-semibold text-slate-800">{fromStore.name}</span> → a
          </p>
          <p className="text-2xl sm:text-3xl font-extrabold text-[#0f5c5c] uppercase tracking-wide leading-tight">{toStore.name}</p>
          <p className="text-xs text-slate-400">fijo: no se cambia</p>
        </div>
        <button onClick={() => onExit(false)} className="self-start sm:self-center text-sm text-slate-500 hover:text-slate-800 cursor-pointer">
          ← Volver a Traslados
        </button>
      </div>

      {restoredNote && (
        <div className="bg-teal-50 border border-teal-200 text-teal-800 rounded-lg px-4 py-2.5 text-sm flex items-start gap-3">
          <span className="flex-1">{restoredNote}</span>
          <button onClick={() => setRestoredNote(null)} className="opacity-60 hover:opacity-100 cursor-pointer">✕</button>
        </div>
      )}
      {catalogError && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-2.5 text-sm">
          No se pudieron leer los productos de {toStore.name}: {catalogError}
        </div>
      )}

      {/* Pistola */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-3 sm:p-4 flex items-center gap-2">
        <input
          ref={inputRef}
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submitCode();
            }
          }}
          placeholder="Pistolee la siguiente pieza…"
          className="flex-1 min-w-0 border-2 border-teal-600 rounded-xl px-4 py-3 text-base font-medium focus:outline-none focus:ring-4 focus:ring-teal-500/20"
        />
        <ScanButton onClick={() => setCameraOpen(true)} className="lg:hidden py-3" label="Cámara" />
        <span className="hidden sm:inline text-xs text-emerald-600 font-semibold whitespace-nowrap">
          {busy ? 'Buscando…' : '● Pistola lista'}
        </span>
      </div>

      {/* Lo pistoleado que no se puede enviar */}
      {scanErrors.length > 0 && (
        <ul className="space-y-1.5">
          {scanErrors.map((e) => (
            <li key={e.id} className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-sm flex items-center gap-3">
              <span className="flex-1">✗ {e.text}</span>
              <button
                onClick={() => setScanErrors((prev) => prev.filter((x) => x.id !== e.id))}
                className="text-xs font-semibold text-red-700 hover:underline cursor-pointer"
              >
                Quitar
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Piezas, por modelo */}
      {lines.length === 0 ? (
        <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-10 text-center text-slate-500">
          Pistolee las piezas que van a {toStore.name}. Cada una dirá a qué producto llega.
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="hidden md:grid grid-cols-[1fr_8rem_7.5rem_1.2fr] gap-3 px-4 py-2.5 bg-slate-100 text-[11px] uppercase tracking-wide font-semibold text-slate-600">
            <span>Producto · talla y color</span>
            <span>Código</span>
            <span className="text-center">Cant.</span>
            <span>En {toShort} llega a…</span>
          </div>
          <ul className="divide-y divide-slate-100">
            {models.map((m) => {
              const open = !collapsed.has(m.key);
              return (
                <li key={m.key}>
                  {/* Fila del modelo */}
                  <div className="px-3 sm:px-4 py-2.5 bg-slate-50 flex flex-col md:grid md:grid-cols-[1fr_8rem_7.5rem_1.2fr] gap-1.5 md:gap-3 md:items-center">
                    <button
                      onClick={() =>
                        setCollapsed((prev) => {
                          const next = new Set(prev);
                          if (next.has(m.key)) next.delete(m.key);
                          else next.add(m.key);
                          return next;
                        })
                      }
                      className="flex items-center gap-1.5 text-left font-bold text-slate-800 cursor-pointer md:col-span-3"
                    >
                      {open ? <ChevronDown size={16} className="text-slate-500" /> : <ChevronRight size={16} className="text-slate-500" />}
                      {m.name}
                      <span className="font-normal text-slate-500 text-sm">
                        · {m.pieces} {m.pieces === 1 ? 'pieza' : 'piezas'}
                      </span>
                    </button>
                    <ModelBadge
                      model={m}
                      toShort={toShort}
                      fromShort={fromShort}
                      onPick={() => setPicker(m)}
                      onConfirm={() => {
                        if (m.plan?.kind === 'grupo') choose(m, { kind: 'group', groupId: m.plan.group.id, match: 'parecido' });
                      }}
                    />
                  </div>

                  {/* Piezas del modelo */}
                  {open && (
                    <ul className="divide-y divide-slate-50">
                      {m.lines.map((l) => {
                        const t = targetOf(l, m.plan);
                        const issue = lineIssue(l);
                        const variant = formatVariant(l.size ?? l.product.talla, l.product.color);
                        const destPrice = t?.kind === 'existe' || t?.kind === 'producto' ? Number(t.product.price) : t?.kind === 'nueva' ? t.price : null;
                        const priceDiffers = destPrice !== null && Math.abs(destPrice - l.product.price) >= 0.01;
                        return (
                          <li key={l.key} className="px-3 sm:px-4 py-2.5 flex flex-col md:grid md:grid-cols-[1fr_8rem_7.5rem_1.2fr] gap-1.5 md:gap-3 md:items-center">
                            <div className="pl-5 min-w-0">
                              <p className="text-slate-800">
                                {variant || <span className="text-slate-400">Sin talla ni color</span>}
                                {l.size && <span className="ml-1.5 text-[11px] font-bold bg-indigo-50 text-indigo-700 px-1.5 py-0.5 rounded">talla anotada</span>}
                              </p>
                              {issue && (
                                <p className={`text-xs font-semibold ${issue.level === 'error' ? 'text-red-600' : 'text-amber-600'}`}>{issue.text}</p>
                              )}
                            </div>
                            <span className="pl-5 md:pl-0 font-mono text-xs text-slate-500">{l.product.sku_barcode}</span>
                            <div className="pl-5 md:pl-0 flex items-center md:justify-center gap-1.5">
                              <button onClick={() => setQty(l.key, l.qty - 1)} className="w-8 h-8 rounded-lg border border-slate-300 flex items-center justify-center hover:bg-slate-50 cursor-pointer" aria-label="Quitar una">
                                {l.qty === 1 ? <X size={14} /> : <Minus size={14} />}
                              </button>
                              <span className="w-8 text-center font-bold text-slate-800">{l.qty}</span>
                              <button onClick={() => setQty(l.key, l.qty + 1)} className="w-8 h-8 rounded-lg border border-slate-300 flex items-center justify-center hover:bg-slate-50 cursor-pointer" aria-label="Sumar una">
                                <Plus size={14} />
                              </button>
                            </div>
                            <div className="pl-5 md:pl-0 text-sm">
                              <LineTargetText
                                target={t}
                                plan={m.plan}
                                toShort={toShort}
                                fromShort={fromShort}
                                loose={!m.groupId}
                                onChooseVariant={m.plan?.kind === 'grupo' ? () => setVariantPicker({ line: l, group: (m.plan as Extract<Plan, { kind: 'grupo' }>).group }) : undefined}
                              />
                              {priceDiffers && destPrice !== null && (
                                <p className="text-xs text-amber-700">Allá se vende a {money(destPrice)} (aquí {money(l.product.price)})</p>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="px-4 py-2.5 bg-slate-50 border-t border-slate-200 text-sm text-slate-600">
            <span className="font-bold text-slate-800">
              {pieces} {pieces === 1 ? 'pieza' : 'piezas'}
            </span>{' '}
            · {models.length} {models.length === 1 ? 'modelo' : 'modelos'}
            {warnCount > 0 && (
              <>
                {' '}· <span className="text-amber-700 font-semibold">{warnCount} {warnCount === 1 ? 'aviso' : 'avisos'}</span>
              </>
            )}
          </div>
        </div>
      )}

      {/* Motivo y botones */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 space-y-3">
        <label className="block">
          <span className="text-sm font-semibold text-slate-700">
            Motivo <span className="text-red-500">*</span> <span className="font-normal text-slate-400">(uno para todo el envío)</span>
          </span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={`Ej.: A ${toShort} se le acabó`}
            className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/40"
          />
        </label>
        {lines.length > 0 && blockers.length > 0 && (
          <ul className="text-xs text-amber-700 space-y-0.5">
            {blockers.map((b) => (
              <li key={b}>• {b}</li>
            ))}
          </ul>
        )}
        <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
          {lines.length > 0 && (
            <button
              onClick={() => {
                setLines([]);
                setChoices({});
                setVariantChoices({});
                setNote('');
                setScanErrors([]);
                clearDraft(userId, fromStore.id);
              }}
              className="px-4 py-2.5 text-sm font-semibold text-red-600 hover:bg-red-50 rounded-lg cursor-pointer"
            >
              Descartar todo
            </button>
          )}
          <button
            onClick={() => onExit(false)}
            className="px-4 py-2.5 text-sm font-semibold text-slate-700 border border-slate-300 hover:bg-slate-50 rounded-lg cursor-pointer"
          >
            Seguir después
          </button>
          <button
            onClick={() => {
              setSendError(null);
              setConfirmOpen(true);
            }}
            disabled={!canSend}
            className="px-5 py-2.5 text-sm font-bold text-white bg-[#0f5c5c] hover:bg-teal-800 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            Enviar {pieces} {pieces === 1 ? 'pieza' : 'piezas'} →
          </button>
        </div>
      </div>

      {/* Cámara en modo continuo */}
      <CameraScanner isOpen={cameraOpen} onClose={() => setCameraOpen(false)} onScan={handleCode} continuous title={`Enviar a ${toShort}`} />

      {/* Código con varias tallas: ¿cuál va? */}
      <Modal isOpen={!!sizePrompt} onClose={() => setSizePrompt(null)} title="¿Qué talla va?">
        {sizePrompt && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              <span className="font-semibold text-slate-800">{sizePrompt.product.name}</span>{' '}
              <span className="font-mono text-xs">{sizePrompt.product.sku_barcode}</span> trae varias tallas en un solo código. Toca la talla de esta pieza.
            </p>
            <div className="flex flex-wrap gap-2">
              {sizesOf(sizePrompt.product.talla).map((s) => (
                <button
                  key={s}
                  onClick={() => {
                    addUnit(sizePrompt.product, s, sizePrompt.stock);
                    setSizePrompt(null);
                    setTimeout(() => inputRef.current?.focus(), 10);
                  }}
                  className="min-w-14 px-4 py-3 rounded-xl border-2 border-teal-600 text-teal-800 font-bold text-lg hover:bg-teal-50 cursor-pointer"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
      </Modal>

      {/* Elegir el modelo de la otra tienda */}
      {catalog && (
        <ElegirModelo
          isOpen={!!picker}
          onClose={() => setPicker(null)}
          modelName={picker?.name ?? ''}
          storeName={toStore.name}
          groups={catalog.groups}
          products={catalog.products}
          allowProducts={!!picker && !picker.groupId}
          onPick={onPickModel}
        />
      )}

      {/* Elegir la variante a mano */}
      <Modal isOpen={!!variantPicker} onClose={() => setVariantPicker(null)} title="¿A qué variante llega?">
        {variantPicker && catalog && (
          <div className="space-y-2">
            <p className="text-sm text-slate-600">
              {variantPicker.group.name} en {toStore.name}. Pieza: {formatVariant(variantPicker.line.size ?? variantPicker.line.product.talla, variantPicker.line.product.color) || 'sin talla ni color'}
            </p>
            <ul className="divide-y divide-slate-100 border border-slate-200 rounded-lg max-h-[50vh] overflow-y-auto">
              {catalog.products
                .filter((p) => p.parent_group_id === variantPicker.group.id)
                .map((p) => (
                  <li key={p.id}>
                    <button
                      onClick={() => {
                        setVariantChoices((prev) => ({ ...prev, [variantPicker.line.key]: p.id }));
                        setVariantPicker(null);
                      }}
                      className="w-full text-left px-3 py-2.5 hover:bg-teal-50 cursor-pointer flex justify-between gap-3"
                    >
                      <span className="font-semibold text-slate-800">{formatVariant(p.talla, p.color) || 'Sin talla ni color'}</span>
                      <span className="text-xs font-mono text-slate-500">{p.sku_barcode}</span>
                    </button>
                  </li>
                ))}
            </ul>
            <button
              onClick={() => {
                setVariantChoices((prev) => {
                  const next = { ...prev };
                  delete next[variantPicker.line.key];
                  return next;
                });
                setVariantPicker(null);
              }}
              className="w-full text-left px-3 py-2.5 rounded-lg border border-dashed border-slate-300 text-sm text-slate-600 hover:bg-slate-50 cursor-pointer"
            >
              Que lo decida el sistema (misma talla y color, o variante nueva)
            </button>
          </div>
        )}
      </Modal>

      {/* Confirmar con letras grandes */}
      <Modal isOpen={confirmOpen} onClose={() => !sending && setConfirmOpen(false)} title="Confirmar envío">
        <div className="space-y-5 text-center">
          <div>
            <p className="text-lg text-slate-700">
              ¿Enviar {pieces} {pieces === 1 ? 'pieza' : 'piezas'} a
            </p>
            <p className="text-3xl sm:text-4xl font-extrabold text-[#0f5c5c] uppercase tracking-wide">{toStore.name}?</p>
          </div>
          <ul className="text-left text-sm divide-y divide-slate-100 border border-slate-200 rounded-xl">
            {models.map((m) => (
              <li key={m.key} className="px-3 py-2 flex items-center justify-between gap-3">
                <span className="text-slate-800">
                  {m.name} <span className="text-slate-400">→</span> <span className="font-semibold">{planSummary(m.plan, !m.groupId, fromShort)}</span>
                </span>
                <span className="font-bold text-slate-700">{m.pieces}</span>
              </li>
            ))}
          </ul>
          <p className="text-sm text-slate-500">
            Motivo: <span className="font-semibold text-slate-700">{note}</span>
          </p>
          {sendError && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-sm text-left">{sendError}</div>}
          <div className="flex gap-3">
            <button
              onClick={() => setConfirmOpen(false)}
              disabled={sending}
              className="flex-1 py-3 rounded-xl border border-slate-300 font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer disabled:opacity-50"
            >
              No, volver
            </button>
            <button
              onClick={() => void doSend()}
              disabled={sending}
              className="flex-1 py-3 rounded-xl bg-[#0f5c5c] hover:bg-teal-800 text-white font-bold cursor-pointer disabled:opacity-60"
            >
              {sending ? 'Enviando…' : 'Sí, enviar'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/** «su Cartera Polo» / «con su padre» para la confirmación. */
function planSummary(plan: Plan | null, loose: boolean, fromShort: string): string {
  if (!plan) return '…';
  switch (plan.kind) {
    case 'vuelve':
      return 'vuelve a su producto';
    case 'grupo':
      return `su ${plan.group.name}`;
    case 'producto':
      return `su ${plan.product.name}`;
    case 'origen':
      return loose ? `como producto de ${fromShort}` : 'con su padre';
  }
}

/** La columna «llega a…» del modelo: ✓, 🔗, ≈ con Sí/Otro, ＋ con Enlazar. */
function ModelBadge({
  model,
  toShort,
  fromShort,
  onPick,
  onConfirm,
}: {
  model: Model;
  toShort: string;
  fromShort: string;
  onPick: () => void;
  onConfirm: () => void;
}) {
  const plan = model.plan;
  if (!plan) return <span className="text-sm text-slate-400">…</span>;
  const btn = 'text-xs font-bold px-2.5 py-1 rounded-md cursor-pointer';
  switch (plan.kind) {
    case 'vuelve':
      return <span className="text-sm font-semibold text-emerald-700">↩ vuelve a su producto en {toShort}</span>;
    case 'grupo':
      if (!plan.confirmed) {
        return (
          <span className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2 py-0.5">≈ ¿su «{plan.group.name}»?</span>
            <button onClick={onConfirm} className={`${btn} bg-emerald-600 text-white hover:bg-emerald-700`}>Sí</button>
            <button onClick={onPick} className={`${btn} border border-slate-300 text-slate-700 hover:bg-slate-50`}>Otro</button>
          </span>
        );
      }
      return (
        <span className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-md px-2 py-0.5">
            {plan.how === 'enlazado' ? '🔗' : '✓'} su «{plan.group.name}»
          </span>
          <button onClick={onPick} className="text-xs text-slate-500 hover:text-slate-800 underline cursor-pointer">Cambiar</button>
        </span>
      );
    case 'producto':
      return (
        <span className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-md px-2 py-0.5">
            {plan.how === 'enlazado' ? '🔗' : '✓'} su «{plan.product.name}»
          </span>
          <button onClick={onPick} className="text-xs text-slate-500 hover:text-slate-800 underline cursor-pointer">Cambiar</button>
        </span>
      );
    case 'origen':
      return (
        <span className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-semibold text-indigo-800 bg-indigo-50 border border-indigo-200 rounded-md px-2 py-0.5">
            ＋ {plan.chosen ? (model.groupId ? 'con su padre de origen' : `como producto de ${fromShort}`) : `${toShort} no lo tiene`}
          </span>
          <button onClick={onPick} className={`${btn} border border-indigo-300 text-indigo-700 hover:bg-indigo-50`}>Enlazar</button>
        </span>
      );
  }
}

/** Qué le pasa a cada pieza dentro del modelo elegido. */
function LineTargetText({
  target,
  plan,
  toShort,
  fromShort,
  loose,
  onChooseVariant,
}: {
  target: LineTarget | null;
  plan: Plan | null;
  toShort: string;
  fromShort: string;
  /** Producto sin modelo: llega como hoy, suelto (no hay padre que lo acompañe). */
  loose: boolean;
  onChooseVariant?: () => void;
}) {
  if (!target || !plan) return <span className="text-slate-400">…</span>;
  const change = onChooseVariant && (
    <button onClick={onChooseVariant} className="ml-2 text-xs text-slate-500 hover:text-slate-800 underline cursor-pointer">
      elegir otra
    </button>
  );
  switch (target.kind) {
    case 'vuelve':
      return <span className="text-emerald-700">vuelve a su producto</span>;
    case 'existe':
      return (
        <span className="text-slate-700">
          se suma a su <span className="font-semibold">{formatVariant(target.product.talla, target.product.color) || target.product.name}</span>
          {target.how === 'elegido' && <span className="text-slate-400"> (elegida)</span>}
          {change}
        </span>
      );
    case 'nueva':
      return (
        <span className="text-slate-700">
          variante nueva <span className="text-[11px] font-bold bg-teal-600 text-white px-1.5 py-0.5 rounded">NUEVA</span>
          {change}
        </span>
      );
    case 'producto':
      return <span className="text-slate-700">se suma a su <span className="font-semibold">{target.product.name}</span></span>;
    case 'origen':
      return loose ? (
        <span className="text-indigo-700">llega a {toShort} como producto de {fromShort}, como hoy</span>
      ) : (
        <span className="text-indigo-700">llega a {toShort} con su padre, no suelta</span>
      );
  }
}
