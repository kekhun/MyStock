import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "data");

export const DATA_FILES = {
  holdings: "holdings.json",
  categories: "categories.json",
  prices: "prices.json",
  snapshots: "snapshots.json",
  settings: "settings.json",
};

const usePostgres = Boolean(process.env.DATABASE_URL);
let poolPromise = null;

async function readLocalJson(name) {
  const file = path.join(DATA_DIR, DATA_FILES[name]);
  const raw = await fs.readFile(file, "utf8");
  return JSON.parse(raw);
}

async function writeLocalJson(name, value) {
  const file = path.join(DATA_DIR, DATA_FILES[name]);
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function postgresSslConfig() {
  const url = process.env.DATABASE_URL || "";
  if (process.env.PGSSLMODE === "disable") return undefined;
  if (process.env.PGSSLMODE === "require" || url.includes("sslmode=require")) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

async function getPool() {
  if (!poolPromise) {
    poolPromise = import("pg").then(async ({ Pool }) => {
      const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: postgresSslConfig(),
      });
      await pool.query(`
        CREATE TABLE IF NOT EXISTS mystock_documents (
          name text PRIMARY KEY,
          value jsonb NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await seedPostgres(pool);
      return pool;
    });
  }
  return poolPromise;
}

async function seedPostgres(pool) {
  for (const name of Object.keys(DATA_FILES)) {
    const existing = await pool.query("SELECT 1 FROM mystock_documents WHERE name = $1", [name]);
    if (existing.rowCount) continue;
    const value = await readLocalJson(name);
    await pool.query(
      `INSERT INTO mystock_documents (name, value, updated_at)
       VALUES ($1, $2::jsonb, now())`,
      [name, JSON.stringify(value)]
    );
  }
}

export function storageMode() {
  return usePostgres ? "postgres" : "json";
}

export async function readJson(name) {
  if (!DATA_FILES[name]) throw new Error(`Unknown data document: ${name}`);
  if (!usePostgres) return readLocalJson(name);
  const pool = await getPool();
  const result = await pool.query("SELECT value FROM mystock_documents WHERE name = $1", [name]);
  if (!result.rowCount) throw new Error(`Missing data document: ${name}`);
  return result.rows[0].value;
}

export async function writeJson(name, value) {
  if (!DATA_FILES[name]) throw new Error(`Unknown data document: ${name}`);
  if (!usePostgres) return writeLocalJson(name, value);
  const pool = await getPool();
  await pool.query(
    `INSERT INTO mystock_documents (name, value, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (name)
     DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [name, JSON.stringify(value)]
  );
}
