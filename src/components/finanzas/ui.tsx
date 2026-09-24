'use client';

// Piezas de UI del módulo de Finanzas.
//
// Van juntas en un archivo (y no una por archivo como los componentes del POS)
// porque son átomos de este módulo, no componentes compartidos: se usan solo
// dentro de /finanzas y se leen mejor de corrido.
//
// Estilo tomado del resto del sistema: tarjetas
// `bg-white rounded-xl shadow-sm border border-slate-200`, tablas crudas con
// cabecera `bg-slate-100 text-slate-600`, paleta teal + slate.
//
// Aviso: el proyecto NO tiene toasts. El patrón es un mensaje en línea con
// estado {type, text}, como en src/app/(dashboard)/users/page.tsx:70,115-120.

import { ReactNode, useMemo, useState } from 'react';
import { dueLevel, daysUntil, formatDate } from '@/lib/finanzas/dates';

export type NoticeType = 'success' | 'error' | 'info';
export interface Notice {
  type: NoticeType;
  text: string;
}

export function FinNotice({ notice, onClose }: { notice: Notice | null; onClose?: () => void }) {
  if (!notice) return null;
  const tone =
    notice.type === 'success'
      ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
      : notice.type === 'error'
        ? 'bg-red-50 border-red-200 text-red-800'
        : 'bg-slate-50 border-slate-200 text-slate-700';

  return (
    <div className={`border rounded-lg px-4 py-3 text-sm flex items-start gap-3 ${tone}`}>
      <span className="flex-1">{notice.text}</span>
      {onClose && (
        <button onClick={onClose} className="opacity-60 hover:opacity-100 cursor-pointer">
          ✕
        </button>
      )}
    </div>
  );
}

export function FinStatCard({
  label,
  value,
  sub,
  tone = 'default',
  active = false,
  onClick,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'default' | 'teal' | 'amber' | 'red' | 'emerald';
  active?: boolean;
  onClick?: () => void;
}) {
  const toneClass = {
    default: 'text-slate-800',
    teal: 'text-teal-700',
    amber: 'text-amber-600',
    red: 'text-red-600',
    emerald: 'text-emerald-600',
  }[tone];

  const Tag = onClick ? 'button' : 'div';

  return (
    <Tag
      onClick={onClick}
      className={`bg-white p-3.5 sm:p-5 rounded-xl shadow-sm border text-left w-full transition-colors ${
        active ? 'border-teal-500 ring-1 ring-teal-200' : 'border-slate-200'
      } ${onClick ? 'hover:border-teal-400 cursor-pointer' : ''}`}
    >
      <p className="text-[10px] sm:text-[11px] uppercase tracking-widest text-slate-400 font-bold leading-tight">
        {label}
      </p>
      <p className={`text-lg sm:text-2xl font-bold mt-1 break-words ${toneClass}`}>{value}</p>
      {sub && <p className="text-[11px] sm:text-xs text-slate-500 mt-1 leading-snug">{sub}</p>}
    </Tag>
  );
}

export const SHIPMENT_STATUS_LABEL: Record<string, string> = {
  preparada: 'Preparada',
  enviada: 'Enviada',
  en_transito: 'En tránsito',
  recibida: 'Recibida',
  recibida_incompleta: 'Recibida incompleta',
};

export const SHIPMENT_STATUS_ORDER = [
  'preparada',
  'enviada',
  'en_transito',
  'recibida',
  'recibida_incompleta',
] as const;

export type ShipmentStatus = (typeof SHIPMENT_STATUS_ORDER)[number];

