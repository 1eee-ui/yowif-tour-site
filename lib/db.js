// Data storage with two modes:
//
//  - DATABASE_URL is set (hosting): a real PostgreSQL database (e.g. Supabase).
//    Data survives restarts and redeploys.
//  - DATABASE_URL is not set (developer's computer): plain JSON files in data/.
//    No database to install, and the developer never needs the production
//    database password.
//
// Both modes have the same functions, so server.js does not care which one runs.
// All functions are async (they return a Promise), because a real database
// answers over the network.

const fs = require('fs');
const path = require('path');

// Only these tables and columns can be written. Column names are never taken
// from user input, only from this list — that is what keeps the SQL safe.
const SCHEMA = {
  messages: ['name', 'email', 'topic', 'message'],
  subscribers: ['email'],
  orders: ['code', 'date', 'city', 'venue', 'qty', 'price', 'total', 'name', 'email'],
};

const CREATE_TABLES = `
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  name TEXT NOT NULL, email TEXT NOT NULL, topic TEXT NOT NULL, message TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subscribers (
  id SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  email TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  code TEXT NOT NULL UNIQUE, date TEXT NOT NULL, city TEXT NOT NULL, venue TEXT NOT NULL,
  qty INTEGER NOT NULL, price INTEGER NOT NULL, total INTEGER NOT NULL,
  name TEXT NOT NULL, email TEXT NOT NULL
);`;

function checkTable(name) {
  if (!SCHEMA[name]) throw new Error('Unknown table: ' + name);
}

// ---------- PostgreSQL ----------

function postgresStore(client) {
  // Dates come back from Postgres as Date objects; the admin page expects text.
  const clean = row => row && Object.assign({}, row, { created_at: new Date(row.created_at).toISOString() });

  return {
    kind: 'postgres',
    async init() {
      await client.query(CREATE_TABLES);
    },
    async insert(name, row) {
      checkTable(name);
      const cols = SCHEMA[name];
      const placeholders = cols.map((_, i) => '$' + (i + 1));
      const { rows } = await client.query(
        `INSERT INTO ${name} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
        cols.map(c => row[c])
      );
      return clean(rows[0]);
    },
    async all(name) {
      checkTable(name);
      const { rows } = await client.query(`SELECT * FROM ${name} ORDER BY id DESC`);
      return rows.map(clean);
    },
    async remove(name, id) {
      checkTable(name);
      await client.query(`DELETE FROM ${name} WHERE id = $1`, [Number(id)]);
    },
    async findOne(name, field, value) {
      checkTable(name);
      if (!SCHEMA[name].includes(field)) throw new Error('Unknown column: ' + field);
      const { rows } = await client.query(`SELECT * FROM ${name} WHERE ${field} = $1 LIMIT 1`, [value]);
      return clean(rows[0]);
    },
  };
}

// ---------- JSON files ----------

function jsonStore(dataDir) {
  const filePath = name => path.join(dataDir, name + '.json');

  function readAll(name) {
    const p = filePath(name);
    if (!fs.existsSync(p)) return [];
    try {
      const raw = fs.readFileSync(p, 'utf8');
      return raw.trim() ? JSON.parse(raw) : [];
    } catch (e) {
      console.error('Could not read ' + p + ':', e.message);
      return [];
    }
  }

  function writeAll(name, rows) {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(filePath(name), JSON.stringify(rows, null, 2), 'utf8');
  }

  return {
    kind: 'json',
    async init() {},
    async insert(name, row) {
      checkTable(name);
      const rows = readAll(name);
      const id = rows.reduce((max, r) => Math.max(max, r.id || 0), 0) + 1;
      const record = { id, created_at: new Date().toISOString() };
      for (const c of SCHEMA[name]) record[c] = row[c];
      rows.push(record);
      writeAll(name, rows);
      return record;
    },
    async all(name) {
      checkTable(name);
      return readAll(name).sort((a, b) => b.id - a.id);
    },
    async remove(name, id) {
      checkTable(name);
      writeAll(name, readAll(name).filter(r => String(r.id) !== String(id)));
    },
    async findOne(name, field, value) {
      checkTable(name);
      return readAll(name).find(r => r[field] === value);
    },
  };
}

// ---------- pick one ----------

function createStore() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Hosted databases (Supabase etc.) require an encrypted connection.
      ssl: { rejectUnauthorized: false },
      max: 5,
    });
    return postgresStore(pool);
  }
  return jsonStore(path.join(__dirname, '..', 'data'));
}

module.exports = { createStore, postgresStore, jsonStore };
