#!/usr/bin/env node
/**
 * Analisis de SOLO DETECCION (no escribe nada en la base de datos): busca,
 * entre los productos de Tienda de Ropa que TODAVIA NO estan vinculados a
 * un producto padre (parent_group_id IS NULL), posibles grupos de variantes
 * (misma prenda, distinta talla/color) que el backfill del 3 de septiembre
 * no pudo procesar porque se cargaron despues o quedaron fuera.
 *
 *   node scripts/analyze-variants-ropa.mjs [--out archivo.xlsx]
 *
 * Genera un .xlsx con la misma estructura que el analisis original
 * (Resumen / Duplicados exactos / Variantes talla-color / Color en el
 * nombre), pero recalculado sobre el estado ACTUAL de la base de datos y
 * excluyendo todo lo que ya tiene parent_group_id (ya resuelto). No aplica
 * ni modifica nada — es un reporte para revisar a mano o pasarle a
 * backfill-ropa-variants.mjs / vincular manualmente desde Inventario.
 */
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';

const ROOT = path.resolve(import.meta.dirname, '..');

function loadEnv() {
  const file = path.join(ROOT, '.env.local');
  if (!fs.existsSync(file)) throw new Error('No se encontro .env.local');
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}

const env = loadEnv();
const URL_BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_BASE || !KEY) throw new Error('Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env.local');
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` };

const args = process.argv.slice(2);
const outFlagIdx = args.indexOf('--out');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT_PATH = path.resolve(
  ROOT,
  outFlagIdx >= 0 && args[outFlagIdx + 1] ? args[outFlagIdx + 1] : `backups/analisis-variantes-pendientes-${stamp}.xlsx`
);

// Palabras de color a "pelar" del nombre para detectar el patron
// "PRODUCTO + COLOR" (el color quedo escrito en el nombre en vez del campo
// color). Heuristica, no exhaustiva — igual que el analisis original.
const COLOR_WORDS = [
  'AZUL', 'ROJO', 'ROJA', 'VERDE', 'AMARILLO', 'AMARILLA', 'NEGRO', 'NEGRA',
  'BLANCO', 'BLANCA', 'GRIS', 'BEIGE', 'MARRON', 'MARRÓN', 'ROSADO', 'ROSADA',
  'ROSA', 'MORADO', 'MORADA', 'NARANJA', 'DORADO', 'DORADA', 'PLATEADO',
  'PLATEADA', 'VINOTINTO', 'TURQUESA', 'CELESTE', 'FUCSIA', 'CREMA', 'CAQUI',
  'KHAKI', 'VINO', 'PERLA', 'COBRE', 'BRONCE', 'PLATA', 'ORO', 'MULTICOLOR',
  'ESTAMPADO', 'ESTAMPADA', 'CLARO', 'CLARA', 'OSCURO', 'OSCURA', 'MARINO', 'CIELO',
];
const colorRegex = new RegExp(`\\b(${COLOR_WORDS.join('|')})\\b`, 'gi');
function stripColor(name) {
  return name.replace(colorRegex, ' ').replace(/\s+/g, ' ').trim();
}

async function fetchAll(table, params) {
  const PAGE = 1000;
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const qs = new URLSearchParams({ ...params, offset: String(from), limit: String(PAGE) });
    const res = await fetch(`${URL_BASE}/rest/v1/${table}?${qs}`, { headers });
    if (!res.ok) throw new Error(`GET ${table} ${res.status}: ${await res.text()}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

