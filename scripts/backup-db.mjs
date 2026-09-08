#!/usr/bin/env node
/**
 * Backup de la base de datos (Supabase) via API REST.
 *
 *   node scripts/backup-db.mjs [carpeta-destino]
 *
 * Vuelca todas las tablas expuestas en el esquema public a JSON + CSV,
 * paginando de a 1000 filas (limite duro de Supabase) para no truncar en silencio.
 * Incluye tambien el listado de usuarios de auth y el esquema de columnas.
 *
 * OJO: esto respalda DATOS, no el esquema completo (funciones, triggers, RLS).
 * El esquema vive en db/*.sql y en el panel de Supabase.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PAGE = 1000;

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

async function getSchema() {
  const res = await fetch(`${URL_BASE}/rest/v1/`, { headers });
  if (!res.ok) throw new Error(`OpenAPI ${res.status}: ${await res.text()}`);
  const spec = await res.json();
  return spec.definitions ?? spec.components?.schemas ?? {};
}

/** Columnas de orden estables: PK si PostgREST la marca, si no la primera columna. */
function orderColumns(def) {
  const props = Object.entries(def.properties ?? {});
  const pk = props.filter(([, p]) => /<pk\/>|Primary Key/i.test(p.description ?? '')).map(([c]) => c);
  return pk.length ? pk : props.slice(0, 1).map(([c]) => c);
}

async function dumpTable(table, def) {
  const order = orderColumns(def).map((c) => `${c}.asc`).join(',');
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const qs = new URLSearchParams({ select: '*', limit: String(PAGE), offset: String(offset) });
    if (order) qs.set('order', order);
    const res = await fetch(`${URL_BASE}/rest/v1/${table}?${qs}`, { headers });
    if (!res.ok) throw new Error(`${table} ${res.status}: ${await res.text()}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

async function dumpAuthUsers() {
  const users = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`${URL_BASE}/auth/v1/admin/users?page=${page}&per_page=200`, { headers });
    if (!res.ok) return { error: `${res.status}: ${await res.text()}` };
    const body = await res.json();
    const batch = body.users ?? [];
    users.push(...batch);
    if (batch.length < 200) break;
  }
  return users;
}

const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function toCsv(rows, def) {
  const cols = rows.length
    ? [...new Set(rows.flatMap((r) => Object.keys(r)))]
    : Object.keys(def.properties ?? {});
  return [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n');
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.resolve(process.argv[2] ?? path.join(ROOT, 'backups', stamp));
  fs.mkdirSync(path.join(outDir, 'csv'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'json'), { recursive: true });

  const schema = await getSchema();
  const tables = Object.keys(schema).sort();
  console.log(`Base: ${URL_BASE}`);
  console.log(`Destino: ${outDir}`);
  console.log(`Tablas: ${tables.length}\n`);

  const manifest = { generado: new Date().toISOString(), url: URL_BASE, tablas: {} };
  for (const table of tables) {
    process.stdout.write(`  ${table} ... `);
    const rows = await dumpTable(table, schema[table]);
    fs.writeFileSync(path.join(outDir, 'json', `${table}.json`), JSON.stringify(rows, null, 2), 'utf8');
    fs.writeFileSync(path.join(outDir, 'csv', `${table}.csv`), toCsv(rows, schema[table]), 'utf8');
    manifest.tablas[table] = rows.length;
    console.log(`${rows.length} filas`);
  }

  process.stdout.write('  auth.users ... ');
  const users = await dumpAuthUsers();
  fs.writeFileSync(path.join(outDir, 'json', '_auth_users.json'), JSON.stringify(users, null, 2), 'utf8');
  manifest.auth_users = Array.isArray(users) ? users.length : users;
  console.log(Array.isArray(users) ? `${users.length} usuarios` : `error (${users.error})`);

  fs.writeFileSync(path.join(outDir, 'json', '_schema.json'), JSON.stringify(schema, null, 2), 'utf8');
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  console.log('\nListo.');
}

main().catch((err) => { console.error('\nFALLO:', err.message); process.exit(1); });
