#!/usr/bin/env node
/**
 * Analisis de SOLO DETECCION (no escribe nada en la base de datos) para
 * implementar variantes (producto padre + hijas) en Tienda de Juguetes,
 * como ya se hizo en Tienda de Ropa.
 *
 *   node scripts/analyze-variants-juguetes.mjs [--out archivo.xlsx]
 *
 * Diferencia importante con Ropa: en Ropa cada talla/color ya era una fila
 * propia (mismo nombre, distinta talla) y solo hubo que AGRUPARLAS bajo un
 * padre. En Juguetes la mayoria de los articulos son UNA sola fila que
 * "empaqueta" varias tallas o colores en un solo campo ("18, 19, 20, 21" /
 * "AZUL, FUCSIA") con el stock sumado. Convertir eso en variantes reales
 * implica DIVIDIR filas (SKUs nuevos), no solo vincularlas.
 *
 * Hojas del .xlsx:
 *   Resumen
 *   A. Nombre exacto (agrupar)  -> mismo nombre, distinta talla/color: se
 *                                  pueden vincular tal cual (como en Ropa).
 *   B. Duplicados exactos       -> mismo nombre+talla+color: NO son
 *                                  variantes, son dos SKU para lo mismo.
 *   C. Nombre similar           -> mismo nombre base al quitar tamano/
 *                                  medida/color del nombre (PQ/GRANDE,
 *                                  12PCS/24PCS, 30ML/50ML, AZUL/VERDE...).
 *   D. Mismo prefijo + precio   -> misma linea/personaje al mismo precio
 *                                  (paw patrol chase/skye...). Decision
 *                                  de negocio, baja confianza.
 *   E. Varias tallas en 1 fila  -> filas a DIVIDIR en una hija por talla.
 *   F. Varios colores en 1 fila -> filas a DIVIDIR en una hija por color.
 *
 * Solo productos activos (is_active=false = eliminado) y sin padre.
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
  outFlagIdx >= 0 && args[outFlagIdx + 1] ? args[outFlagIdx + 1] : `backups/analisis-variantes-juguetes-${stamp}.xlsx`
);

// ---------------------------------------------------------------------------
// Normalizacion de nombres
// ---------------------------------------------------------------------------
const deaccent = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
// Mayusculas, sin acentos, puntuacion -> espacio, espacios colapsados.
const norm = (s) => deaccent(String(s ?? '')).toUpperCase().replace(/[.,;:!¡?¿"'()\-]/g, ' ').replace(/\s+/g, ' ').trim();

// Palabras de TAMANO que suelen ir en el nombre (PQ/GRANDE/MINI...).
const SIZE_WORDS = [
  'PQ', 'PQNO', 'PQNA', 'PEQUENO', 'PEQUENA', 'PEQUENOS', 'PEQUENAS', 'G', 'GRANDE', 'GRANDES',
  'MEDIANO', 'MEDIANA', 'MINI', 'JUMBO', 'XL', 'XS', 'S', 'M', 'L',
  'NINA', 'NINO', 'NINAS', 'NINOS', 'KIDS', 'ADULTO', 'ADULTOS', 'JUNIOR', 'PLUS', 'BEBE',
];
// Palabras de COLOR / acabado que suelen ir en el nombre.
const COLOR_WORDS = [
  'AZUL', 'ROJO', 'ROJA', 'VERDE', 'AMARILLO', 'AMARILLA', 'NEGRO', 'NEGRA', 'BLANCO', 'BLANCA', 'BCO',
  'GRIS', 'BEIGE', 'MARRON', 'ROSADO', 'ROSADA', 'ROSA', 'MORADO', 'MORADA', 'NARANJA', 'DORADO', 'DORADA',
  'PLATEADO', 'PLATEADA', 'VINOTINTO', 'TURQUESA', 'CELESTE', 'FUCSIA', 'FUSCIA', 'CREMA', 'LILA', 'TEAL',
  'PINK', 'BLACK', 'CRUDO', 'ESTAMPADO', 'ESTAMPADA', 'NEON', 'BRILLANTE', 'GLITTER', 'MULTICOLOR',
  'CAMUFLAJE', 'CARAMELO', 'TABACO', 'MELON', 'SALMON', 'CORAL', 'UVA', 'LADRILLO', 'PASTEL',
];
const sizeRx = new RegExp(`\\b(${SIZE_WORDS.join('|')})\\b`, 'g');
const colorRx = new RegExp(`\\b(${COLOR_WORDS.join('|')})\\b`, 'g');
// Medidas / cantidades: 12PCS, PCS 148, 30ML, 20G, 14 OZ, 25MM, 2 PULGADAS,
// 6PARES, 100HOJAS, LEVEL 1, 3PACK, 50 FOLIOS, 1/2, 2EN1...
const measRx = /\b\d+([.,]\d+)?\s*(ML|G|GR|GB|OZ|MM|CM|PCS|PC|PZA|PZAS|HOJAS|PARES|PAR|PACK|FOLIOS|PULGADAS?|DIGIT|CS)\b|\bPCS\s*\d+\b|\bLEVEL\s*\d+\b|\b\d+\s*\/\s*\d+\b|\b\d+\s*(EN|IN)\s*\d+\b/g;

/** Nombre "base": sin tamano, color ni medidas. Sirve para agrupar nombres similares. */
function baseName(name) {
  return norm(name).replace(measRx, ' ').replace(sizeRx, ' ').replace(colorRx, ' ').replace(/\b\d+\b/g, ' ').replace(/\s+/g, ' ').trim();
}
/** Que se le quito al nombre (para mostrar como "variante detectada"). */
function strippedPart(name) {
  const n = norm(name);
  const b = baseName(name);
  const baseTokens = new Set(b.split(' '));
  return n.split(' ').filter(t => !baseTokens.has(t)).join(' ');
}

