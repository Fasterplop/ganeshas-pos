'use client';

// Elegir a qué producto padre de la otra tienda llega un modelo: «Otro» en un
// nombre parecido, «Enlazar» cuando la otra tienda no lo tiene, y «Cambiar».
// Busca en el catálogo que ya se cargó (sin pedir nada a la base) y ordena
// primero lo que más se parece.

import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import Modal from '@/components/Modal';
import { formatVariant } from '@/lib/productVariant';
import { nameSimilarity, normText, type DestGroup, type DestProduct } from '@/lib/traslados';

export type ModeloPick =
  | { kind: 'group'; group: DestGroup }
  | { kind: 'product'; product: DestProduct }
  | { kind: 'origen' };

const MAX = 60;

export default function ElegirModelo({
  isOpen,
  onClose,
  modelName,
  storeName,
  groups,
  products,
  allowProducts,
  onPick,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** Nombre del modelo que se envía (sirve de búsqueda inicial). */
  modelName: string;
  /** «Tienda de Juguetes» */
  storeName: string;
  groups: DestGroup[];
  products: DestProduct[];
  /** Un producto suelto también puede llegar a otro producto suelto. */
  allowProducts: boolean;
  onPick: (pick: ModeloPick) => void;
}) {
  const [search, setSearch] = useState('');

  const variantsByGroup = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of products) if (p.parent_group_id) m.set(p.parent_group_id, (m.get(p.parent_group_id) ?? 0) + 1);
    return m;
  }, [products]);

  const results = useMemo(() => {
    const words = normText(search).split(' ').filter(Boolean);
    const matches = (name: string) => words.every((w) => normText(name).includes(w));
    const score = (name: string) => nameSimilarity(modelName, name);
    const gs = groups
      .filter((g) => (words.length ? matches(g.name) : score(g.name) > 0))
      .map((g) => ({ kind: 'group' as const, g, s: score(g.name) }));
    const ps = allowProducts
      ? products
          .filter((p) => !p.parent_group_id && (words.length ? matches(p.name) : score(p.name) > 0))
          .map((p) => ({ kind: 'product' as const, p, s: score(p.name) }))
      : [];
    return [...gs, ...ps]
      .sort((a, b) => b.s - a.s || (a.kind === 'group' ? a.g.name : a.p.name).localeCompare(b.kind === 'group' ? b.g.name : b.p.name))
      .slice(0, MAX);
  }, [search, groups, products, allowProducts, modelName]);

  const close = () => {
    setSearch('');
    onClose();
  };
  const pick = (p: ModeloPick) => {
    setSearch('');
    onPick(p);
  };

  return (
    <Modal isOpen={isOpen} onClose={close} title={`¿A qué producto llega en ${storeName}?`}>
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          Enviando: <span className="font-semibold text-slate-800">{modelName}</span>
        </p>
        <label className="flex items-center gap-2 border border-slate-300 rounded-lg px-3 py-2 focus-within:ring-2 focus-within:ring-teal-500/40">
          <Search size={16} className="text-slate-400 shrink-0" />
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Buscar en ${storeName}…`}
            className="flex-1 outline-none text-sm"
          />
        </label>

        <ul className="divide-y divide-slate-100 border border-slate-200 rounded-lg max-h-[50vh] overflow-y-auto">
          {results.length === 0 ? (
            <li className="p-4 text-sm text-slate-500 text-center">
              {search ? 'Nada con ese nombre.' : `No se encontró nada parecido en ${storeName}. Escribe para buscar.`}
            </li>
          ) : (
            results.map((r) =>
              r.kind === 'group' ? (
                <li key={`g-${r.g.id}`}>
                  <button
                    onClick={() => pick({ kind: 'group', group: r.g })}
                    className="w-full text-left px-3 py-2.5 hover:bg-teal-50 cursor-pointer flex items-center justify-between gap-3"
                  >
                    <span className="font-semibold text-slate-800">{r.g.name}</span>
                    <span className="text-xs text-slate-500 shrink-0">
                      {variantsByGroup.get(r.g.id) ?? 0} variantes
                    </span>
                  </button>
                </li>
              ) : (
                <li key={`p-${r.p.id}`}>
                  <button
                    onClick={() => pick({ kind: 'product', product: r.p })}
                    className="w-full text-left px-3 py-2.5 hover:bg-teal-50 cursor-pointer flex items-center justify-between gap-3"
                  >
                    <span className="text-slate-800">
                      <span className="font-semibold">{r.p.name}</span>
                      {formatVariant(r.p.talla, r.p.color) && (
                        <span className="text-slate-500"> · {formatVariant(r.p.talla, r.p.color)}</span>
                      )}
                    </span>
                    <span className="text-xs text-slate-500 font-mono shrink-0">{r.p.sku_barcode}</span>
                  </button>
                </li>
              ),
            )
          )}
        </ul>

        <button
          onClick={() => pick({ kind: 'origen' })}
          className="w-full text-left px-3 py-2.5 rounded-lg border border-dashed border-slate-300 text-sm text-slate-600 hover:bg-slate-50 cursor-pointer"
        >
          <span className="font-semibold">Ninguno:</span> que llegue con su padre de origen
        </button>
      </div>
    </Modal>
  );
}