async function main() {
  console.log(`Base: ${URL_BASE}`);

  const stores = await fetchAll('stores', { select: 'id,name' });
  const ropa = stores.find(s => s.name.toLowerCase().includes('ropa'));
  if (!ropa) throw new Error('No se encontro la tienda "Tienda de Ropa"');
  console.log(`Tienda: ${ropa.name} (${ropa.id})`);

  const products = await fetchAll('products', {
    select: 'id,sku_barcode,name,category,price,talla,color,created_at,parent_group_id',
    owner_store_id: `eq.${ropa.id}`,
    is_active: 'eq.true',
    parent_group_id: 'is.null', // solo lo que TODAVIA no esta vinculado
    order: 'name.asc',
  });
  console.log(`Productos activos y SIN vincular en ${ropa.name}: ${products.length}`);

  // --- Agrupar por nombre EXACTO (trim) ---
  const byExactName = new Map();
  for (const p of products) {
    const key = p.name.trim();
    if (!byExactName.has(key)) byExactName.set(key, []);
    byExactName.get(key).push(p);
  }

  const exactDuplicates = []; // mismo nombre+talla+color
  const variantGroups = [];   // mismo nombre, distinta talla y/o color
  const usedInExactName = new Set();

  for (const [name, rows] of byExactName) {
    if (rows.length < 2) continue;
    usedInExactName.add(name);
    const sig = r => `${(r.talla || '').trim()}|${(r.color || '').trim()}`;
    const bySig = new Map();
    for (const r of rows) {
      const s = sig(r);
      if (!bySig.has(s)) bySig.set(s, []);
      bySig.get(s).push(r);
    }
    const isAllIdentical = bySig.size === 1;
    if (isAllIdentical) {
      exactDuplicates.push({ name, rows });
    } else {
      const hasTalla = rows.some(r => r.talla);
      const hasColor = rows.some(r => r.color);
      const variacion = hasTalla && hasColor ? 'talla y color' : hasTalla ? 'talla' : 'color';
      variantGroups.push({ name, rows, variacion });
    }
  }

  // --- "Color en el nombre": nombres que colapsan al mismo texto base al
  // quitarles una palabra de color, pero el texto original SI difiere (si
  // no, ya habria caido en el grupo de nombre exacto de arriba). ---
  const singles = products.filter(p => !usedInExactName.has(p.name.trim()));
  const byBase = new Map();
  for (const p of singles) {
    const original = p.name.trim();
    const base = stripColor(original);
    if (base === original || !base) continue; // no tenia palabra de color
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(p);
  }
  const colorInName = [];
  for (const [base, rows] of byBase) {
    const distinctNames = new Set(rows.map(r => r.name.trim()));
    if (distinctNames.size >= 2) colorInName.push({ base, rows });
  }

  console.log(`\nGrupos "Variantes talla-color": ${variantGroups.length} (${variantGroups.reduce((s, g) => s + g.rows.length, 0)} filas)`);
  console.log(`Grupos "Duplicados exactos": ${exactDuplicates.length} (${exactDuplicates.reduce((s, g) => s + g.rows.length, 0)} filas)`);
  console.log(`Grupos "Color en el nombre": ${colorInName.length} (${colorInName.reduce((s, g) => s + g.rows.length, 0)} filas)`);

  // --- Excel ---
  const wb = new ExcelJS.Workbook();
  const headerStyle = row => {
    row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    row.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } }; });
  };

  const wsResumen = wb.addWorksheet('Resumen');
  wsResumen.columns = [{ width: 55 }, { width: 20 }];
  wsResumen.addRows([
    ['Generado', new Date().toISOString()],
    ['Tienda', ropa.name],
    ['Productos activos SIN vincular a un producto padre', products.length],
    ['Grupos "Variantes talla-color" detectados', variantGroups.length],
    ['  -> filas dentro de esos grupos', variantGroups.reduce((s, g) => s + g.rows.length, 0)],
    ['Grupos "Duplicados exactos" (mismo nombre+talla+color)', exactDuplicates.length],
    ['  -> filas sobrantes a revisar', exactDuplicates.reduce((s, g) => s + g.rows.length - 1, 0)],
    ['Grupos "Color en el nombre"', colorInName.length],
    ['', ''],
    ['IMPORTANTE', 'Este archivo es solo de DETECCION. No se aplico ni cambio nada.'],
  ]);
  headerStyle(wsResumen.getRow(1));

  function addGroupSheet(name, groups, groupLabelKey) {
    const ws = wb.addWorksheet(name);
    ws.columns = [
      { header: groupLabelKey === 'base' ? 'Grupo (base sin color)' : 'Grupo (nombre)', key: 'grupo', width: 38 },
      { header: 'Variación', key: 'variacion', width: 14 },
      { header: '# filas', key: 'filas', width: 8 },
      { header: 'SKU', key: 'sku', width: 16 },
      { header: 'Nombre original', key: 'nombre', width: 40 },
      { header: 'Talla', key: 'talla', width: 12 },
      { header: 'Color', key: 'color', width: 16 },
      { header: 'Precio', key: 'precio', width: 10 },
      { header: 'Creado', key: 'creado', width: 12 },
      { header: 'ID', key: 'id', width: 38 },
    ];
    headerStyle(ws.getRow(1));
    groups
      .slice()
      .sort((a, b) => b.rows.length - a.rows.length)
      .forEach(g => {
        g.rows.forEach(r => {
          ws.addRow({
            grupo: groupLabelKey === 'base' ? g.base : g.name,
            variacion: g.variacion || (groupLabelKey === 'base' ? 'color en nombre' : 'idéntico'),
            filas: g.rows.length,
            sku: r.sku_barcode,
            nombre: r.name,
            talla: r.talla || '',
            color: r.color || '',
            precio: Number(r.price),
            creado: r.created_at ? r.created_at.slice(0, 10) : '',
            id: r.id,
          });
        });
      });
    return ws;
  }

  addGroupSheet('Variantes talla-color', variantGroups, 'name');
  addGroupSheet('Duplicados exactos', exactDuplicates, 'name');
  addGroupSheet('Color en el nombre', colorInName, 'base');

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  await wb.xlsx.writeFile(OUT_PATH);
  console.log(`\nArchivo generado: ${OUT_PATH}`);
  console.log('Nada fue modificado en la base de datos (esto es solo deteccion).');
}

main().catch((err) => { console.error('\nFALLO:', err.message); process.exitCode = 1; });
