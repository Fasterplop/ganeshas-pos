// Lecturas paginadas del módulo de Finanzas.
//
// POR QUÉ EXISTE ESTE ARCHIVO: PostgREST corta en 1000 filas y NO avisa. Una
// consulta que devuelve exactamente 1000 filas parece completa y no lo está.
// En este módulo eso sería un total de gastos mal sumado — el peor error
// posible aquí. El dashboard ya pagina así: ver
// src/app/(dashboard)/dashboard/page.tsx:549-569.

export const FIN_PAGE = 1000;

type PageResult<T> = { data: T[] | null; error: { code?: string; message?: string } | null };

/**
 * Trae TODAS las filas de una consulta, página por página.
 *
 * `build(from, to)` debe devolver la consulta ya con .range(from, to) aplicado.
 * El bucle se corta cuando una página viene incompleta, que es la señal de que
 * era la última.
 */
export async function fetchAllPages<T>(
  build: (from: number, to: number) => PromiseLike<PageResult<T>>,
  maxRows = 50_000,
): Promise<{ rows: T[]; error: { code?: string; message?: string } | null }> {
  const rows: T[] = [];
  for (let from = 0; from < maxRows; from += FIN_PAGE) {
    const { data, error } = await build(from, from + FIN_PAGE - 1);
    if (error) return { rows, error };
    const page = data ?? [];
    rows.push(...page);
    if (page.length < FIN_PAGE) break;
  }
  return { rows, error: null };
}

/**
 * Filtro de tienda del módulo.
 *
 * El scope 'todas' es el "consolidado" de la propuesta. Devuelve null cuando
 * no hay que filtrar, para que quien llama simplemente omita el .eq().
 */
export function storeFilter(
  scope: 'tienda' | 'todas',
  storeId: string | null | undefined,
): string | null {
  return scope === 'todas' ? null : storeId ?? null;
}
