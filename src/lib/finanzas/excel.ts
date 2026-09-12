'use client';

// Exportación a Excel del módulo de Finanzas.
//
// Se construye nuevo en vez de reutilizar el bloque de exceljs del dashboard
// (src/app/(dashboard)/dashboard/page.tsx:537-706) por dos razones:
//   1. Ese export funciona hoy sobre ventas reales y el cliente lo usa a
//      diario. Refactorizarlo no aporta nada a este módulo y sí arriesga
//      romperle el reporte.
//   2. Finanzas necesita dos cosas que ese bloque no hace: HOJA DE PORTADA y
//      VARIAS HOJAS por archivo (el "paquete para el contador" de la
//      propuesta).
//
// Se mantiene el mismo aspecto: cabecera azul FF1F3864, fila congelada,
// autofiltro, totales en verde y los importes como NÚMEROS con numFmt (no
// texto), para que se puedan sumar en Excel.

import ExcelJS from 'exceljs';
import { caracasToday, formatDate } from './dates';

const HEADER_FILL = 'FF1F3864';
const TOTAL_FILL = 'FFD9EAD3';
const TOTAL_FONT = 'FF274E13';

export const FMT_USD = '"$"#,##0.00';
export const FMT_VES = '#,##0.00 "Bs"';
export const FMT_INT = '#,##0';

export interface FinColumn {
  header: string;
  key: string;
  width?: number;
  numFmt?: string;
  wrap?: boolean;
  align?: 'left' | 'center' | 'right';
}

export interface FinSheet {
  name: string;
  columns: FinColumn[];
  rows: Record<string, unknown>[];
  /** Totales por clave de columna. Se pintan en una fila al final. */
  totals?: Record<string, number>;
  totalsLabel?: string;
  /** Nota al pie, para aclarar de dónde sale la hoja. */
  note?: string;
}

export interface FinCover {
  title: string;
  storeName: string;
  periodStart?: string;
  periodEnd?: string;
  extra?: Array<[string, string]>;
}

function addCoverSheet(wb: ExcelJS.Workbook, cover: FinCover, sheets: FinSheet[]) {
  const ws = wb.addWorksheet('Portada');
  ws.columns = [{ key: 'k', width: 26 }, { key: 'v', width: 52 }];

  const title = ws.addRow({ k: cover.title });
  ws.mergeCells(`A${title.number}:B${title.number}`);
  title.font = { bold: true, size: 16, color: { argb: 'FF1F3864' } };
  title.height = 26;

  ws.addRow({});

  const periodo =
    cover.periodStart && cover.periodEnd
      ? `${formatDate(cover.periodStart)} al ${formatDate(cover.periodEnd)}`
      : 'Todo el histórico';

  const meta: Array<[string, string]> = [
    ['Sucursal', cover.storeName],
    ['Período', periodo],
    ['Generado', formatDate(caracasToday())],
    ...(cover.extra ?? []),
  ];

  for (const [k, v] of meta) {
    const r = ws.addRow({ k, v });
    r.getCell('k').font = { bold: true, color: { argb: 'FF334155' } };
  }

  ws.addRow({});
  const idxTitle = ws.addRow({ k: 'Hojas de este archivo' });
  idxTitle.font = { bold: true, color: { argb: 'FF1F3864' } };
  for (const s of sheets) {
    ws.addRow({ k: s.name, v: `${s.rows.length} ${s.rows.length === 1 ? 'fila' : 'filas'}` });
  }
}

function addDataSheet(wb: ExcelJS.Workbook, sheet: FinSheet) {
  // Excel no admite estos caracteres en el nombre de una hoja, ni más de 31.
  const safeName = sheet.name.replace(/[\\/*?:[\]]/g, '-').slice(0, 31);
  const ws = wb.addWorksheet(safeName, { views: [{ state: 'frozen', ySplit: 1 }] });

  ws.columns = sheet.columns.map((c) => ({
    header: c.header,
    key: c.key,
    width: c.width ?? 18,
    style: c.numFmt ? { numFmt: c.numFmt } : undefined,
  }));

  for (const c of sheet.columns) {
    if (c.wrap || c.align) {
      ws.getColumn(c.key).alignment = {
        wrapText: !!c.wrap,
        vertical: 'top',
        ...(c.align ? { horizontal: c.align } : {}),
      };
    }
  }

  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  headerRow.height = 30;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF334155' } } };
  });

  for (const row of sheet.rows) ws.addRow(row);

  if (sheet.totals && Object.keys(sheet.totals).length > 0) {
    const firstKey = sheet.columns[0].key;
    const totalRow = ws.addRow({ [firstKey]: sheet.totalsLabel ?? 'TOTALES', ...sheet.totals });
    totalRow.font = { bold: true, color: { argb: TOTAL_FONT } };
    totalRow.height = 20;
    for (let c = 1; c <= sheet.columns.length; c++) {
      totalRow.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOTAL_FILL } };
    }
  }

  if (sheet.rows.length > 0) {
    const lastCol = ws.getColumn(sheet.columns.length).letter;
    ws.autoFilter = { from: 'A1', to: `${lastCol}1` };
  }

  if (sheet.note) {
    ws.addRow({});
    const note = ws.addRow({ [sheet.columns[0].key]: sheet.note });
    note.font = { italic: true, size: 9, color: { argb: 'FF64748B' } };
  }
}

/**
 * Arma el .xlsx y dispara la descarga.
 *
 * `sheets` con una sola hoja produce un export normal; con varias, el "paquete
 * para el contador". La portada se agrega sola siempre.
 */
export async function downloadFinWorkbook(opts: {
  filename: string;
  cover: FinCover;
  sheets: FinSheet[];
}): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();

  addCoverSheet(wb, opts.cover, opts.sheets);
  for (const s of opts.sheets) addDataSheet(wb, s);

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = opts.filename.endsWith('.xlsx') ? opts.filename : `${opts.filename}.xlsx`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** "cajas_tienda_a_2026-09-01_al_2026-09-30" */
export function finFilename(base: string, storeName: string, start?: string, end?: string): string {
  const store = (storeName || 'tienda').replace(/\s+/g, '_').toLowerCase();
  const range = start && end ? `_${start}_al_${end}` : '';
  return `${base}_${store}${range}.xlsx`;
}