export function ShipmentStatusBadge({ status }: { status: string }) {
  const tone =
    {
      preparada: 'bg-slate-100 text-slate-700 border-slate-200',
      enviada: 'bg-blue-50 text-blue-700 border-blue-200',
      en_transito: 'bg-indigo-50 text-indigo-700 border-indigo-200',
      recibida: 'bg-emerald-50 text-emerald-700 border-emerald-200',
      recibida_incompleta: 'bg-amber-50 text-amber-800 border-amber-300',
    }[status] || 'bg-slate-100 text-slate-700 border-slate-200';

  return (
    <span className={`inline-block text-xs font-semibold px-2.5 py-1 rounded-full border ${tone}`}>
      {SHIPMENT_STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function PaymentStatusBadge({ status }: { status: string }) {
  const tone =
    {
      pagada: 'bg-emerald-50 text-emerald-700 border-emerald-200',
      parcial: 'bg-amber-50 text-amber-800 border-amber-300',
      pendiente: 'bg-red-50 text-red-700 border-red-200',
    }[status] || 'bg-slate-100 text-slate-700 border-slate-200';

  const label = { pagada: 'Pagada', parcial: 'Parcial', pendiente: 'Pendiente' }[status] ?? status;

  return (
    <span className={`inline-block text-xs font-semibold px-2.5 py-1 rounded-full border ${tone}`}>
      {label}
    </span>
  );
}

/** Vencimiento con los avisos que pide la propuesta: 7 días, 3 días, hoy, vencido. */
export function DueBadge({ dueDate }: { dueDate: string | null | undefined }) {
  const level = dueLevel(dueDate);
  if (!level || !dueDate) return <span className="text-slate-400">—</span>;

  const d = daysUntil(dueDate) ?? 0;
  const { tone, text } = {
    vencido: { tone: 'bg-red-600 text-white border-red-700', text: `Vencido hace ${-d} d` },
    hoy: { tone: 'bg-red-50 text-red-700 border-red-300', text: 'Vence hoy' },
    pronto: { tone: 'bg-amber-100 text-amber-900 border-amber-300', text: `En ${d} d` },
    cerca: { tone: 'bg-amber-50 text-amber-800 border-amber-200', text: `En ${d} d` },
    lejos: { tone: 'bg-slate-100 text-slate-600 border-slate-200', text: formatDate(dueDate) },
  }[level];

  return (
    <span
      className={`inline-block text-xs font-semibold px-2.5 py-1 rounded-full border ${tone}`}
      title={formatDate(dueDate)}
    >
      {text}
    </span>
  );
}

/** Campo de formulario con etiqueta y error, para no repetir clases en cada input. */
export function FinField({
  label,
  hint,
  error,
  required,
  children,
  className = '',
}: {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="block text-xs font-bold uppercase tracking-wide text-slate-500 mb-1.5">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-slate-400 mt-1">{hint}</p>}
      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
    </div>
  );
}

export const inputClass =
  'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-800 ' +
  'focus:outline-none focus:ring-2 focus:ring-teal-500/40 focus:border-teal-500 ' +
  'disabled:bg-slate-50 disabled:text-slate-400';

// Los botones no encogen ni parten su texto: en un telefono, un boton de dos
// lineas se lee como dos botones.
export const btnPrimary =
  'bg-teal-700 hover:bg-teal-800 text-white font-semibold px-3 sm:px-4 py-2 rounded-lg text-sm ' +
  'whitespace-nowrap transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer';

export const btnSecondary =
  'bg-white hover:bg-slate-50 text-slate-700 font-medium px-3 sm:px-4 py-2 rounded-lg text-sm ' +
  'whitespace-nowrap border border-slate-300 transition-colors disabled:opacity-50 cursor-pointer';

export const btnDanger =
  'bg-white hover:bg-red-50 text-red-600 font-medium px-3 sm:px-4 py-2 rounded-lg text-sm ' +
  'whitespace-nowrap border border-red-200 transition-colors disabled:opacity-50 cursor-pointer';

/**
 * Botones de una fila de tabla.
 *
 * Desde tablet van en su propia columna. En el teléfono esa columna se oculta
 * (`hidden sm:table-cell`) y los MISMOS botones se repiten debajo de la fila,
 * a todo el ancho, con `mobile`. Así ninguna acción queda escondida ni fuera
 * de la pantalla: antes, Editar no existía en el teléfono.
 */
export function RowActions({
  mobile = false,
  onDelete,
  deleteLabel = 'Eliminar',
  children,
}: {
  mobile?: boolean;
  onDelete?: () => void;
  deleteLabel?: string;
  children?: ReactNode;
}) {
  if (mobile) {
    return (
      <div className="sm:hidden mt-3 flex flex-wrap gap-2 *:flex-auto">
        {children}
        {onDelete && (
          <button className={btnDanger} onClick={onDelete}>
            {deleteLabel}
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {children}
      {onDelete && (
        <button
          className="text-slate-400 hover:text-red-600 px-1 cursor-pointer"
          onClick={onDelete}
          title={deleteLabel}
        >
          ✕
        </button>
      )}
    </div>
  );
}

/**
 * El monto de una fila en el teléfono. Ahí la columna del monto se oculta y
 * la fila queda en una sola columna, para que los botones tengan todo el ancho.
 */
export function MobileAmount({
  label,
  value,
  className = 'text-slate-800',
  sub,
}: {
  label: string;
  value: ReactNode;
  className?: string;
  sub?: ReactNode;
}) {
  return (
    <div className="sm:hidden mt-1.5 flex items-baseline justify-between gap-3">
      <span className="text-xs text-slate-400">{label}</span>
      <span className={`font-bold whitespace-nowrap ${className}`}>
        {value}
        {sub && <span className="ml-1 text-[11px] font-normal text-slate-400">{sub}</span>}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Paginación de tablas
//
// Las pantallas cargan TODO (fetchAllPages) porque los totales tienen que
// sumar todo; lo que se pagina es lo que se DIBUJA. Con el período por defecto
// desde enero, una tabla de cientos de filas trababa el teléfono.
// ---------------------------------------------------------------------------

export const FIN_PAGE_SIZE = 50;

export interface Paged<T> {
  slice: T[];
  page: number;
  pages: number;
  total: number;
  pageSize: number;
  setPage: (page: number) => void;
}

/**
 * Parte `items` en páginas. `resetKey` vuelve a la página 1 cuando cambia
 * (por ejemplo, al cambiar un filtro), sin un efecto que sincronice estado.
 */
export function usePaged<T>(items: T[], resetKey = '', pageSize = FIN_PAGE_SIZE): Paged<T> {
  const [state, setState] = useState({ key: resetKey, page: 1 });
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const requested = state.key === resetKey ? state.page : 1;
  const page = Math.min(Math.max(1, requested), pages);
  const slice = useMemo(() => items.slice((page - 1) * pageSize, page * pageSize), [items, page, pageSize]);
  return {
    slice,
    page,
    pages,
    total: items.length,
    pageSize,
    setPage: (p: number) => setState({ key: resetKey, page: p }),
  };
}

/** Barra "Mostrando 1–50 de 230 · ‹ Anterior · 1 2 3 … · Siguiente ›". */
export function Pagination<T>({ paged, className = '' }: { paged: Paged<T>; className?: string }) {
  const { page, pages, total, pageSize, setPage } = paged;
  if (pages <= 1) return null;

  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  // Primera, última y las dos vecinas de la actual; el resto se resume en "…".
  const nums = [...new Set([1, page - 1, page, page + 1, pages])].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);

  const btn = (active: boolean) =>
    `min-w-9 px-2.5 py-1.5 rounded-lg text-sm border transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
      active ? 'bg-teal-700 border-teal-700 text-white' : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'
    }`;

  return (
    <div className={`flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-3 sm:px-4 py-3 border-t border-slate-100 ${className}`}>
      <span className="text-xs text-slate-500">
        Mostrando {from}–{to} de {total}
      </span>
      <div className="flex flex-wrap items-center gap-1.5">
        <button className={btn(false)} disabled={page === 1} onClick={() => setPage(page - 1)} aria-label="Página anterior">
          ‹
        </button>
        {nums.map((n, i) => (
          <span key={n} className="flex items-center gap-1.5">
            {i > 0 && n - nums[i - 1] > 1 && <span className="text-slate-400 text-sm">…</span>}
            <button className={btn(n === page)} onClick={() => setPage(n)}>
              {n}
            </button>
          </span>
        ))}
        <button className={btn(false)} disabled={page === pages} onClick={() => setPage(page + 1)} aria-label="Página siguiente">
          ›
        </button>
      </div>
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="text-center py-16 px-6">
      <p className="text-slate-600 font-medium">{title}</p>
      {hint && <p className="text-sm text-slate-400 mt-1.5">{hint}</p>}
    </div>
  );
}
