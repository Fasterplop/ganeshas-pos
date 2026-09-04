#!/usr/bin/env node
/**
 * Backfill de "producto padre" (product_groups) para los 216 grupos "limpios"
 * de la hoja "Variantes talla-color" del análisis de duplicados de Tienda de
 * Ropa (backups/2026-09-01T21-23-13/analisis-duplicados-tienda-ropa.xlsx).
 *
 *   node scripts/backfill-ropa-variants.mjs            # dry-run (no escribe nada)
 *   node scripts/backfill-ropa-variants.mjs --apply     # aplica de verdad
 *   node scripts/backfill-ropa-variants.mjs --file otro.xlsx [--apply]
 *
 * Requiere que db/product_variants.sql ya esté aplicado en Supabase (crea
 * product_groups y products.parent_group_id).
 *
 * Qué hace, por cada grupo de la hoja "Variantes talla-color":
 *   1. Toma los IDs de producto listados en el xlsx (columna ID).
 *   2. Vuelve a consultar esos IDs DIRECTO en la base de datos actual (nunca
 *      confía en el snapshot del xlsx) para leer name/category/price/
 *      is_active/owner_store_id/parent_group_id de HOY.
 *   3. Descarta del grupo cualquier miembro is_active=false (inactivo =
 *      eliminado, no se resucita) y cualquier ID que ya no exista.
 *   4. Si el grupo queda con menos de 2 miembros activos, o si algún miembro
 *      ya tiene parent_group_id (corrida previa), o si el nombre/categoría/
 *      tienda no es consistente entre los miembros vivos: SALTA el grupo
 *      completo y lo reporta para revisión manual. Nunca fuerza una
 *      decisión ambigua.
 *   5. Si el grupo pasa todas las validaciones: crea UNA fila en
 *      product_groups (nombre/categoría/precio-más-frecuente/tienda) y
 *      actualiza parent_group_id en cada miembro. Nada se borra ni se
 *      renombra; solo se agrega el vínculo.
 *
 * Por defecto corre en modo DRY-RUN: solo imprime el plan (qué se crearía,
 * qué se salta y por qué), sin tocar la base de datos. Hace falta pasar
 * --apply explícitamente para escribir.
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

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const fileFlagIdx = args.indexOf('--file');
const XLSX_PATH = path.resolve(
  ROOT,
  fileFlagIdx >= 0 && args[fileFlagIdx + 1]
    ? args[fileFlagIdx + 1]
    : 'backups/2026-09-01T21-23-13/analisis-duplicados-tienda-ropa.xlsx'
);
const SHEET_NAME = 'Variantes talla-color';

// --- 1. Leer los grupos candidatos del xlsx --------------------------------
async function readCandidateGroups() {
  if (!fs.existsSync(XLSX_PATH)) throw new Error(`No se encontro el archivo: ${XLSX_PATH}`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX_PATH);
  const ws = wb.getWorksheet(SHEET_NAME);
  if (!ws) throw new Error(`No se encontro la hoja "${SHEET_NAME}" en ${XLSX_PATH}`);

  // Columnas por NOMBRE de encabezado (no por posición fija): distintos
  // análisis (el original vs. los de re-chequeo) no siempre tienen las
  // mismas columnas en el mismo orden, así que se ubican leyendo la fila 1.
  const headerRow = ws.getRow(1);
  const colOf = (label) => {
    let idx = null;
    headerRow.eachCell((cell, colNumber) => {
      if (String(cell.value ?? '').trim().toLowerCase() === label.toLowerCase()) idx = colNumber;
    });
    if (!idx) throw new Error(`No se encontró la columna "${label}" en la hoja "${SHEET_NAME}"`);
    return idx;
  };
  const groupCol = colOf('Grupo (nombre)');
  const skuCol = colOf('SKU');
  const idCol = colOf('ID');

  const groups = new Map(); // nombre del grupo -> [{ id, sku }]
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // header
    const groupName = String(row.getCell(groupCol).value ?? '').trim();
    const sku = String(row.getCell(skuCol).value ?? '').trim();
    const id = String(row.getCell(idCol).value ?? '').trim();
    if (!groupName || !id) return;
    if (!groups.has(groupName)) groups.set(groupName, []);
    groups.get(groupName).push({ id, sku });
  });
  return groups;
}

// --- 2. Releer esos IDs directo en la BD actual ----------------------------
async function fetchLiveProducts(ids) {
  const qs = new URLSearchParams({
    select: 'id,name,category,price,is_active,owner_store_id,parent_group_id',
    id: `in.(${ids.join(',')})`,
  });
  const res = await fetch(`${URL_BASE}/rest/v1/products?${qs}`, { headers });
  if (!res.ok) throw new Error(`GET products ${res.status}: ${await res.text()}`);
  return res.json();
}

async function createGroup({ name, category, default_price, owner_store_id }) {
  const res = await fetch(`${URL_BASE}/rest/v1/product_groups`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'return=representation' },
    body: JSON.stringify([{ name, category, default_price, owner_store_id, is_active: true }]),
  });
  if (!res.ok) throw new Error(`POST product_groups ${res.status}: ${await res.text()}`);
  const [row] = await res.json();
  return row.id;
}

async function linkProducts(ids, groupId) {
  const qs = new URLSearchParams({ id: `in.(${ids.join(',')})` });
  const res = await fetch(`${URL_BASE}/rest/v1/products?${qs}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ parent_group_id: groupId }),
  });
  if (!res.ok) throw new Error(`PATCH products ${res.status}: ${await res.text()}`);
}

function mostFrequentPrice(prices) {
  const counts = new Map();
  for (const p of prices) counts.set(p, (counts.get(p) ?? 0) + 1);
  let best = prices[0];
  let bestCount = -1;
  for (const [p, c] of counts) {
    if (c > bestCount || (c === bestCount && p < best)) { best = p; bestCount = c; }
  }
  return best;
}

async function main() {
  console.log(`Base: ${URL_BASE}`);
  console.log(`Archivo: ${XLSX_PATH}`);
  console.log(`Modo: ${APPLY ? 'APLICAR (escribe en produccion)' : 'DRY-RUN (solo reporte, no escribe nada)'}\n`);

  const candidateGroups = await readCandidateGroups();
  console.log(`Grupos candidatos en el xlsx: ${candidateGroups.size}\n`);

  const toCreate = [];
  const skipped = [];

  for (const [groupName, members] of candidateGroups) {
    const ids = members.map(m => m.id);
    const live = await fetchLiveProducts(ids);
    const activeLive = live.filter(p => p.is_active === true);

    if (activeLive.length < 2) {
      skipped.push({ groupName, reason: `solo ${activeLive.length} miembro(s) activo(s) en la BD (de ${ids.length} en el xlsx)` });
      continue;
    }
    if (activeLive.some(p => p.parent_group_id)) {
      skipped.push({ groupName, reason: 'algun miembro ya tiene parent_group_id (corrida previa o vinculo manual)' });
      continue;
    }
    const names = new Set(activeLive.map(p => p.name.trim()));
    if (names.size > 1) {
      skipped.push({ groupName, reason: `nombres distintos en la BD actual: ${[...names].join(' | ')}` });
      continue;
    }
    const categories = new Set(activeLive.map(p => p.category));
    if (categories.size > 1) {
      skipped.push({ groupName, reason: `categorias distintas entre miembros: ${[...categories].join(', ')}` });
      continue;
    }
    const stores = new Set(activeLive.map(p => p.owner_store_id));
    if (stores.size > 1) {
      skipped.push({ groupName, reason: 'los miembros pertenecen a tiendas (owner_store_id) distintas' });
      continue;
    }

    const prices = activeLive.map(p => Number(p.price));
    const default_price = mostFrequentPrice(prices);
    const priceVaries = new Set(prices).size > 1;

    toCreate.push({
      groupName,
      name: [...names][0],
      category: [...categories][0],
      owner_store_id: [...stores][0],
      default_price,
      priceVaries,
      priceRange: priceVaries ? `${Math.min(...prices).toFixed(2)} - ${Math.max(...prices).toFixed(2)}` : null,
      memberIds: activeLive.map(p => p.id),
      memberCount: activeLive.length,
    });
  }

  console.log(`=== Se crearian ${toCreate.length} productos padre ===`);
  for (const g of toCreate) {
    const priceNote = g.priceVaries ? `  ⚠ precios varian (${g.priceRange}), se usa la mas frecuente` : '';
    console.log(`  - "${g.name}" (${g.category}) — ${g.memberCount} variantes — precio por defecto $${g.default_price.toFixed(2)}${priceNote}`);
  }

  console.log(`\n=== Se saltan ${skipped.length} grupos (revision manual desde Inventario) ===`);
  for (const s of skipped) {
    console.log(`  - "${s.groupName}": ${s.reason}`);
  }

  if (!APPLY) {
    console.log('\nDry-run: no se escribio nada. Corre con --apply para aplicar este plan.');
    return;
  }

  console.log('\nAplicando...');
  let created = 0;
  const failures = [];
  for (const g of toCreate) {
    try {
      const groupId = await createGroup({
        name: g.name,
        category: g.category,
        default_price: g.default_price,
        owner_store_id: g.owner_store_id,
      });
      await linkProducts(g.memberIds, groupId);
      created++;
      console.log(`  OK "${g.name}" -> grupo ${groupId} (${g.memberIds.length} variantes)`);
    } catch (err) {
      failures.push({ groupName: g.groupName, error: err.message });
      console.log(`  FALLO "${g.name}": ${err.message}`);
    }
  }

  console.log(`\nListo: ${created}/${toCreate.length} productos padre creados.`);
  if (failures.length) {
    console.log(`${failures.length} fallaron (ver arriba); no se tocaron sus productos.`);
  }
}

main().catch((err) => { console.error('\nFALLO:', err.message); process.exitCode = 1; });