// ---------------------------------------------------------------------------
// Campos talla/color con varios valores ("18, 19, 20" / "AZUL, FUCSIA").
// Solo la COMA separa valores: "NEGRO/AZUL" es un bicolor, "T/U" talla
// unica, "8/11" un rango.
// ---------------------------------------------------------------------------
function splitValues(field) {
  return String(field ?? '').split(',').map(s => s.trim()).filter(Boolean);
}
function isMulti(field) {
  return splitValues(field).length >= 2;
}
/** Cuenta valores distintos conservando orden: "S, S, M" -> [[S,2],[M,1]] */
function countValues(values) {
  const m = new Map();
  for (const v of values) {
    const k = v.toUpperCase().replace(/\s+/g, ' ');
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()];
}
/** "9-12, 12-18, 18-24 M": si el ultimo trae unidad (M/MESES/A/Y/T) y los
 * demas son solo numeros/rangos, propaga la unidad. Solo para la
 * sugerencia; el valor original se conserva al lado. */
function propagateUnit(values) {
  if (values.length < 2) return values;
  const last = values[values.length - 1];
  const m = last.match(/^([\d\-\s]+)\s*(M|MESES|A|Y|T)$/i);
  if (!m) return values;
  // Si algun valor intermedio ya trae su propia unidad ("12-18, 18-24M, 2A")
  // las unidades son mixtas y no se puede asumir nada: se deja tal cual.
  if (values.slice(0, -1).some(v => /[A-Za-z]/.test(v))) return values;
  const unit = m[2].toUpperCase();
  return values.map(v => (/^[\d\-\s]+$/.test(v) ? `${v.trim()}${unit === 'MESES' ? ' MESES' : unit}` : v));
}

// ---------------------------------------------------------------------------
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
  const store = stores.find(s => s.name.toLowerCase().includes('juguete'));
  if (!store) throw new Error('No se encontro la tienda "Tienda de Juguetes"');
  console.log(`Tienda: ${store.name} (${store.id})`);

  const raw = await fetchAll('products', {
    select: 'id,sku_barcode,name,category,price,talla,color,created_at,label_printed_at,parent_group_id,store_stock(store_id,stock)',
    owner_store_id: `eq.${store.id}`,
    is_active: 'eq.true',
    parent_group_id: 'is.null',
    order: 'name.asc',
  });
  const products = raw.map(p => ({
    ...p,
    stock: (p.store_stock ?? []).find(s => s.store_id === store.id)?.stock ?? 0,
  }));
  const totalUnits = products.reduce((s, p) => s + p.stock, 0);
  console.log(`Productos activos y SIN vincular en ${store.name}: ${products.length} (${totalUnits} unidades en stock)`);

  // --- A/B: agrupar por nombre EXACTO normalizado ----------------------------
  const byExact = new Map();
  for (const p of products) {
    const k = norm(p.name);
    if (!byExact.has(k)) byExact.set(k, []);
    byExact.get(k).push(p);
  }
  const exactVariants = [];   // A: mismo nombre, distinta talla/color
  const exactDuplicates = []; // B: mismo nombre+talla+color
  const usedExact = new Set();
  for (const [name, rows] of byExact) {
    if (rows.length < 2) continue;
    usedExact.add(name);
    const sig = r => `${norm(r.talla)}|${norm(r.color)}`;
    const sigs = new Set(rows.map(sig));
    const cats = new Set(rows.map(r => r.category));
    const prices = new Set(rows.map(r => Number(r.price)));
    const anyMulti = rows.some(r => isMulti(r.talla) || isMulti(r.color));
    const notes = [];
    if (cats.size > 1) notes.push(`categorias distintas (${[...cats].join(', ')})`);
    if (prices.size > 1) notes.push(`precios distintos (${[...prices].join(' / ')})`);
    if (anyMulti) notes.push('alguna fila tiene varias tallas/colores en un campo (ver hojas E/F)');
    if (sigs.size === 1) {
      exactDuplicates.push({ name: rows[0].name.trim(), rows, notes });
    } else {
      const hasT = rows.some(r => r.talla), hasC = rows.some(r => r.color);
      const variacion = hasT && hasC ? 'talla y color' : hasT ? 'talla' : 'color';
      const estado = notes.length ? 'REVISAR' : 'LISTO PARA VINCULAR';
      exactVariants.push({ name: rows[0].name.trim(), rows, variacion, estado, notes });
    }
  }

  // --- C: nombre base similar (tamano/medida/color en el nombre) -------------
  const singles = products.filter(p => !usedExact.has(norm(p.name)));
  const byBase = new Map();
  for (const p of singles) {
    const b = baseName(p.name);
    if (!b || b === norm(p.name)) continue; // no se le quito nada
    // Una sola palabra de base ("BOLSO") agrupa cualquier cosa: se exige
    // al menos dos palabras para que el grupo tenga sentido.
    if (b.split(' ').length < 2) continue;
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(p);
  }
  // Tambien incluir productos cuyo nombre normalizado ES exactamente la base
  // de otros ("BOLSO ENZO" junto a "BOLSO ENZO PEQUENO").
  for (const p of singles) {
    const n = norm(p.name);
    if (byBase.has(n) && !byBase.get(n).includes(p)) byBase.get(n).push(p);
  }
  const similar = [];
  const usedSimilar = new Set();
  for (const [base, rows] of byBase) {
    const names = new Set(rows.map(r => norm(r.name)));
    if (names.size < 2) continue;
    const cats = new Set(rows.map(r => r.category));
    const prices = new Set(rows.map(r => Number(r.price)));
    const notes = [];
    if (cats.size > 1) notes.push(`categorias distintas (${[...cats].join(', ')})`);
    if (prices.size > 1) notes.push(`precios distintos (${[...prices].join(' / ')})`);
    similar.push({ base, rows, notes });
    rows.forEach(r => usedSimilar.add(r.id));
  }

  // --- D: mismo prefijo (2 primeras palabras) + mismo precio + misma categoria
  const rest = singles.filter(p => !usedSimilar.has(p.id));
  const byPrefix = new Map();
  for (const p of rest) {
    const toks = baseName(p.name).split(' ').filter(Boolean);
    if (toks.length < 2) continue;
    const k = `${toks[0]} ${toks[1]}|${p.category}|${Number(p.price)}`;
    if (!byPrefix.has(k)) byPrefix.set(k, []);
    byPrefix.get(k).push(p);
  }
  const prefixGroups = [];
  for (const [k, rows] of byPrefix) {
    if (rows.length < 2) continue;
    const [prefix, , price] = k.split('|');
    // El precio va en la etiqueta del grupo: el mismo prefijo ("FISHER
    // PRICE") puede formar varios grupos, uno por precio.
    prefixGroups.push({ prefix: `${prefix} · $${price}`, rows });
  }
  prefixGroups.sort((a, b) => a.prefix.localeCompare(b.prefix));

  // --- E/F: filas con varias tallas / colores en un solo campo ---------------
  const multiTalla = products.filter(p => isMulti(p.talla));
  const multiColor = products.filter(p => isMulti(p.color));
  const multiRow = (p, field) => {
    const values = splitValues(p[field]);
    const counted = countValues(values);
    const suggested = field === 'talla' ? propagateUnit(values) : values;
    const derivable = values.length === p.stock && p.stock > 0;
    const singleValue = counted.length === 1; // "6, 6" / "XL,XL": un solo valor repetido
    return {
      p,
      values,
      distinct: counted.length,
      counted,
      suggested: countValues(suggested),
      derivable,
      singleValue,
      estado: singleValue
        ? 'UN SOLO VALOR (no dividir, solo limpiar el campo)'
        : derivable
          ? 'STOCK DERIVABLE (1 valor por unidad)'
          : p.stock === 0 ? 'SIN STOCK' : 'REQUIERE CONTEO FISICO',
    };
  };
  const eRows = multiTalla.map(p => multiRow(p, 'talla'));
  const fRows = multiColor.map(p => multiRow(p, 'color'));
  const bothIds = new Set(multiTalla.filter(p => isMulti(p.color)).map(p => p.id));

  const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
  console.log(`\nA. Nombre exacto (agrupar):        ${exactVariants.length} grupos, ${sum(exactVariants, g => g.rows.length)} filas (${exactVariants.filter(g => g.estado === 'LISTO PARA VINCULAR').length} listos)`);
  console.log(`B. Duplicados exactos:             ${exactDuplicates.length} grupos, ${sum(exactDuplicates, g => g.rows.length)} filas`);
  console.log(`C. Nombre similar:                 ${similar.length} grupos, ${sum(similar, g => g.rows.length)} filas`);
  console.log(`D. Mismo prefijo + precio:         ${prefixGroups.length} grupos, ${sum(prefixGroups, g => g.rows.length)} filas`);
  console.log(`E. Varias tallas en 1 fila:        ${eRows.length} filas, ${sum(eRows, r => r.p.stock)} unidades (${eRows.filter(r => r.derivable && !r.singleValue).length} con stock derivable, ${eRows.filter(r => r.singleValue).length} con un solo valor repetido)`);
  console.log(`F. Varios colores en 1 fila:       ${fRows.length} filas, ${sum(fRows, r => r.p.stock)} unidades (${fRows.filter(r => r.derivable && !r.singleValue).length} con stock derivable, ${fRows.filter(r => r.singleValue).length} con un solo valor repetido)`);
  console.log(`   (filas con AMBOS campos multiples: ${bothIds.size})`);

  // --- Excel -----------------------------------------------------------------
  const wb = new ExcelJS.Workbook();
  const headerStyle = row => {
    row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    row.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } }; });
  };

  const ws = wb.addWorksheet('Resumen');
  ws.columns = [{ width: 62 }, { width: 22 }];
  ws.addRows([
    ['Generado', new Date().toISOString()],
    ['Tienda', store.name],
    ['Productos activos SIN vincular a un producto padre', products.length],
    ['Unidades en stock (tienda Juguetes) en esos productos', totalUnits],
    ['', ''],
    ['A. Nombre exacto, distinta talla/color (se vinculan tal cual)', exactVariants.length],
    ['   -> filas en esos grupos', sum(exactVariants, g => g.rows.length)],
    ['   -> grupos LISTOS (misma categoria y precio)', exactVariants.filter(g => g.estado === 'LISTO PARA VINCULAR').length],
    ['B. Duplicados exactos (mismo nombre+talla+color; NO son variantes)', exactDuplicates.length],
    ['   -> filas sobrantes a revisar', sum(exactDuplicates, g => g.rows.length - 1)],
    ['C. Nombre similar (tamano/medida/color escrito en el nombre)', similar.length],
    ['   -> filas en esos grupos', sum(similar, g => g.rows.length)],
    ['D. Mismo prefijo + mismo precio (linea/personaje; decision de negocio)', prefixGroups.length],
    ['   -> filas en esos grupos', sum(prefixGroups, g => g.rows.length)],
    ['E. Filas con VARIAS TALLAS en un solo campo (hay que dividir)', eRows.length],
    ['   -> unidades en stock dentro de esas filas', sum(eRows, r => r.p.stock)],
    ['   -> filas donde el stock por talla se deduce solo (1 valor por unidad)', eRows.filter(r => r.derivable && !r.singleValue).length],
    ['   -> filas con un solo valor repetido ("6, 6"): no dividir, solo limpiar', eRows.filter(r => r.singleValue).length],
    ['F. Filas con VARIOS COLORES en un solo campo (hay que dividir)', fRows.length],
    ['   -> unidades en stock dentro de esas filas', sum(fRows, r => r.p.stock)],
    ['   -> filas donde el stock por color se deduce solo', fRows.filter(r => r.derivable && !r.singleValue).length],
    ['   -> filas con un solo valor repetido: no dividir, solo limpiar', fRows.filter(r => r.singleValue).length],
    ['   (filas que estan en E y en F a la vez)', bothIds.size],
    ['', ''],
    ['IMPORTANTE', 'Solo DETECCION. No se aplico ni cambio nada en la base de datos.'],
  ]);
  headerStyle(ws.getRow(1));

  const productCols = [
    { header: 'SKU', key: 'sku', width: 14 },
    { header: 'Nombre original', key: 'nombre', width: 40 },
    { header: 'Categoria', key: 'categoria', width: 16 },
    { header: 'Talla', key: 'talla', width: 16 },
    { header: 'Color', key: 'color', width: 20 },
    { header: 'Precio', key: 'precio', width: 9 },
    { header: 'Stock', key: 'stock', width: 7 },
    { header: 'Etiqueta impresa', key: 'etiqueta', width: 14 },
    { header: 'Creado', key: 'creado', width: 11 },
    { header: 'ID', key: 'id', width: 38 },
  ];
  const productCells = p => ({
    sku: p.sku_barcode,
    nombre: p.name,
    categoria: p.category,
    talla: p.talla || '',
    color: p.color || '',
    precio: Number(p.price),
    stock: p.stock,
    etiqueta: p.label_printed_at ? p.label_printed_at.slice(0, 10) : '',
    creado: p.created_at ? p.created_at.slice(0, 10) : '',
    id: p.id,
  });

  function addGroupSheet(title, groups, { labelHeader, labelOf, extraCols = [], extraOf = () => ({}) }) {
    const s = wb.addWorksheet(title);
    s.columns = [
      { header: labelHeader, key: 'grupo', width: 34 },
      ...extraCols,
      { header: '# filas', key: 'filas', width: 7 },
      ...productCols,
    ];
    headerStyle(s.getRow(1));
    groups.slice().sort((a, b) => b.rows.length - a.rows.length).forEach(g => {
      g.rows.forEach(r => s.addRow({ grupo: labelOf(g), ...extraOf(g, r), filas: g.rows.length, ...productCells(r) }));
    });
    return s;
  }

  addGroupSheet('A. Nombre exacto (agrupar)', exactVariants, {
    labelHeader: 'Grupo (nombre)',
    labelOf: g => g.name,
    extraCols: [
      { header: 'Variacion', key: 'variacion', width: 13 },
      { header: 'Estado', key: 'estado', width: 22 },
      { header: 'Observacion', key: 'obs', width: 44 },
    ],
    extraOf: g => ({ variacion: g.variacion, estado: g.estado, obs: g.notes.join('; ') }),
  });
  addGroupSheet('B. Duplicados exactos', exactDuplicates, {
    labelHeader: 'Grupo (nombre)',
    labelOf: g => g.name,
    extraCols: [{ header: 'Observacion', key: 'obs', width: 44 }],
    extraOf: g => ({ obs: g.notes.join('; ') }),
  });
  addGroupSheet('C. Nombre similar', similar, {
    labelHeader: 'Grupo (nombre base)',
    labelOf: g => g.base,
    extraCols: [
      { header: 'Variante detectada', key: 'det', width: 18 },
      { header: 'Observacion', key: 'obs', width: 44 },
    ],
    extraOf: (g, r) => ({ det: strippedPart(r.name) || '(base)', obs: g.notes.join('; ') }),
  });
  addGroupSheet('D. Mismo prefijo + precio', prefixGroups, {
    labelHeader: 'Prefijo (2 palabras)',
    labelOf: g => g.prefix,
  });

  function addMultiSheet(title, rows, field) {
    const s = wb.addWorksheet(title);
    s.columns = [
      { header: 'Estado', key: 'estado', width: 30 },
      { header: `${field === 'talla' ? 'Tallas' : 'Colores'} distintos`, key: 'distintos', width: 9 },
      { header: 'Valores en el campo', key: 'valores', width: 10 },
      { header: 'Desglose sugerido (valor x cantidad)', key: 'desglose', width: 46 },
      ...productCols,
    ];
    headerStyle(s.getRow(1));
    rows.slice().sort((a, b) => b.p.stock - a.p.stock).forEach(r => {
      s.addRow({
        estado: r.estado,
        distintos: r.distinct,
        valores: r.values.length,
        desglose: r.suggested.map(([v, n]) => (r.derivable ? `${v} x${n}` : v)).join(' | '),
        ...productCells(r.p),
      });
    });
  }
  addMultiSheet('E. Varias tallas en 1 fila', eRows, 'talla');
  addMultiSheet('F. Varios colores en 1 fila', fRows, 'color');

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  await wb.xlsx.writeFile(OUT_PATH);
  console.log(`\nArchivo generado: ${OUT_PATH}`);
  console.log('Nada fue modificado en la base de datos (esto es solo deteccion).');
}

main().catch((err) => { console.error('\nFALLO:', err.message); process.exitCode = 1; });
